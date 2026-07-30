import { GrammyError, InputFile } from "grammy";
import type { Api, InlineKeyboard } from "grammy";
import type { Message, MessageEntity, ReactionTypeEmoji, ChatMember, MessageId } from "@grammyjs/types";
import { markSelfSent } from "../selfSentTracker";
import { MUTED_CHAT_PERMISSIONS } from "../../consts/telegram";
import { isAdminStatus } from "../../libs/chatMember";
import {
  combineWithUpdateAbortSignal,
  currentUpdateAbortSignal,
  throwIfUpdateAborted,
} from "../updateContext";
import { bot, logApiError } from "./client";
import type { TelegramChatAction, TelegramSendResult } from "../../types/telegram";

interface RunTelegramActionParams<T, R> {
  action: string;
  execute: (signal?: AbortSignal) => Promise<T>;
  map: (result: T) => R;
  fallback: R;
  signal?: AbortSignal;
  /**
   * 第二个参数是 runTelegramAction 已算好的复合信号，直接复用。自己再调一次
   * combineWithUpdateAbortSignal 只为读一次 .aborted，却要新建一个
   * AbortSignal.any 并挂到调用方那个长生命周期 controller 上。
   */
  shouldLogError?: (error: unknown, actionSignal: AbortSignal | undefined) => boolean;
}

/**
 * 把 Telegram 动作失败归一化成调用方约定的业务结果。map 也留在同一个错误
 * 边界内，保持既有语义：成功后的结果转换或本机自发消息登记失败时同样记录
 * 对应动作并返回 fallback。这里不用 grammY 的 bot.catch：它处理的是
 * update/middleware 逃逸异常，且本项目会让该错误触发 update 重投；这些主动
 * API 调用失败属于可预期的业务结果，调用方还需要得到 false/undefined。
 */
async function runTelegramAction<T, R>({
  action,
  execute,
  map,
  fallback,
  signal,
  shouldLogError,
}: RunTelegramActionParams<T, R>): Promise<R> {
  const updateSignal: AbortSignal | undefined = currentUpdateAbortSignal();
  const actionSignal: AbortSignal | undefined = combineWithUpdateAbortSignal(signal);
  throwIfUpdateAborted(updateSignal);
  try {
    const mapped: R = map(await execute(actionSignal));
    // 远端可能在 abort 竞态中已经提交成功；先做 map 中最小的 self-sent
    // 记账，再把 update 取消向上抛出，禁止 handler 继续后续业务写入。
    throwIfUpdateAborted(updateSignal);
    return mapped;
  } catch (error: unknown) {
    if (updateSignal?.aborted === true) {
      throwIfUpdateAborted(updateSignal);
    }
    if (shouldLogError?.(error, actionSignal) !== false) logApiError(action, error);
    return fallback;
  }
}

/**
 * 把一条已发出的消息收敛成 TelegramSendResult：登记进自发消息表（供自动流水线
 * 识别频道自回环，见 infra/selfSentTracker.ts），并带回 Telegram 实际建立的回复
 * 关系。发消息与发图片共用，两者不得各写一份。
 */
function toSendResult(chatId: number, sent: Message): TelegramSendResult {
  markSelfSent(chatId, sent.message_id);
  return {
    messageId: sent.message_id,
    ...(sent.reply_to_message ? { repliedToMessageId: sent.reply_to_message.message_id } : {}),
  };
}

