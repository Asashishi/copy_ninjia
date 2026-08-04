import type { Message } from "@grammyjs/types";
import type { CachedUser } from "../types/chatState";
import type { CommandTargetMessages } from "../types/commands";
import { sendCommandMessage } from "../infra/telegram";
import { resolveIdTarget, resolveReplyTarget, resolveUsernameTarget } from "../users/senderIdentity";
import { sanitizeDisplayName, truncateInline } from "../libs/text";
import {
  CHAT_ID_ARG_PATTERN,
  INVALID_USERNAME_ECHO_MAX_CHARS,
  USERNAME_ARG_PATTERN,
  USER_ID_ARG_PATTERN,
} from "../consts/commands";

/** 参数那一路的解析结果；三态各自对应一句不同的提示。 */
type ArgumentTarget =
  | { readonly kind: "resolved"; readonly user: CachedUser }
  /** 形态就不对：既不是合法 @username，也不是（按开关放行的）id。 */
  | { readonly kind: "malformed" }
  /** 是合法 @username，但缓存里没有这个人。 */
  | { readonly kind: "unknownUsername"; readonly username: string };

interface ResolveArgumentTargetParams {
  trimmedArgument: string;
  acceptUserId: boolean;
  acceptChatId: boolean;
}

/**
 * resolveCommandTarget 的入参。这里只收命令消息本身与几个标量，不收 grammY 的
 * CommandContext：`/咬` 这类中文动作命令拿不到 bot_command 实体、走的是
 * bot.hears，根本没有 CommandContext 可传（见 commands/cjkAction.ts）。
 */
export interface ResolveCommandTargetParams {
  /** 命令所在会话 id，失败提示发到这里。 */
  chatId: number;
  /** 命令消息本身：既用于解析回复目标，也用于把提示回复到它下面。 */
  message: Message;
  /** 机器人自己的用户 id，用于拒绝把自己当目标。 */
  botUserId: number;
  /** 命令词之后的参数原文，未 trim 也可以。 */
  rawArgument: string;
  /** 解析失败时发送的提示文案。 */
  messages: CommandTargetMessages;
  /**
   * 是否接受裸用户 id 作为目标（缺省不接受）。
   *
   * 逐命令 opt-in，不做成全局行为：`/block`、`/unblock`、`/permission` 与
   * `/white` 操作的权威目标都是 id，用 id 指定反而比 @username 更准——用户名
   * 可以被释放后由别人重新注册，而 id 不会改指另一个人。`/copy` 与中文动作命令
   * 则相反，它们要的是一份有名字、有头像的身份，拿一个没在本天才见过的群里
   * 说过话的裸 id 只能复读出一具空壳。
   */
  acceptUserId?: boolean;
  /**
   * 是否接受裸会话 id（频道/群的负数 id）作为目标（缺省不接受）。
   *
   * `/unblock`、`/permission` 与 `/white` 开这条路：前者需要保证黑名单里的频道
   * 身份始终能被划掉，后两者需要直接管理频道白名单及权限。`/block` 不开这条：
   * 粘错一个会话 id 会把处置改成封掉整个会话身份，而那条命令不可逆；其余三条
   * 都是可恢复的配置操作。详见 consts/commands.ts 的 CHAT_ID_ARG_PATTERN。
   */
  acceptChatId?: boolean;
}

/**
 * 把参数解析成 Telegram 用户 id；不是合法 id 时返回 undefined 交给用户名那条路。
 *
 * 正则之外还要过一次安全整数：`99999999999999999999` 完全匹配「十进制正整数」，
 * 而 `Number` 之后已经不是那个数了，拿它去封人封的是另一个 id。
 */
function parseUserIdArgument(argument: string): number | undefined {
  if (!USER_ID_ARG_PATTERN.test(argument)) return undefined;
  const userId: number = Number(argument);
  return Number.isSafeInteger(userId) ? userId : undefined;
}

