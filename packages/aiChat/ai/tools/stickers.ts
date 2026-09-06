import { EMPTY_STICKER_MENU } from "../../../consts/aiChat/stickers";
import type { StickerSet } from "grammy/types";
import type { AiToolDefinition } from "../../../types/aiChat/provider";
import { getStickerConfig } from "../../../config/stickers";
import { sendSticker } from "../../../infra/telegram";
import { logger } from "../../../infra/logger";
import { describeStickerForContext, getCatalogEntry, getPackSummary, getStickerSet } from "../stickers";
import { parseIndexField } from "../utils/toolArgs";
import { raceAbort } from "../../../libs/abortSignal";
import {
  MAX_STICKER_PACK_VIEWS_PER_REPLY,
  MAX_STICKERS_PER_REPLY,
  STICKER_CHOOSE_DELAY_BASE_MS,
  STICKER_CHOOSE_DELAY_JITTER_MS,
  STICKER_INTENT_MAX_CHARS,
  STICKER_PACK_SUMMARY_PENDING,
} from "../../../consts/aiChat/stickers";
import {
  SEND_STICKER_TOOL_INSTRUCTION,
  STICKER_INTENT_SELECTION_INSTRUCTION,
  VIEW_STICKER_PACK_TOOL_INSTRUCTION,
} from "../../../consts/aiChat/prompts/tools";
import { REPLY_INVALIDATED_TOOL_ERROR, SEND_STICKER_TOOL, VIEW_STICKER_PACK_TOOL } from "../../../consts/tools";
import { toolError } from "../utils/toolResult";
import {
  stickerMenuCache,
  stickerMenuInflight,
  stickerMenuRevision,
} from "../../../cache/workers/aiChat/stickers/menu";
import { aiChatWorkerAbortController } from "../../../cache/workers/aiChat/worker";
import { pauseForToolAction } from "../utils/toolPause";
import type { ChatActionControl } from "../../../types/aiChat/chatAction";
import type { ReplyToolExecution } from "../../../types/aiChat/replies";
import type { StickerCatalogEntry } from "../../../types/stickers/catalog";
import type { StickerCandidate, StickerPackCandidate, StickerRoundState, StickerSendLockControl } from "../../../types/stickers/tools";

/**
 * 应景贴纸的两层选择工具：
 * 一层 view_sticker_pack——工具描述里只列每个白名单包的编号、包名和整包
 * 简介（≤200 字，见 aiChat/ai/stickers/catalog.ts 的 summarizePack），模型按简介挑
 * 一个包调用，返回包内每枚贴纸的编号清单（emoji + 画面描述）；
 * 二层 send_sticker——按「包编号 + 贴纸编号」真正发送。必须先看过对应包的
 * 清单才能发（viewedPackIntents 强制）；每轮最多查看
 * MAX_STICKER_PACK_VIEWS_PER_REPLY 个不同包，同一包只能查看一次；每轮回复最多
 * MAX_STICKERS_PER_REPLY 枚（当前为 1：要么不发、要么只发一枚）、绝不重复同一枚（acceptedStickerUids 按
 * file_unique_id 强制，上限为 1 时限额先挡住、此规则只在上限放宽时兜底）
 * ——这些限额状态挂在 StickerRoundState 上，每轮回复新建一份（见
 * aiChat/ai/tools/replyToolset/orchestrator.ts）。轮内限额之外还有一道跨轮互斥：同群并发的几轮回复
 * 只有第一个走到发送的轮能抢到本群的发贴纸锁（见 aiChat/ai/stickers/sendLock.ts），
 * 其余轮的 send_sticker 被拒绝、改用文字回应，避免并发轮各发一枚在几秒内
 * 贴纸刷屏。
 *
 * 工具定义仍是按次回复现组装的（不进 packages/aiChat/ai/tools/index.ts 的静态清单）：菜单会随
 * 目录内容变化，且模型选中的编号要和组装工具描述时用的同一份菜单对应，
 * 两处必须共享 buildStickerPackMenu() 同一次调用的产出。
 */

export function createStickerRoundState(): StickerRoundState {
  return { viewedPackIntents: new Map(), acceptedStickerUids: new Set() };
}

/**
 * 组装当前可选的贴纸包菜单：每个白名单包收整包简介 + 包内已经生成过画面
 * 描述的贴纸（还没描述的贴纸不出现，等下一轮目录对账补上）。拉取失败或
 * 一枚可用贴纸都没有的包整个跳过；简介还没生成出来的包用占位文案，包内
 * 清单照常可看。
 */