/** 执行只关心是否成功的 Telegram 动作。 */
async function runBooleanTelegramAction(
  action: string,
  execute: (signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal
): Promise<boolean> {
  return runTelegramAction({
    action,
    execute,
    map: (): boolean => true,
    fallback: false,
    signal,
    shouldLogError: (_error: unknown, actionSignal: AbortSignal | undefined): boolean => actionSignal?.aborted !== true,
  });
}

/**
 * 把 AbortSignal 接到 grammY raw API 调用的最后一个位置参数上。
 *
 * grammY 每个方法都把 signal 放在 options 之后的最后一位，而那个位置的声明类型
 * 不是 `AbortSignal`，逐个调用点各写一次
 * `signal as unknown as Parameters<Api["x"]>[n]` 就是十几份**带手写下标**的重复：
 * grammY 签名一变要改十几处，而下标写错会经由 `as unknown` 逃逸通过类型检查、
 * 运行时把 AbortSignal 当 options 对象传进去。收在这里一处，调用点写成
 * `api.sendMessage(chatId, text, other, ...signalArgs(requestSignal))`。
 * @returns 没有信号时是空元组（少传一个参数），有信号时是单元素元组。
 */
function signalArgs(signal: AbortSignal | undefined): readonly [] | readonly [never] {
  return signal === undefined ? [] : [signal as unknown as never];
}

export interface SendMessageParams {
  chatId: number;
  text: string;
  replyToMessageId?: number;
  api?: Api;
  keyboard?: InlineKeyboard;
  signal?: AbortSignal;
  /** 由调用方自行算好偏移的富文本实体，见 sendMessageWithResult 的说明。 */
  entities?: readonly MessageEntity[];
  /**
   * 关闭 Telegram 为正文里第一个 URL 自动生成的预览卡片。挂 text_link 实体
   * 指向 t.me 主页时必须置真：一行动作回复底下跟一整块「Telegram: Contact
   * @xxx」预览卡是噪音，发起人是频道马甲时还会变成「加入频道」邀请卡。
   * 运势 inline 结果同样显式禁用（见 commands/luckChallenge/rendering.ts）。
   */
  disableLinkPreview?: boolean;
}

/** 发送纯文本消息并返回 Telegram 实际建立的回复关系；不设置 parse_mode，
 * 避免用户内容形成格式或链接注入。确实需要链接/格式时，由调用方显式传入
 * entities：偏移按 Telegram 的 UTF-16 code unit 口径逐段算好，昵称等用户内容
 * 只作为纯文本参与拼接，不会被解析成标记。 */
export async function sendMessageWithResult({
  chatId,
  text,
  replyToMessageId,
  api = bot.api,
  keyboard,
  signal,
  entities,
  disableLinkPreview,
}: SendMessageParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send message",
    execute: async (requestSignal?: AbortSignal): Promise<Message.TextMessage> => {
      const other: Parameters<Api["sendMessage"]>[2] = {
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
        ...(keyboard ? { reply_markup: keyboard } : {}),
        ...(entities && entities.length > 0 ? { entities: [...entities] } : {}),
        ...(disableLinkPreview ? { link_preview_options: { is_disabled: true } } : {}),
      };
      return api.sendMessage(chatId, text, other, ...signalArgs(requestSignal));
    },
    map: (sent: Message.TextMessage): TelegramSendResult | undefined => toSendResult(chatId, sent),
    fallback: undefined,
    signal,
    shouldLogError: (_error: unknown, actionSignal: AbortSignal | undefined): boolean => actionSignal?.aborted !== true,
  });
}

/** 发送纯文本消息的兼容入口；只需要 message_id 的调用方继续使用此函数。 */
export async function sendMessage(params: SendMessageParams): Promise<number | undefined> {
  return (await sendMessageWithResult(params))?.messageId;
}

export interface SendChatActionParams {
  chatId: number;
  /** 要显示的状态；取值由 TelegramChatAction 单点定义，见 types/telegram.ts。 */
  action: TelegramChatAction;
  api?: Api;
  signal?: AbortSignal;
}

/**
 * 发一次聊天状态（「正在输入…」这类）。
 *
 * 三个状态共用这一个函数，不各写一份逐字节相同、只差字面量的 wrapper：拆开的
 * 话，新增一个状态要同时改 wrapper、心跳的依赖接口、依赖默认值与分发分支，
 * 而漏掉分发那一处对现有状态照样编译通过（兜底分支会静默返回另一个状态），
 * 新状态于是发出错误的 Telegram chat action。
 */
export async function sendChatAction({
  chatId,
  action,
  api = bot.api,
  signal,
}: SendChatActionParams): Promise<boolean> {
  return runBooleanTelegramAction(
    `send ${action} action`,
    (requestSignal?: AbortSignal): Promise<true> =>
      api.sendChatAction(chatId, action, {}, ...signalArgs(requestSignal)),
    signal
  );
}

export interface AnswerCallbackQueryParams {
  callbackQueryId: string;
  text?: string;
  showAlert?: boolean;
  api?: Api;
}