/**
 * 把参数解析成 Telegram 会话 id（频道/群的负数 id）；不合法时返回 undefined。
 * 安全整数那道闸的理由同 parseUserIdArgument，只是方向朝负。
 *
 * 导出给 commands/send.ts 复用：裸 `Number()` 会放过 `-100123456789.0`、`0x2d`
 * 这类非规范写法，而那条命令拿解析结果去开持久代发会话。
 */
export function parseChatIdArgument(argument: string): number | undefined {
  if (!CHAT_ID_ARG_PATTERN.test(argument)) return undefined;
  const chatId: number = Number(argument);
  return Number.isSafeInteger(chatId) ? chatId : undefined;
}

/**
 * 把参数原文解析成目标。不发送任何提示、不看回复目标：调用方要先拿这个结果与
 * 回复目标比对，才判断得出「两个目标撞了」。
 */
function resolveArgumentTarget({
  trimmedArgument,
  acceptUserId,
  acceptChatId,
}: ResolveArgumentTargetParams): ArgumentTarget {
  // 裸 id 先认：它与用户名的形态互斥（用户名必须字母开头），谁先试都一样，
  // 但 id 这条路命中即成立——不查缓存，也就不存在「这个人还没说过话」。
  // 正负两条路各自按开关放行，形态同样互斥（只有会话 id 带负号）。
  const targetId: number | undefined = (acceptUserId ? parseUserIdArgument(trimmedArgument) : undefined) ??
    (acceptChatId ? parseChatIdArgument(trimmedArgument) : undefined);
  if (targetId !== undefined) return { kind: "resolved", user: resolveIdTarget(targetId) };
  const usernameMatch: RegExpExecArray | null = USERNAME_ARG_PATTERN.exec(trimmedArgument);
  if (usernameMatch === null) return { kind: "malformed" };
  const username: string = usernameMatch[1]!;
  const user: CachedUser | undefined = resolveUsernameTarget(username);
  return user === undefined ? { kind: "unknownUsername", username } : { kind: "resolved", user };
}

/**
 * 把用户完全可控的参数原文压成能安全插进提示语的一段。
 *
 * 先压成单行再收长度：参数原文可以长到近 4096 字符，原样插回提示语就会拼出一条
 * 超过 Telegram 单条上限的消息，发不出去，用户只收到沉默（理由见 consts/commands.ts
 * 的 INVALID_USERNAME_ECHO_MAX_CHARS）。用 sanitizeDisplayName 而不是 sanitizeInline：
 * 这段要被拼进机器人自己写的句子中间，和昵称是同一处境——一个 RLO 就能让整句的
 * 其余部分反向渲染（理由见 libs/text.ts 的 sanitizeDisplayName）。
 */
function echoArgument(trimmedArgument: string): string {
  return truncateInline(sanitizeDisplayName(trimmedArgument), INVALID_USERNAME_ECHO_MAX_CHARS);
}

/**
 * 只读地看一眼命令目标：回复目标优先，其次查缓存里的 @username。**不发送任何
 * 提示消息**，解析不出来就是 undefined。
 *
 * 用在「这条命令注定要被拒绝、只是想知道目标是谁来挑一句文案」的分支上。那种
 * 地方不能调 resolveCommandTarget：它会为解析失败自己发一条「@x 都还没说过话
 * 呢」然后返回 undefined，用户收到的是一句答非所问的拒绝，真正的原因反而
 * 永远没说出口。
 */
export function peekCommandTarget(message: Message, rawArgument: string): CachedUser | undefined {
  const replyTarget: CachedUser | undefined = resolveReplyTarget(message);
  if (replyTarget) return replyTarget;
  const usernameMatch: RegExpExecArray | null = USERNAME_ARG_PATTERN.exec(rawArgument.trim());
  if (!usernameMatch) return undefined;
  return resolveUsernameTarget(usernameMatch[1]!);
}

