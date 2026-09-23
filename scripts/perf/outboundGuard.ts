import { bot } from "../../packages/infra/telegram/mainClient";
import { installTelegramApi } from "../../packages/infra/telegram/client";
import type { TelegramApi } from "../../packages/types/telegramWorker";
import type { Transformer } from "grammy";

/**
 * 出站硬闸：基准子进程会 import 生产模块，部署机上运行的 bot 通常用同一个
 * token。本函数堵死统一出站通道，任何一次出站调用都直接抛错。
 *
 * grammY 在模块加载时绑定内部 fetch；修改 `globalThis.fetch` 不覆盖这条通道，
 * 因此 Telegram API 由 transformer 在 grammY 调用层拦截。
 *
 * `globalThis.fetch` 这道拦的是另一类调用：项目里直接写 `fetch(...)` 的地方
 * （头像抓取、JSON API）在调用时才解析全局，因此拦得住。
 *
 * 本模块由 hotPaths.ts 与 fullSuite 的各子进程共用。
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
   * `administrator` 并带齐处置权限字段。所有人都返回 administrator 会让依赖
   * 成员态的链路把发送者当管理员走进豁免分支，读数偏快且不准。当前广告链路靠
   * 预热的管理员缓存，不会再触发这次查询。
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
  sendAudio: (payload: Record<string, unknown>): unknown => cannedMessage(payload),
  sendChatAction: (): true => true,
  sendMessage: (payload: Record<string, unknown>): unknown => cannedMessage(payload),
  sendPhoto: (payload: Record<string, unknown>): unknown => cannedMessage(payload),
  sendSticker: (payload: Record<string, unknown>): unknown => cannedMessage(payload),
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
 * AI 回复链路要靠它把「拟人停顿」从读数里扣掉：那段 sleep 夹在 `sendChatAction`
 * 与 `sendMessage` 之间，长度是 `1.5s + 55ms/字 + 抖动`，抖动在生产函数内部取
 * `Math.random()`，事后无法复算——只能像这样按真实发生的两次调用实测。
 */
export const cannedTelegramCallTimes: Map<string, number> = new Map<string, number>();

function noteCannedCall(method: string): void {
  cannedTelegramCalls.set(method, (cannedTelegramCalls.get(method) ?? 0) + 1);
  cannedTelegramCallTimes.set(method, Bun.nanoseconds());
}

/** 单调递增的消息号；处置链路要靠它区分自己刚发出的那条提示。 */
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
 * 装一套只在进程内应答的 Telegram 出站，供跑完整命令链路的基准使用（广告判定、
 * AI 回复）。
 *
 * 回的一律是「调用成功」的最小形状：计时窗口里保留处置段的全部进程内工作
 * （黑名单落盘、移除 outbox 写前日志、播报编码），只摘掉网络往返本身。返回值
 * 只满足调用方实际读取的字段，不追求与 Bot API 完全同构；调用方读到未覆盖的
 * 字段时需要在这里补上对应分支。
 *
 * **必须在 installOutboundGuards 之后调用。** grammY 的 `use` 后装的转换器在
 * 最外层（`transformers.reduce(concatTransformer, this.call)`），罐头必须先于
 * deny 那层拦截调用才会生效。顺序对了之后，罐头认得的方法就地应答，认不得的
 * 继续撞在硬闸上。
 */
export function installCannedTelegramOutbound(): void {
  // botAdmin.ts 读 bot.botInfo.id 判断一条成员态是不是机器人自己的，而填上它的
  // bot.init() 是一次联网握手（冷启动分区的小注也点名不含它）。grammY 允许直接
  // 赋值 botInfo 跳过握手，这里给一个稳定身份，不出网也不改判定口径。
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
  // 不接 signal：它下面唯一的一层是 deny，那一层无条件抛异常，取消信号传不传
  // 都不改变结果，而多接一个形参会顶破 max-params。
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
  // 业务动作走线程能力面而不是 bot.api，两条路都要铺到；同一张罐头表喂两边，
  // 免得哪天补了一个方法只补了一半。
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