export function buildStickerPackMenu(
  signal?: AbortSignal
): Promise<readonly StickerPackCandidate[]> {
  if (signal?.aborted === true) return Promise.resolve(EMPTY_STICKER_MENU);
  const revision: number = stickerMenuRevision.current;
  const cached: typeof stickerMenuCache.current = stickerMenuCache.current;
  if (cached?.revision === revision) return Promise.resolve(cached.menu);
  const inflight: typeof stickerMenuInflight.current = stickerMenuInflight.current;
  if (inflight?.revision === revision) return waitForStickerMenu(inflight.promise, signal);

  const workerSignal: AbortSignal = aiChatWorkerAbortController.current.signal;
  const promise: Promise<readonly StickerPackCandidate[]> = rebuildStickerPackMenu(
    revision,
    workerSignal
  );
  stickerMenuInflight.current = { revision, promise };
  return waitForStickerMenu(promise, signal);
}

/** 真正重建一次菜单，并在期间没有再次失效时写回记忆化缓存。 */
async function rebuildStickerPackMenu(
  revision: number,
  signal: AbortSignal
): Promise<readonly StickerPackCandidate[]> {
  try {
    const menu: readonly StickerPackCandidate[] = await collectStickerPackMenu(signal);
    // 构建期间目录又变过就不落缓存：这一份已经是旧的，下一次取会重建。
    if (!signal.aborted && stickerMenuRevision.current === revision) {
      stickerMenuCache.current = { revision, menu };
    }
    return menu;
  } finally {
    if (stickerMenuInflight.current?.revision === revision) stickerMenuInflight.current = null;
  }
}

async function collectStickerPackMenu(signal: AbortSignal): Promise<StickerPackCandidate[]> {
  const packs: readonly string[] = getStickerConfig().packs;
  // 各包拉取互不依赖，并发进行，避免冷启动/负缓存刚过期时把多个包的网络
  // 延迟串联进同一轮回复。用 allSettled 而非 all：任何一个包的意外异常都
  // 不该把其余已经拉回来的包一并作废（getStickerSet 自身失败返回 null，
  // reject 属于防御场景）。
  const results: PromiseSettledResult<StickerSet | null>[] = await Promise.allSettled(
    packs.map((pack: string): Promise<StickerSet | null> =>
      getStickerSet(pack, undefined, signal)
    )
  );
  const menu: StickerPackCandidate[] = [];
  for (let i: number = 0; i < packs.length; i++) {
    const pack: string = packs[i]!;
    const result: PromiseSettledResult<StickerSet | null> = results[i]!;
    if (result.status === "rejected") {
      // packs 已由配置校验限制为最多五项；防御性 rejection 仍要带包名落日志，
      // 不能把 allSettled 变成吞错。常规 Telegram 失败由 getStickerSet 返回 null。
      logger.error(`Unexpected sticker menu fetch rejection for pack "${pack}":`, result.reason);
    }
    const set: StickerSet | null = result.status === "fulfilled" ? result.value : null;
    if (!set) continue;
    const stickers: StickerCandidate[] = [];
    for (const sticker of set.stickers) {
      const entry: StickerCatalogEntry | undefined = getCatalogEntry(sticker.file_unique_id);
      if (entry) stickers.push({ sticker, emoji: entry.emoji, description: entry.description });
    }
    if (stickers.length === 0) continue;
    menu.push({ pack, title: set.title, summary: getPackSummary(pack) ?? STICKER_PACK_SUMMARY_PENDING, stickers });
  }
  return menu;
}

/** 每轮回复只取消自己的等待；共享构建继续服务其它回复，底层由 Worker 信号收口，
 *  竞速实现见 libs/abortSignal.ts。 */
function waitForStickerMenu(
  request: Promise<readonly StickerPackCandidate[]>,
  signal?: AbortSignal
): Promise<readonly StickerPackCandidate[]> {
  return raceAbort(request, {
    signal,
    cancelled: EMPTY_STICKER_MENU,
    rejected: EMPTY_STICKER_MENU,
  });
}

/** 包内贴纸的编号清单文本（每行「编号. emoji 画面描述」），一层工具的返回值用。 */
function formatPackStickerList(candidate: StickerPackCandidate): string {
  return candidate.stickers.map((c: StickerCandidate, i: number): string => `${i + 1}. ${c.emoji || "（无 emoji）"} ${c.description}`).join("\n");
}

/**
 * 构造 view_sticker_pack 的工具定义：description 里带上包的编号清单（包名 +
 * 整包简介），pack_index 按菜单长度约束取值范围。菜单为空（白名单为空、
 * 或目录还没生成出任何描述）时返回 null——两层工具一起不提供。
 */
