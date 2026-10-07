import { bot } from "../../packages/infra/telegram/mainClient";
import { installTelegramApi } from "../../packages/infra/telegram/client";
import type { TelegramApi } from "../../packages/types/telegramWorker";
import type { Transformer } from "grammy";

/**
 * 出站硬闸：任何一次出站调用都直接抛错。
 *
 * Telegram API 由 transformer 在 grammY 调用层拦截（grammY 在模块加载时绑定内部
 * fetch，修改 `globalThis.fetch` 不覆盖这条通道）。
 *
 * `globalThis.fetch` 拦的是项目里直接写 `fetch(...)` 的调用（头像抓取、JSON API），
 * 这些调用在调用时才解析全局。
 *
 * 本模块由热路径入口、fullSuite 各子进程与 review/diskPressure.ts 共用。
 */
export function installOutboundGuards(): void {
  const deny: Transformer = (_prev: unknown, method: string): never => {
    throw new Error(`perf benchmark attempted Telegram API call '${method}'; scenarios must stay in-process`);
  };
  bot.api.config.use(deny);
  globalThis.fetch = ((...args: unknown[]): never => {
    throw new Error(
      `perf benchmark attempted a network call (${JSON.stringify(args[0])}); scenarios must stay in-process`
    );
  }) as unknown as typeof fetch;
}

/** 罐头机器人的身份 id；`bot.botInfo` 与成员态应答必须认同一个。 */
const CANNED_BOT_ID: number = 1;

/** 罐头应答表：键是 Bot API 方法名，值按调用方真正读取的字段构造。 */
const CANNED_TELEGRAM_RESULTS: Readonly<Record<string, (payload: Record<string, unknown>) => unknown>> = {
  answerCallbackQuery: (): true => true,
  banChatMember: (): true => true,
  banChatSenderChat: (): true => true,
  copyMessage: (payload: Record<string, unknown>): unknown => cannedMessage(payload),
  deleteMessage: (): true => true,
  deleteMessages: (): true => true,
  deleteEphemeralMessage: (): true => true,
  getChat: (payload: Record<string, unknown>): unknown =>
    ({ id: Number(payload.chat_id), type: "supergroup" }),
  getChatAdministrators: (): readonly unknown[] => [],
  /**
   * 只有机器人自己算管理员：其余成员返回 `member`，机器人自己返回
   * `administrator` 并带齐处置权限字段。
   */
  getChatMember: (payload: Record<string, unknown>): unknown => {
    const userId: number = Number(payload.user_id);
    if (userId !== CANNED_BOT_ID) {
      return { status: "member", user: { id: userId, is_bot: false, first_name: "benchmark" } };
    }
    return {
      status: "administrator",
      user: { id: userId, is_bot: true, first_name: "benchmark" },
      can_delete_messages: true,
      can_restrict_members: true,
      can_manage_chat: true,
    };
  },
  getStickerSet: (): unknown => ({ stickers: [] }),
  restrictChatMember: (): true => true,
  sendChatAction: (): true => true,
  sendMessage: (payload: Record<string, unknown>): unknown => cannedMessage(payload),
  sendPhoto: (payload: Record<string, unknown>): unknown => cannedMessage(payload),
  sendSticker: (payload: Record<string, unknown>): unknown => cannedMessage(payload),
  sendVoice: (payload: Record<string, unknown>): unknown => cannedMessage(payload),
  setChatPermissions: (): true => true,
  setMessageReaction: (): true => true,
  unbanChatMember: (): true => true,
  unbanChatSenderChat: (): true => true,
};

/**
 * 罐头应答过的方法调用次数，按方法名累计；命令链路用它断言链路真的走完（见
 * AGENTS.md 对 scripts/perf/ 的约束：静默提前返回必须使基准失败）。
 */
export const cannedTelegramCalls: Map<string, number> = new Map<string, number>();

/**
 * 每个方法最近一次被罐头应答的时刻（`Bun.nanoseconds()`）。
 *
 * AI 回复链路用它把「拟人停顿」从读数里扣掉：停顿夹在 `sendChatAction` 与
 * `sendMessage` 两次调用之间，按这两次调用的实测时刻差计算。
 */
export const cannedTelegramCallTimes: Map<string, number> = new Map<string, number>();

function noteCannedCall(method: string): void {
  cannedTelegramCalls.set(method, (cannedTelegramCalls.get(method) ?? 0) + 1);
  cannedTelegramCallTimes.set(method, Bun.nanoseconds());
}

/** 单调递增的消息号，区分各次发出的消息。 */
const cannedMessageId: { current: number } = { current: 0 };

function cannedMessage(payload: Record<string, unknown>): unknown {
  cannedMessageId.current += 1;
  return {
    message_id: cannedMessageId.current,
    date: 1_700_000_000,
    chat: { id: Number(payload.chat_id), type: "supergroup" },
  };
}

/**
 * 装一套只在进程内应答的 Telegram 出站，供跑完整命令链路的基准使用。
 *
 * 回的一律是「调用成功」的最小形状：计时窗口里保留处置段的全部进程内工作
 * （黑名单落盘、移除 outbox 写前日志、播报编码），只去掉网络往返。返回值只含调用方
 * 实际读取的字段，不与 Bot API 完全同构；调用方读到未覆盖的字段时在这里补上对应分支。
 *
 * 必须在 installOutboundGuards 之后调用：grammY 的 `use` 后装的转换器在最外层
 * （`transformers.reduce(concatTransformer, this.call)`），罐头认得的方法就地应答，
 * 认不得的继续落到 deny 那层硬闸。
 */
export function installCannedTelegramOutbound(): void {
  // botAdmin.ts 读 bot.botInfo.id 判断成员态是不是机器人自己的；直接赋值 botInfo，
  // 跳过 bot.init() 的联网握手。
  bot.botInfo = {
    id: CANNED_BOT_ID,
    is_bot: true,
    first_name: "benchmark",
    username: "benchmark_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  // 不接 signal：下一层是 deny，无条件抛错。
  const answer: Transformer = (
    prev: Parameters<Transformer>[0],
    method: string,
    payload: Record<string, unknown>
  ): ReturnType<Transformer> => {
    const canned: ((payload: Record<string, unknown>) => unknown) | undefined =
      CANNED_TELEGRAM_RESULTS[method];
    if (canned === undefined) return prev(method as never, payload as never);
    noteCannedCall(method);
    return Promise.resolve({ ok: true, result: canned(payload) } as never);
  };
  bot.api.config.use(answer);
  // 业务动作走线程能力面而不是 bot.api，两条路径都铺罐头；同一张罐头表喂两边。
  const capability: Record<string, (...args: readonly unknown[]) => Promise<unknown>> = {};
  for (const [method, canned] of Object.entries(CANNED_TELEGRAM_RESULTS)) {
    capability[method] = (...args: readonly unknown[]): Promise<unknown> => {
      noteCannedCall(method);
      return Promise.resolve(canned({ chat_id: args[0], user_id: args[1] }));
    };
  }
  // 只按调用方实际读取的字段构造替身响应，不照 grammY 的 Message/ChatMember
  // 完整形状。
  installTelegramApi(capability as unknown as TelegramApi);
}