export async function answerCallbackQuery({
  callbackQueryId,
  text,
  showAlert = false,
  api = bot.api,
}: AnswerCallbackQueryParams): Promise<void> {
  return runTelegramAction({
    action: "answer callback query",
    execute: (signal?: AbortSignal): Promise<true> =>
      api.answerCallbackQuery(callbackQueryId, { text, show_alert: showAlert }, ...signalArgs(signal)),
    map: (): undefined => undefined,
    fallback: undefined,
  });
}

export interface SendStickerParams {
  chatId: number;
  fileId: string;
  api?: Api;
  signal?: AbortSignal;
}

export async function sendSticker({
  chatId,
  fileId,
  api = bot.api,
  signal,
}: SendStickerParams): Promise<number | undefined> {
  return runTelegramAction({
    action: "send sticker",
    execute: (requestSignal?: AbortSignal): Promise<Message.StickerMessage> =>
      api.sendSticker(chatId, fileId, {}, ...signalArgs(requestSignal)),
    map: (sent: Message.StickerMessage): number | undefined => {
      markSelfSent(chatId, sent.message_id);
      return sent.message_id;
    },
    fallback: undefined,
    signal,
    shouldLogError: (_error: unknown, actionSignal: AbortSignal | undefined): boolean => actionSignal?.aborted !== true,
  });
}

export interface SendPhotoParams {
  chatId: number;
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png";
  replyToMessageId?: number;
  api?: Api;
  signal?: AbortSignal;
}

/** 从内存上传一张图片并返回 Telegram 实际建立的回复关系；不落临时文件。 */
export async function sendPhotoWithResult({
  chatId,
  bytes,
  mimeType,
  replyToMessageId,
  api = bot.api,
  signal,
}: SendPhotoParams): Promise<TelegramSendResult | undefined> {
  return runTelegramAction({
    action: "send photo",
    execute: async (requestSignal?: AbortSignal): Promise<Message.PhotoMessage> => {
      const extension: string = mimeType === "image/jpeg" ? "jpg" : "png";
      const other: Parameters<Api["sendPhoto"]>[2] = {
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
      };
      return api.sendPhoto(chatId, new InputFile(bytes, `generated.${extension}`), other, ...signalArgs(requestSignal));
    },
    map: (sent: Message.PhotoMessage): TelegramSendResult | undefined => toSendResult(chatId, sent),
    fallback: undefined,
    signal,
    shouldLogError: (_error: unknown, actionSignal: AbortSignal | undefined): boolean => actionSignal?.aborted !== true,
  });
}

/** 上传图片的兼容入口；只需要 message_id 的调用方继续使用此函数。 */
export async function sendPhoto(params: SendPhotoParams): Promise<number | undefined> {
  return (await sendPhotoWithResult(params))?.messageId;
}

export interface SetMessageReactionParams {
  chatId: number;
  messageId: number;
  emoji: string;
  api?: Api;
  signal?: AbortSignal;
}

/** 设置一个标准 emoji 反应，覆盖机器人在该消息上已有的反应；仅 API 落地成功时返回 true。 */
export async function setMessageReaction({
  chatId,
  messageId,
  emoji,
  api = bot.api,
  signal,
}: SetMessageReactionParams): Promise<boolean> {
  return runBooleanTelegramAction(
    "set message reaction",
    (requestSignal?: AbortSignal): Promise<true> => api.setMessageReaction(
      chatId,
      messageId,
      [{ type: "emoji", emoji: emoji as ReactionTypeEmoji["emoji"] }],
      {},
      ...signalArgs(requestSignal)
    ),
    signal
  );
}

/**
 * 一次删除尝试的结局。`gone` 与 `failed` 必须分开：调用方拿删除结果去写群内
 * 文案或错误日志时，「这条消息已经不在了」和「本机器人删不动它」是两件相反的
 * 事，混成一个布尔就会让「管理员自己先手删了那条消息」变成一句公开的「快看看
 * 本天才有没有删消息的权限」（见 workers/antiRaid/verificationEffects.ts）。
 *
 * `gone` 覆盖两种成因：消息本来就不存在（已被别人删掉），以及超过 48 小时、
 * 机器人再也删不掉的旧消息。两者的共同点是「痕迹不用清也清不了，且与权限无关，
 * 重试一万次都一样」，对文案与日志的意义完全一致，不必再分。
 */
export type DeleteMessageOutcome = "deleted" | "gone" | "forbidden" | "failed";

