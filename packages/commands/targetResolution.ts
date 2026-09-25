import { chatAtmosphere } from "../infra/atmosphere";
import type { Message } from "grammy/types";
import type { CachedUser } from "../types/chatState";
import type { CommandTargetMessages } from "../types/commands";
import { sendCommandMessage } from "../infra/telegram";
import { resolveIdTarget, resolveReplyTarget, resolveUsernameTarget } from "../users/senderIdentity";
import { sanitizeDisplayName, truncateInline } from "../libs/text";
import { INVALID_USERNAME_ECHO_MAX_CHARS, USERNAME_ARG_PATTERN } from "../consts/commands";
import { parseChatIdArgument, parseUserIdArgument } from "../libs/telegramId";

import { prefetchIdentityPolicies } from "../infra/identityStorage";

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
   * 调用方按命令开启；支持未命中身份缓存的 id，展示字段由 resolveIdTarget 提供。
   * 管理命令与只读的 `/info` 可开启，`/copy` 和中文动作命令保持缺省。
   */
  acceptUserId?: boolean;
  /**
   * 是否接受裸会话 id（频道/群的负数 id）作为目标（缺省不接受）。
   *
   * `/gag`、`/ungag`、`/block disable`、`/permission`、`/white` 与 `/info` 开启。
   * `/block enable` 保持缺省，频道目标须由回复或用户名解析。
   * 形态校验见 consts/commands.ts 的 CHAT_ID_ARG_PATTERN；当前群身份的处置约束
   * 见 docs/cn/04-invariants.md。
   */
  acceptChatId?: boolean;
  /**
   * 目标的黑白名单预热失败时是否拒绝执行（缺省不拒绝）。
   *
   * 预热失败时主线程 LRU 仍是冷的，isWhitelisted、isUserBlocked 等同步判定按
   * fail-closed 读成「不在名单」，名单写入也要求先预热（见
   * infra/identityStorage/read.ts 的 prefetchIdentityPolicies）。依赖这些判定做保护或
   * 破坏性决策的命令（`/block … enable`、`/block … disable`、`/mute`、`/white`、`/permission` 修改
   * 路径）必须开启：此时发送 IDENTITY_POLICY_UNAVAILABLE_TEXT 并返回 undefined。
   * 不读名单做决策的命令保持缺省，预热结果不影响目标解析。
   */
  requireIdentityPolicies?: boolean;
  /**
   * 是否允许把机器人自己当目标（缺省不允许）。只读的查询命令（`/info`）打开；会改动目标
   * 状态的命令一律保持缺省，避免拿机器人自己开刀。
   */
  allowSelfTarget?: boolean;
  /**
   * 目标落在「当前群自己的 identity」上时的拒绝文案（缺省不拒绝）。
   *
   * 匿名管理员以当前群为 sender_chat 发言时，Telegram 只提供 sender_chat=本群、
   * 不暴露皮套底下的真实用户，解析结果因此就是这个群自己的频道 identity；开了
   * acceptChatId 的命令还能由用户把本群 id 直接粘进参数，落点完全相同。`/copy`
   * 一类要保留该身份（复制群头像、复读同一皮套），所以缺省放行；`/block`、
   * `/block disable`、`/white`、`/permission` 这些会据此做破坏性处置或发权限的
   * 命令传入各自文案，命中时发送它并返回 undefined。
   * 这道闸排在身份名单预热之后，与 requireIdentityPolicies 的顺序不变。
   */
  currentChatTargetText?: string;
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
 * 超过 Telegram 单条上限的消息，发不出去，用户只收到沉默（见 consts/commands.ts
 * 的 INVALID_USERNAME_ECHO_MAX_CHARS）。用 sanitizeDisplayName 而不是 sanitizeInline：
 * 这段要被拼进机器人自己写的句子中间，和昵称是同一处境——一个 RLO 就能让整句的
 * 其余部分反向渲染，一个 `/batch_kick 1d` 参数则让机器人自己印出可点击命令
 * （两条都见 libs/text.ts 的 sanitizeDisplayName，中和已在那一层做掉）。
 *
 * **不要在这里或 sendCommandMessage 上加整条 containsRenderableCommand 守卫**：
 * 命令回执是机器人自己写的句子，`/unquiet`、`/batch_kick`、`/x` 这些用法提示本来
 * 就该可点，整条判定会把它们全部换成固定文案。守的是片段，不是整条。
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
 * 解析命令的目标用户/频道：支持回复消息、缓存中的用户名，以及调用方开启的裸 id。
 * 回复目标不要求命中身份缓存；回复与参数同时存在时，参数必须解析为同一个 id，
 * 否则发送目标冲突提示。各命令通过 options 指定准入条件与当前氛围的失败文案。
 *
 * 目标确定后预热它的黑白名单；开启 requireIdentityPolicies 时预热失败按解析失败处理。
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
  requireIdentityPolicies = false,
  allowSelfTarget = false,
  currentChatTargetText,
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
    // 照常放行；其余情形一律报冲突，见函数头注。
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

  // 缺省不能把本天才自己设成目标：/copy 会自己套自己没完没了，/block 更是无稽之谈；只读的 /info 例外。
  if (!allowSelfTarget && targetUser.id === botUserId) {
    await sendCommandMessage({ chatId, text: messages.selfTarget, replyToMessageId: messageId });
    return undefined;
  }

  // 「目标是当前群自己的 identity」缺省放行：/copy 要保留该身份来复制群头像并
  // 复读同一皮套的消息，Telegram 不会提供皮套背后的真实用户。会据此做破坏性
  // 处置或发权限的命令传 currentChatTargetText 打开下面那道闸。
  const prefetched: boolean = await prefetchIdentityPolicies([targetUser.id]);
  if (!prefetched && requireIdentityPolicies) {
    await sendCommandMessage({ chatId, text: chatAtmosphere(chatId).IDENTITY_POLICY_UNAVAILABLE_TEXT, replyToMessageId: messageId });
    return undefined;
  }
  if (currentChatTargetText !== undefined && targetUser.isChannel === true && targetUser.id === chatId) {
    await sendCommandMessage({ chatId, text: currentChatTargetText, replyToMessageId: messageId });
    return undefined;
  }
  return targetUser;
}