export function buildViewStickerPackToolDefinition(menu: readonly StickerPackCandidate[]): AiToolDefinition | null {
  if (menu.length === 0) return null;

  const listText: string = menu.map((p: StickerPackCandidate, i: number): string => `${i + 1}. 「${p.title}」（${p.stickers.length} 枚）：${p.summary}`).join("\n");
  return {
    name: VIEW_STICKER_PACK_TOOL,
    description: VIEW_STICKER_PACK_TOOL_INSTRUCTION + listText,
    parametersJsonSchema: {
      type: "object",
      properties: {
        pack_index: { type: "integer", description: `要查看的贴纸包在清单里的编号，1 到 ${menu.length} 之间。` },
        intent: {
          type: "string",
          description: `希望贴纸产生的回复效果，并说明需要避免的情绪或语气；写成一句具体短句，不超过 ${STICKER_INTENT_MAX_CHARS} 字。`,
          maxLength: STICKER_INTENT_MAX_CHARS,
        },
      },
      required: ["pack_index", "intent"],
    },
  };
}

/** 构造 send_sticker 的工具定义（两层选择的第二层），菜单为空时返回 null。 */
export function buildSendStickerToolDefinition(menu: readonly StickerPackCandidate[]): AiToolDefinition | null {
  if (menu.length === 0) return null;

  return {
    name: SEND_STICKER_TOOL,
    description: SEND_STICKER_TOOL_INSTRUCTION,
    parametersJsonSchema: {
      type: "object",
      properties: {
        pack_index: { type: "integer", description: `贴纸包在 view_sticker_pack 清单里的编号，1 到 ${menu.length} 之间。` },
        sticker_index: { type: "integer", description: "贴纸在该包清单（view_sticker_pack 的返回结果）里的编号。" },
      },
      required: ["pack_index", "sticker_index"],
    },
  };
}

/** 解析查看贴纸包时必填的表达意图：必须是去除首尾空白后的非空单行文本，
 * 且不能超过 STICKER_INTENT_MAX_CHARS，避免把大段推理带进工具往返。 */
export function parseStickerIntent(argumentsJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  const value: unknown = (parsed as Record<string, unknown> | null)?.intent;
  if (typeof value !== "string") return null;
  const intent: string = value.replace(/\s+/g, " ").trim();
  if (!intent || intent.length > STICKER_INTENT_MAX_CHARS) return null;
  return intent;
}

/** viewStickerPackTool 的入参。 */
export interface ViewStickerPackToolParams {
  /**
   * 本轮聊天状态心跳的挡位切换句柄（见 aiChat/ai/chatActionHeartbeat.ts 的
   * startChatActionHeartbeat）。
   */
  chatAction: ChatActionControl;
  /** 必须是同一轮回复里 buildStickerPackMenu 产出的那份菜单。 */
  menu: readonly StickerPackCandidate[];
  argumentsJson: string;
  state: StickerRoundState;
  signal?: AbortSignal;
}

/**
 * 校验查看额度并同步返回真实贴纸编号与描述，供模型下一次调用选择。
 * 选择状态跨越模型往返；拟人停顿只在独立发送链内执行。
 */
export function viewStickerPackTool({
  chatAction,
  menu,
  argumentsJson,
  state,
  signal,
}: ViewStickerPackToolParams): string {
  if (signal?.aborted === true) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
  const packIndex: number | null = parseIndexField(argumentsJson, "pack_index", menu.length);
  if (packIndex === null) return toolError("Invalid pack_index");
  const intent: string | null = parseStickerIntent(argumentsJson);
  if (intent === null) return toolError(`Invalid intent: provide a concrete non-empty intent within ${STICKER_INTENT_MAX_CHARS} characters`);
  if (state.viewedPackIntents.has(packIndex)) {
    return toolError(
      "Sticker pack already viewed in this reply; do not view it again. Use its existing list, choose a different unviewed pack, or reply without a sticker"
    );
  }
  if (state.viewedPackIntents.size >= MAX_STICKER_PACK_VIEWS_PER_REPLY) {
    return toolError(
      `Sticker pack view limit reached: at most ${MAX_STICKER_PACK_VIEWS_PER_REPLY} different packs per reply; do not call view_sticker_pack again. Reply with text/reaction or finish`
    );
  }

  // 切挡立即补发一次 choose_sticker，之后由心跳按间隔重发维持（间隔小于
  // 约 5 秒的状态过期时间，显示连续）。
  chatAction.set("choose_sticker");

  const candidate: StickerPackCandidate = menu[packIndex - 1]!;
  state.viewedPackIntents.set(packIndex, intent);
  return JSON.stringify({
    pack: candidate.title,
    intent,
    selection_instruction: STICKER_INTENT_SELECTION_INSTRUCTION,
    stickers: formatPackStickerList(candidate),
  });
}