/** Telegram 是否明确说了「这条消息不存在或不可删」，而不是拒绝权限或偶发失败。 */
function isMessageGone(error: unknown): boolean {
  if (!(error instanceof GrammyError) || error.error_code !== 400) return false;
  return /message to delete not found|message can'?t be deleted/i.test(error.description);
}

/**
 * 删一条消息并带回三态结局；只关心成败的调用方用下面的 deleteMessage。
 *
 * 用得上三态的是那些「删除结果要出现在群内文案或错误日志里」的路径：删不动的
 * 原因究竟是权限还是消息早就没了，决定了那条公告是在指出真问题，还是在冤枉一个
 * 权限配置完全正确的管理员。
 */
export async function deleteMessageWithOutcome(
  chatId: number,
  messageId: number,
  api: Api = bot.api
): Promise<DeleteMessageOutcome> {
  let gone: boolean = false;
  let permissionDenied: boolean = false;
  const deleted: boolean = await runTelegramAction({
    action: "delete message",
    execute: (signal?: AbortSignal): Promise<true> => api.deleteMessage(chatId, messageId, ...signalArgs(signal)),
    map: (): boolean => true,
    fallback: false,
    shouldLogError: (error: unknown): boolean => {
      gone = isMessageGone(error);
      permissionDenied = isPermissionDenied(error);
      // 「消息已经不在了」不是故障：删痕迹这条路上它甚至是常态（管理员比超时
      // 更快手删），逐条记一行只会把日志变成噪音。
      return !gone;
    },
  });
  if (deleted) return "deleted";
  if (gone) return "gone";
  return permissionDenied ? "forbidden" : "failed";
}

export async function deleteMessage(chatId: number, messageId: number, api: Api = bot.api): Promise<boolean> {
  const outcome: DeleteMessageOutcome = await deleteMessageWithOutcome(chatId, messageId, api);
  // 「消息已经不在了」对只看成败的调用方就是成功：它们要的是「这条消息不在群里」
  // 这个结果，而不是「这次调用改变了什么」。
  return outcome === "deleted" || outcome === "gone";
}

/**
 * 一次删掉同一个群里的多条消息。单次上限 100 条，且与 deleteMessage 一样只能删
 * 48 小时内的；超出由调用方分片，删不掉的个别消息 Telegram 自行跳过。
 *
 * 存在的理由是**请求条数**而非速度：调用方与验证超时踢人共用一条限流队列，
 * 逐条删会把一次处置放大成几十个往返顶在踢人前面（见 adDetect/disposal.ts）。
 * @returns 整批是否成功；该接口只返回整体成败，不分条回执。
 */
export async function deleteMessages(
  chatId: number,
  messageIds: readonly number[],
  api: Api = bot.api
): Promise<boolean> {
  if (messageIds.length === 0) return true;
  return runBooleanTelegramAction(
    "delete messages",
    (signal?: AbortSignal): Promise<true> => api.deleteMessages(chatId, [...messageIds], ...signalArgs(signal))
  );
}

export interface DeleteMessageAfterParams {
  chatId: number;
  messageId: number;
  delayMs: number;
  api?: Api;
}

/** 延迟删除用于公告清理，不让这类美化任务阻止进程退出。 */
export function deleteMessageAfter({ chatId, messageId, delayMs, api = bot.api }: DeleteMessageAfterParams): void {
  setTimeout((): void => {
    void deleteMessage(chatId, messageId, api);
  }, delayMs).unref();
}

export interface MuteChatMemberParams {
  chatId: number;
  userId: number;
  /** 禁言结束的绝对时刻（ms）；这里换算成 Bot API 的 until_date（秒）。 */
  mutedUntil: number;
  api?: Api;
  signal?: AbortSignal;
}

/**
 * 一次禁言尝试的结局，三态的理由同 BanChatMemberOutcome：`forbidden` 是
 * 「再试一次也一样」（缺 `can_restrict_members`，或目标本身是管理员——Telegram
 * 对两者回的是同一句 400 `not enough rights`），`failed` 是限流/网络抖动这类
 * 值得等一等再来的失败。调用方据此决定是就地放弃还是安排重试。
 */
export type MuteChatMemberOutcome = "muted" | "forbidden" | "failed";