/**
 * 解析命令的目标用户/频道：只给了回复目标时用它——这样即使对方没有公开
 * username、或者本天才还没缓存过 TA（比如 privacy mode 没关导致漏听），只要能
 * 回复到 TA 发的一条消息就能直接锁定目标。/copy 系、/block 与中文动作命令共用
 * 同一套解析流程，只是失败时的嘲讽文案不同。
 *
 * **回复目标与参数同时给出、又指向不同的人时报错，绝不静默取一。** 这类命令最
 * 自然的用法恰恰会撞上它：管理员看到群里有人贴出「请封 123456789」，对着那条
 * 消息点回复再发 `/block 123456789`。静默优先取回复目标的话，被永久拉黑并在每个
 * 托管群带 `revoke_messages` 封禁的是贴出这串 id 的同事，而回执里显示的正是那位
 * 同事的名字，读起来像一次成功确认——「对着别人贴出的 id 动手」本来就是 id 那条
 * 路被引入的场景（见 acceptUserId）。参数解析不出目标时同样按冲突报错，不再说
 * 「这不是合法用户名」：那句话会让人以为参数被忽略掉、回复目标生效了。
 * @returns 解析出的目标；失败时为 undefined（提示已发送，调用方应直接返回）。
 */
export async function resolveCommandTarget({
  chatId,
  message,
  botUserId,
  rawArgument,
  messages,
  acceptUserId = false,
  acceptChatId = false,
}: ResolveCommandTargetParams): Promise<CachedUser | undefined> {
  const messageId: number = message.message_id;
  const replyTarget: CachedUser | undefined = resolveReplyTarget(message);
  const trimmedArgument: string = rawArgument.trim();
  // 回显收在这一层而不是各命令的文案里：所有目标型命令共用同一份 rawArgument。
  const argument: ArgumentTarget | undefined = trimmedArgument.length === 0
    ? undefined
    : resolveArgumentTarget({ trimmedArgument, acceptUserId, acceptChatId });

  let targetUser: CachedUser;
  if (replyTarget !== undefined) {
    // 参数与回复指向同一个人是无害的重复（回复某人、又把他的 id 打了一遍），
    // 照常放行；其余情形一律报冲突，理由见函数头注。
    if (argument !== undefined && (argument.kind !== "resolved" || argument.user.id !== replyTarget.id)) {
      await sendCommandMessage({
        chatId,
        text: messages.conflictingTarget(echoArgument(trimmedArgument)),
        replyToMessageId: messageId,
      });
      return undefined;
    }
    targetUser = replyTarget;
  } else if (argument === undefined) {
    await sendCommandMessage({ chatId, text: messages.missingTarget, replyToMessageId: messageId });
    return undefined;
  } else if (argument.kind === "malformed") {
    await sendCommandMessage({
      chatId,
      text: messages.invalidUsername(echoArgument(trimmedArgument)),
      replyToMessageId: messageId,
    });
    return undefined;
  } else if (argument.kind === "unknownUsername") {
    await sendCommandMessage({ chatId, text: messages.unknownUsername(argument.username), replyToMessageId: messageId });
    return undefined;
  } else {
    targetUser = argument.user;
  }

  // 不能把本天才自己设成目标：/copy 会自己套自己没完没了，/block 更是无稽之谈。
  if (targetUser.id === botUserId) {
    await sendCommandMessage({ chatId, text: messages.selfTarget, replyToMessageId: messageId });
    return undefined;
  }

  // 不在共享解析层拒绝 targetUser.id === chatId：匿名管理员以当前群为
  // sender_chat 时，/copy 必须保留该身份来复制群头像并复读同一皮套的消息。
  // Telegram 不会提供皮套背后的真实用户；/block 等破坏性命令应在调用处
  // 按自己的语义拒绝，避免误把整个群组身份当作那名管理员。
  return targetUser;
}