/** sendStickerTool 的入参。 */
export interface SendStickerToolParams {
  /**
   * 本轮聊天状态心跳的挡位切换句柄（见 aiChat/ai/chatActionHeartbeat.ts 的
   * startChatActionHeartbeat）。
   */
  chatAction: ChatActionControl;
  /**
   * 本轮的同群发贴纸锁句柄（见 aiChat/ai/stickers/sendLock.ts 的
   * createStickerSendLock）。
   */
  stickerLock: StickerSendLockControl;
  chatId: number;
  /** 本轮所在的论坛话题；缺了它话题群里的贴纸会掉进 General。 */
  messageThreadId: number | undefined;
  /**
   * 必须是同一轮回复里 buildStickerPackMenu 产出的那份菜单（与组装工具描述/
   * 一层清单时用的编号一一对应，见模块头注）。
   */
  menu: readonly StickerPackCandidate[];
  argumentsJson: string;
  state: StickerRoundState;
  /**
   * 发送成功后的回调（描述行 + 消息 ID），供调用方自录记忆/登记自发消息
   * （防频道自回环，见 infra/selfSentTracker.ts）。
   */
  onSent: (stickerDescription: string, messageId: number) => void;
  isActive?: () => boolean;
  signal?: AbortSignal;
}

/**
 * 校验已查看清单、限额与同群锁，接纳时预占贴纸，返回独立发送链。
 * 调用链持有选择心跳、取消信号和真实发送后的回调；同群锁由轮次收尾释放。
 */
export function sendStickerTool({
  chatAction,
  stickerLock,
  chatId,
  messageThreadId,
  menu,
  argumentsJson,
  state,
  onSent,
  isActive = (): boolean => true,
  signal,
}: SendStickerToolParams): ReplyToolExecution {
  if (!isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
  const packIndex: number | null = parseIndexField(argumentsJson, "pack_index", menu.length);
  if (packIndex === null) return toolError("Invalid pack_index");
  const pack: StickerPackCandidate = menu[packIndex - 1]!;

  const stickerIndex: number | null = parseIndexField(argumentsJson, "sticker_index", pack.stickers.length);
  if (stickerIndex === null) return toolError("Invalid sticker_index");

  if (!state.viewedPackIntents.has(packIndex)) {
    return toolError("Pack not viewed yet: call view_sticker_pack on this pack first");
  }
  if (state.acceptedStickerUids.size >= MAX_STICKERS_PER_REPLY) {
    return toolError(`Sticker limit reached: at most ${MAX_STICKERS_PER_REPLY} stickers per reply`);
  }

  const candidate: StickerCandidate = pack.stickers[stickerIndex - 1]!;
  if (state.acceptedStickerUids.has(candidate.sticker.file_unique_id)) {
    return toolError("Duplicate sticker: already accepted this exact sticker in this reply, pick a different one");
  }

  // 跨轮互斥（放在全部参数/限额校验之后、发送序列之前）：抢不到锁说明
  // 并发轮已经/正在发贴纸，本轮直到结束都不可能再抢到——终局拒绝，收回
  // 本轮的选择挡位，让模型改用文字（见函数头注）。
  if (!stickerLock.tryAcquire()) {
    chatAction.set("idle");
    return toolError("Sticker throttled: a concurrent reply in this chat is already sending a sticker; do not retry, reply with text instead");
  }
  state.acceptedStickerUids.add(candidate.sticker.file_unique_id);
  chatAction.set("idle");
  return {
    result: JSON.stringify({ success: true, queued: true, actions_used: 1 }),
    run: async (chatAction: ChatActionControl): Promise<string> => {
      if (!isActive() || signal?.aborted === true) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
      if (chatAction.current() !== "choose_sticker") {
        chatAction.set("choose_sticker");
        const invalidated: string | null = await pauseForToolAction({
          delayMs: STICKER_CHOOSE_DELAY_BASE_MS + Math.random() * STICKER_CHOOSE_DELAY_JITTER_MS,
          signal,
        });
        if (invalidated !== null) return invalidated;
      }
      chatAction.set("idle");
      await chatAction.settle();
      if (!isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
      const sentMessageId: number | undefined = await sendSticker({
        chatId,
        fileId: candidate.sticker.file_id,
        signal,
        messageThreadId,
      });
      if (sentMessageId === undefined) {
        return toolError("Failed to send sticker");
      }

      onSent(describeStickerForContext(candidate.sticker, candidate.description), sentMessageId);
      return JSON.stringify({ success: true });
    },
  };
}