/**
 * 临时收走一名成员在本群的全部发言权限（到点由 Telegram 自动恢复）。
 *
 * 与踢人/封禁分开一个入口：那两者是不可逆处置，这条只是把人按下去几分钟，
 * 目前只服务刷屏禁言（见 workers/antiRaid/floodControl.ts）。权限集固定为
 * MUTED_CHAT_PERMISSIONS，调用方不得自带——「禁言」在本仓库只有一种含义。
 *
 * `until_date` 向上取整到秒：Bot API 把「距现在不足 30 秒」当成永久限制，
 * 向下取整在边界上会把时长抹短，宁可多一秒也不能少。
 * @returns 三态结局；失败原因已由统一错误边界记进日志。
 */
export async function muteChatMemberWithOutcome({
  chatId,
  userId,
  mutedUntil,
  api = bot.api,
  signal,
}: MuteChatMemberParams): Promise<MuteChatMemberOutcome> {
  let permissionDenied: boolean = false;
  const muted: boolean = await runTelegramAction({
    action: `mute chat member (chat ${chatId}, user ${userId})`,
    execute: (requestSignal?: AbortSignal): Promise<true> => api.restrictChatMember(
      chatId,
      userId,
      MUTED_CHAT_PERMISSIONS,
      { until_date: Math.ceil(mutedUntil / 1000) },
      ...signalArgs(requestSignal)
    ),
    map: (): boolean => true,
    fallback: false,
    signal,
    shouldLogError: (error: unknown, actionSignal: AbortSignal | undefined): boolean => {
      permissionDenied = isPermissionDenied(error);
      return actionSignal?.aborted !== true;
    },
  });
  if (muted) return "muted";
  return permissionDenied ? "forbidden" : "failed";
}

/** 一次只踢不封请求的结局；权限拒绝与瞬时失败必须由长生命周期调用方区别处理。 */
export type KickChatMemberOutcome = "kicked" | "forbidden" | "failed";

/** 原子地将成员移出群聊但不加入封禁名单，并保留失败类别。 */
export async function kickChatMemberWithOutcome(
  chatId: number,
  userId: number,
  api: Api = bot.api
): Promise<KickChatMemberOutcome> {
  let permissionDenied: boolean = false;
  const kicked: boolean = await runTelegramAction({
    action: `kick chat member (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<true> =>
      api.unbanChatMember(chatId, userId, {}, ...signalArgs(signal)),
    map: (): boolean => true,
    fallback: false,
    shouldLogError: (error: unknown): boolean => {
      permissionDenied = isPermissionDenied(error);
      return true;
    },
  });
  if (kicked) return "kicked";
  return permissionDenied ? "forbidden" : "failed";
}

/** 只关心是否踢成功的兼容入口。 */
export async function kickChatMember(
  chatId: number,
  userId: number,
  api: Api = bot.api
): Promise<boolean> {
  return (await kickChatMemberWithOutcome(chatId, userId, api)) === "kicked";
}

/**
 * 一次封禁尝试的结局。`forbidden` 与 `failed` 必须分开：前者是「再试一次也
 * 一样」，后者是限流/网络抖动这类值得退避重试的失败。调用方据此决定是继续按
 * 时间重试，还是等权限变更。
 *
 * `forbidden` 本身还混着两种成因——机器人没有封禁权限，与目标本身是管理员
 * ——Telegram 对两者返回的是同一句 400 `not enough rights`。只有前者是整个群
 * 的问题，调用方必须再用 `probeChatAdmin` 分辨一次，不能拿一个封不掉的管理员
 * 把整个群的清扫闩死（见 workers/antiRaid/blocklistEffects.ts）。
 */
export type BanChatMemberOutcome = "banned" | "forbidden" | "failed";

/** Telegram 是否明确拒绝了这次操作的权限，而不是偶发失败。 */
function isPermissionDenied(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  // 403 一律算：不在群、被踢出、没有权限，共同点是「这次调用永远不会成功」。
  // 400 只认点名权限的那一句：同为 400 的「用户不存在」「聊天不存在」不该
  // 被当成权限问题，那会让一个本可重试的批次被永久挂起等一个不会来的授权。
  if (error.error_code === 403) return true;
  return error.error_code === 400 && /not enough rights/i.test(error.description);
}

/**
 * 封禁一名成员，并连带删除 TA 在这个群发过的全部消息（`revoke_messages`）。
 *
 * 这条路径只服务于黑名单处置——`/block`、黑名单成员入群秒踢、新晋管理员后的
 * 补扫、以及广告检测命中，四者都是「管理员认定这个人不该留下任何痕迹」的判断，
 * 消息一并清掉才是完整处置。反刷群的自动踢出走 kickChatMember（只踢不封，防
 * 误杀），本来就不经过这里。
 * @returns 结局三态；只关心成败的调用方用下面的 banChatMember。
 */
export async function banChatMemberWithOutcome(
  chatId: number,
  userId: number,
  api: Api = bot.api
): Promise<BanChatMemberOutcome> {
  let permissionDenied: boolean = false;
  const banned: boolean = await runTelegramAction({
    action: `ban chat member (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<true> => signal === undefined
      ? api.banChatMember(chatId, userId, { revoke_messages: true })
      : api.banChatMember(
        chatId,
        userId,
        { revoke_messages: true },
        signal as unknown as Parameters<Api["banChatMember"]>[3]
      ),
    map: (): boolean => true,
    fallback: false,
    shouldLogError: (error: unknown): boolean => {
      permissionDenied = isPermissionDenied(error);
      return true;
    },
  });
  if (banned) return "banned";
  return permissionDenied ? "forbidden" : "failed";
}

/** 只关心成败的封禁入口；权限与偶发失败的区分见 banChatMemberWithOutcome。 */
export async function banChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  return (await banChatMemberWithOutcome(chatId, userId, api)) === "banned";
}

