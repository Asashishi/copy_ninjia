import { bot } from "../../packages/infra/telegram/mainClient";
import { installTelegramApi } from "../../packages/infra/telegram/client";
import type { TelegramApi } from "../../packages/types/telegramWorker";
import type { Transformer } from "grammy";

/**
 * 出站硬闸：基准脚本会 import 生产模块，而部署机上 bot 通常正在运行、用的是同一个
 * token。任何一次真实出站都以线上机器人的身份发出，且无法撤回。所有场景按设计
 * 都只碰进程内存和自己的 mock 数据根，这里把统一出站通道堵死，让越界变成一次
 * 响亮的失败。
 *
 * **必须装 grammY transformer，光换 globalThis.fetch 拦不住它。** grammY 在模块
 * 加载时就把 fetch 绑到内部 shim 上（`node_modules/grammy/out/core/client.js` 里
 * 的 `shim_node_js_1.fetch`），之后调用只认那个绑定；而静态 import 又先于模块体
 * 执行，赋值再早也来不及。实测靠改 globalThis.fetch「保护」的一次基准，仍然向
 * Telegram 发出了三万多次 getChatAdministrators。transformer 挂在 grammY 自己的
 * 调用层，与传输实现无关，才是可靠的拦截点。
 *
 * globalThis.fetch 这道仍然保留，但它覆盖的是**另一类**调用：项目里直接写
 * `fetch(...)` 的地方（头像抓取、JSON API）在调用时才解析全局，因此拦得住。
 *
 * 本模块由 hotPaths.ts 与 fullSuite 的各子进程共用：多一个会 import 生产模块的
 * 基准入口，就多一条可能打到线上的路径，这道闸只能有一份实现。
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
   * 只有机器人自己是管理员。
   *
   * 机器人那份要带齐处置权限，否则 ensureBotChatPermissions 记下的是「没有处置
   * 权」，广告处置会在排队前短路，量不到 outbox 那一段。但**不能**对所有人都回
   * 管理员：那样任何依赖成员态的链路都会把发送者当成管理员而走进豁免分支，读数
   * 变快且量的是另一件事。当前广告链路靠预热的管理员缓存绕开了这个查询，这里按
   * 身份区分是为了下一条命令链路不必再发现一次。
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
 * 罐头应答过的方法调用次数，按方法名累计。
 *
 * 命令链路必须能断言「这一条真的走完了」。少了它，一次把链路导进静默 return 的
 * 回归（准入闸拒绝、配置没投递、触发被丢弃）会表现成读数突然变快，而不是失败——
 * 那是基准最坏的一种坏法：还在出数，数已经不对。
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
 * 装一套只在进程内应答的 Telegram 出站。
 *
 * 只给要跑完整命令链路的基准用（广告判定、AI 回复）：那两条链路的处置段会真的
 * 调 deleteMessages / banChatMember / sendMessage，而 installOutboundGuards 装的
 * 闸是**抛异常**。让它抛，量到的就是每一步都失败的错误分支——错误分支既不落盘
 * 也不做处置记账，读数会系统性偏快且毫无意义。
 *
 * 回的一律是「调用成功」的最小形状，因此计时窗口里保留了处置段的全部进程内工作
 * （黑名单落盘、移除 outbox 写前日志、播报编码），只把网络往返本身摘掉——这正是
 * 「除网络延迟外都要测」的口径。返回值不追求与 Bot API 完全同构，只满足调用方
 * 真正读取的字段；读到别的字段说明链路变了，那时应当在这里补，而不是放任 undefined
 * 悄悄把链路导进另一条分支。
 *
 * **必须在 installOutboundGuards 之后调用。** grammY 的 `use` 是每装一层就把当前
 * 调用链包进去（`transformers.reduce(concatTransformer, this.call)`），所以**后装
 * 的在最外层**。罐头装在后面才拿得到第一手，而 deny 那一层直接抛、根本不会调用
 * 下一层——顺序反了的话罐头永远不会被执行。顺序对了就是「罐头认得的方法就地应答，
 * 认不得的继续撞在硬闸上」。
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
  // 一次性收窄：逐个方法照 grammY 的 Message/ChatMember 完整形状构造，只会让这
  // 份替身比被测链路还长，而调用方读到的字段就上面那几个。
  installTelegramApi(capability as unknown as TelegramApi);
}