/**
 * 解除某人在这个群的封禁。**`only_if_banned` 不能省**：Bot API 的
 * unbanChatMember 对「当前就是群成员」的人语义是把他移出群聊——上面那个
 * kickChatMember 正是靠这一点实现「只踢不封」的。不带这个标志去批量解封，
 * 会把那些本来好端端待在群里的人一个个踢出去。
 * @returns 调用成功为 true；本来就没被封禁也算成功（该标志下是 no-op）。
 */
export async function unbanChatMemberIfBanned(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction(
    `unban chat member (chat ${chatId}, user ${userId})`,
    (signal?: AbortSignal): Promise<true> => signal === undefined
      ? api.unbanChatMember(chatId, userId, { only_if_banned: true })
      : api.unbanChatMember(
        chatId,
        userId,
        { only_if_banned: true },
        signal as unknown as Parameters<Api["unbanChatMember"]>[3]
      )
  );
}

function isPresentMember(member: ChatMember): boolean {
  if (member.status === "restricted") return member.is_member;
  return member.status === "creator" || member.status === "administrator" || member.status === "member";
}

/** 查询失败按非成员处理，避免在未确认时生成“已踢出”的错误战报。 */
export async function isChatMember(chatId: number, userId: number, api: Api = bot.api): Promise<boolean> {
  return runTelegramAction({
    action: `check chat membership (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<ChatMember> => signal === undefined
      ? api.getChatMember(chatId, userId)
      : api.getChatMember(
        chatId,
        userId,
        signal as unknown as Parameters<Api["getChatMember"]>[2]
      ),
    map: isPresentMember,
    fallback: false,
  });
}

/**
 * 同上，但把「确认不在群」与「查询失败」分开。isChatMember 那种 fail-closed
 * 的 boolean 适合战报措辞（没确认就不吹嘘已踢出），却不能用来决定要不要执行
 * 处置——一次 429 被当成「不在群」就等于静默放过一个该被清出去的人。
 * @returns 在群 true、确认不在群 false、查询失败 undefined（调用方自行决定
 *   未确认时的偏向）。
 */
export async function probeChatMembership(
  chatId: number,
  userId: number,
  api: Api = bot.api
): Promise<boolean | undefined> {
  return runTelegramAction<ChatMember, boolean | undefined>({
    action: `probe chat membership (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<ChatMember> => signal === undefined
      ? api.getChatMember(chatId, userId)
      : api.getChatMember(
        chatId,
        userId,
        signal as unknown as Parameters<Api["getChatMember"]>[2]
      ),
    map: isPresentMember,
    fallback: undefined,
  });
}

/**
 * 目标此刻是不是这个群的管理员/群主。
 *
 * 用来给一次 `forbidden` 的封禁结局定性：Telegram 对「机器人没有封禁权限」和
 * 「目标本身是管理员」返回的是同一句 400 `not enough rights`，只看报错分不开，
 * 而两者的处置天差地别——前者是整个群卡住、要等一次权限变更，后者只是这一个
 * 目标封不掉。这里直接问 Telegram 那个目标的身份，比翻管理员缓存精确（匿名
 * 管理员按设计不进缓存，见 workers/antiRaid/adminCache.ts）。
 * @returns 确认是管理员 true、确认不是 false、查询失败 undefined。
 */
export async function probeChatAdmin(
  chatId: number,
  userId: number,
  api: Api = bot.api
): Promise<boolean | undefined> {
  return runTelegramAction<ChatMember, boolean | undefined>({
    action: `probe chat admin (chat ${chatId}, user ${userId})`,
    execute: (signal?: AbortSignal): Promise<ChatMember> => signal === undefined
      ? api.getChatMember(chatId, userId)
      : api.getChatMember(
        chatId,
        userId,
        signal as unknown as Parameters<Api["getChatMember"]>[2]
      ),
    map: (member: ChatMember): boolean => isAdminStatus(member.status),
    fallback: undefined,
  });
}

/**
 * 封禁一个频道马甲在本群的发言权，并把「机器人缺封禁权限」从偶发失败里分出来。
 * 结局语义同 banChatMemberWithOutcome，少了 targetIsAdmin 那一档——频道身份不是
 * 群成员，probeChatAdmin 走的 getChatMember 描述不了它，没有可再拆细的确证。
 *
 * 只返回布尔值不够：调用方拿不到 forbidden 就只能结算成 failed，那个群的
 * permissionBlocked 闩锁永远 arm 不了，批次转而无限重试注定失败的请求。
 */
export async function banChatSenderChatWithOutcome(
  chatId: number,
  senderChatId: number,
  api: Api = bot.api
): Promise<BanChatMemberOutcome> {
  let permissionDenied: boolean = false;
  const banned: boolean = await runTelegramAction({
    action: `ban sender chat (chat ${chatId}, sender chat ${senderChatId})`,
    execute: (signal?: AbortSignal): Promise<true> => signal === undefined
      ? api.banChatSenderChat(chatId, senderChatId)
      : api.banChatSenderChat(
        chatId,
        senderChatId,
        signal as unknown as Parameters<Api["banChatSenderChat"]>[2]
      ),
    map: (): boolean => true,
    fallback: false,
    shouldLogError: (error: unknown): boolean => {
      permissionDenied = isPermissionDenied(error);
      return true;
    },
  });
  if (banned) return "banned";
  return permissionDenied ? "forbidden" : "failed";
}

/** 只关心成败的频道马甲封禁入口；权限与偶发失败的区分见 banChatSenderChatWithOutcome。 */
export async function banChatSenderChat(chatId: number, senderChatId: number, api: Api = bot.api): Promise<boolean> {
  return (await banChatSenderChatWithOutcome(chatId, senderChatId, api)) === "banned";
}

/**
 * 解除某个频道马甲在这个群的发言封禁。频道身份没有「成员」这一说，因此不存在
 * unbanChatMember 那种「解封等于踢人」的陷阱，直接调即可。
 */
export async function unbanChatSenderChat(chatId: number, senderChatId: number, api: Api = bot.api): Promise<boolean> {
  return runBooleanTelegramAction(
    `unban sender chat (chat ${chatId}, sender chat ${senderChatId})`,
    (signal?: AbortSignal): Promise<true> => signal === undefined
      ? api.unbanChatSenderChat(chatId, senderChatId)
      : api.unbanChatSenderChat(
        chatId,
        senderChatId,
        signal as unknown as Parameters<Api["unbanChatSenderChat"]>[2]
      )
  );
}

export async function copyMessage(chatId: number, fromChatId: number, messageId: number): Promise<number | undefined> {
  return runTelegramAction({
    action: "copy message",
    execute: (signal?: AbortSignal): Promise<MessageId> => signal === undefined
      ? bot.api.copyMessage(chatId, fromChatId, messageId)
      : bot.api.copyMessage(
        chatId,
        fromChatId,
        messageId,
        {},
        signal as unknown as Parameters<Api["copyMessage"]>[4]
      ),
    map: (copied: MessageId): number | undefined => {
      markSelfSent(chatId, copied.message_id);
      return copied.message_id;
    },
    fallback: undefined,
  });
}
