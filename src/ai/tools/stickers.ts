import type { Sticker, StickerSet } from "@grammyjs/types";
import { sendChooseStickerAction, sendSticker } from "../../infra/telegram";
import { sleep } from "../../libs/sleep";
import { describeStickerForContext, getStickerSet } from "../stickerSets";
import { getCatalogEntry, getPackSummary } from "../stickerCatalog";
import { stickerConfig } from "../stickerConfig";
import {
  MAX_STICKERS_PER_REPLY,
  SEND_STICKER_TOOL_INSTRUCTION,
  STICKER_CHOOSE_DELAY_BASE_MS,
  STICKER_CHOOSE_DELAY_JITTER_MS,
  STICKER_PACK_SUMMARY_PENDING,
  VIEW_STICKER_PACK_TOOL_INSTRUCTION,
} from "../../consts/aiChat";
import { SEND_STICKER_TOOL, VIEW_STICKER_PACK_TOOL } from "../../consts/tools";
import type { StickerCatalogEntry, ToolDefinition } from "../../types";

/**
 * 应景贴纸的两层选择工具：
 * 一层 view_sticker_pack——工具描述里只列每个白名单包的编号、包名和整包
 * 简介（≤200 字，见 ai/stickerCatalog.ts 的 summarizePack），模型按简介挑
 * 一个包调用，返回包内每枚贴纸的编号清单（emoji + 画面描述）；
 * 二层 send_sticker——按「包编号 + 贴纸编号」真正发送。必须先看过对应包的
 * 清单才能发（viewedPacks 强制），每轮回复最多 MAX_STICKERS_PER_REPLY 枚
 * （当前为 1：要么不发、要么只发一枚）、绝不重复同一枚（sentStickerUids 按
 * file_unique_id 强制，上限为 1 时限额先挡住、此规则只在上限放宽时兜底）
 * ——这些限额状态挂在 StickerRoundState 上，每轮回复新建一份（见
 * ai/replyTools.ts）。
 *
 * 之前的单层方案把全部贴纸的描述一次性塞进工具描述，包一多每次请求的
 * 提示词都被撑爆；两层方案默认只带每包一行简介，包内清单按需查看。
 *
 * 工具定义仍是按次回复现组装的（不进 src/tools/ 的静态清单）：菜单会随
 * 目录内容变化，且模型选中的编号要和组装工具描述时用的同一份菜单对应，
 * 两处必须共享 buildStickerPackMenu() 同一次调用的产出。
 */

export interface StickerCandidate {
  sticker: Sticker;
  emoji: string;
  description: string;
}

/** 一个可选贴纸包：short name、展示标题、整包简介、包内已有描述的贴纸。 */
export interface StickerPackCandidate {
  pack: string;
  title: string;
  summary: string;
  stickers: StickerCandidate[];
}

/** 一轮回复内贴纸工具的限额状态，随 ReplyToolset 新建（见 ai/replyTools.ts）。 */
export interface StickerRoundState {
  /** 本轮已用 view_sticker_pack 看过清单的包编号（1-based）。 */
  viewedPacks: Set<number>;
  /** 本轮已发出的贴纸 file_unique_id——既是限额计数，也在上限放宽到 1 枚
   *  以上时防止重复发同一枚。 */
  sentStickerUids: Set<string>;
}

export function createStickerRoundState(): StickerRoundState {
  return { viewedPacks: new Set(), sentStickerUids: new Set() };
}

/**
 * 组装当前可选的贴纸包菜单：每个白名单包收整包简介 + 包内已经生成过画面
 * 描述的贴纸（还没描述的贴纸不出现，等下一轮目录对账补上）。拉取失败或
 * 一枚可用贴纸都没有的包整个跳过；简介还没生成出来的包用占位文案，包内
 * 清单照常可看。
 */
export async function buildStickerPackMenu(): Promise<StickerPackCandidate[]> {
  const menu: StickerPackCandidate[] = [];
  for (const pack of stickerConfig.packs) {
    const set: StickerSet | null = await getStickerSet(pack);
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

/** 包内贴纸的编号清单文本（每行「编号. emoji 画面描述」），一层工具的返回值用。 */
export function formatPackStickerList(candidate: StickerPackCandidate): string {
  return candidate.stickers.map((c: StickerCandidate, i: number) => `${i + 1}. ${c.emoji || "（无 emoji）"} ${c.description}`).join("\n");
}

/**
 * 构造 view_sticker_pack 的工具定义：description 里带上包的编号清单（包名 +
 * 整包简介），pack_index 按菜单长度约束取值范围。菜单为空（白名单为空、
 * 或目录还没生成出任何描述）时返回 null——两层工具一起不提供。
 */
export function buildViewStickerPackToolDefinition(menu: StickerPackCandidate[]): ToolDefinition | null {
  if (menu.length === 0) return null;

  const listText: string = menu.map((p: StickerPackCandidate, i: number) => `${i + 1}. 「${p.title}」（${p.stickers.length} 枚）：${p.summary}`).join("\n");
  return {
    name: VIEW_STICKER_PACK_TOOL,
    description: VIEW_STICKER_PACK_TOOL_INSTRUCTION + listText,
    parameters: {
      type: "object",
      properties: {
        pack_index: { type: "integer", description: `要查看的贴纸包在清单里的编号，1 到 ${menu.length} 之间。` },
      },
      required: ["pack_index"],
    },
  };
}

/** 构造 send_sticker 的工具定义（两层选择的第二层），菜单为空时返回 null。 */
export function buildSendStickerToolDefinition(menu: StickerPackCandidate[]): ToolDefinition | null {
  if (menu.length === 0) return null;

  return {
    name: SEND_STICKER_TOOL,
    description: SEND_STICKER_TOOL_INSTRUCTION,
    parameters: {
      type: "object",
      properties: {
        pack_index: { type: "integer", description: `贴纸包在 view_sticker_pack 清单里的编号，1 到 ${menu.length} 之间。` },
        sticker_index: { type: "integer", description: "贴纸在该包清单（view_sticker_pack 的返回结果）里的编号。" },
      },
      required: ["pack_index", "sticker_index"],
    },
  };
}

/**
 * 从工具调用的参数 JSON 里解析出一个合法的 1-based 编号字段；JSON 解析
 * 失败、字段缺失/类型不对/不是整数，或超出 [1, max]，一律返回 null。
 */
export function parseIndexField(argumentsJson: string, field: string, max: number): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  const index: unknown = (parsed as Record<string, unknown> | null)?.[field];
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > max) return null;
  return index;
}

/**
 * 执行一次 view_sticker_pack 工具调用：校验包编号、把该包标记为「本轮已
 * 看过清单」，返回包内贴纸的编号清单。合法调用会先上报一次「正在选择
 * 贴纸…」聊天状态并停顿 1.5~3 秒（见 STICKER_CHOOSE_DELAY_BASE_MS），
 * 模拟真人翻贴纸面板的节奏；非法编号立即报错、不装样子。
 * @param chatId 目标群聊——choose_sticker 状态要发到那里。
 * @param menu 必须是同一轮回复里 buildStickerPackMenu 产出的那份菜单。
 * @returns 喂回模型的结果 JSON 字符串（包名 + 编号清单，或错误说明）。
 */
export async function viewStickerPackTool(chatId: number, menu: StickerPackCandidate[], argumentsJson: string, state: StickerRoundState): Promise<string> {
  const packIndex: number | null = parseIndexField(argumentsJson, "pack_index", menu.length);
  if (packIndex === null) return JSON.stringify({ error: "Invalid pack_index" });

  // 停顿期间每秒补发一次 choose_sticker：生成阶段的「正在输入…」心跳
  // （见 workers/aiChatWorker.ts 的 startTypingHeartbeat，4 秒一发）随时可能
  // 把聊天状态盖回 typing，只发一次的话这个窗口约有一半概率展示的是错的
  // 状态；1 秒一补保证盖掉后最多 1 秒就换回来。
  let remaining: number = STICKER_CHOOSE_DELAY_BASE_MS + Math.random() * STICKER_CHOOSE_DELAY_JITTER_MS;
  while (remaining > 0) {
    void sendChooseStickerAction(chatId);
    const step: number = Math.min(1_000, remaining);
    await sleep(step);
    remaining -= step;
  }

  const candidate: StickerPackCandidate = menu[packIndex - 1]!;
  state.viewedPacks.add(packIndex);
  return JSON.stringify({ pack: candidate.title, stickers: formatPackStickerList(candidate) });
}

/**
 * 执行一次 send_sticker 工具调用：校验编号与本轮限额（必须先看过包清单、
 * 每轮最多 MAX_STICKERS_PER_REPLY 枚、绝不重复同一枚），通过后发送贴纸。
 * @param menu 必须是同一轮回复里 buildStickerPackMenu 产出的那份菜单
 *   （与组装工具描述/一层清单时用的编号一一对应，见模块头注）。
 * @param onSent 发送成功后的回调（描述行 + 消息 ID），供调用方自录记忆/
 *   登记自发消息（防频道自回环，见 infra/selfSentTracker.ts）。
 * @returns 喂回模型的结果 JSON 字符串（成功/失败的简短说明，供模型决定
 *   后续动作——如被限额拒绝，模型该知道贴纸没发出去）。
 */
export async function sendStickerTool(
  chatId: number,
  menu: StickerPackCandidate[],
  argumentsJson: string,
  state: StickerRoundState,
  onSent: (stickerDescription: string, messageId: number) => void
): Promise<string> {
  const packIndex: number | null = parseIndexField(argumentsJson, "pack_index", menu.length);
  if (packIndex === null) return JSON.stringify({ error: "Invalid pack_index" });
  const pack: StickerPackCandidate = menu[packIndex - 1]!;

  const stickerIndex: number | null = parseIndexField(argumentsJson, "sticker_index", pack.stickers.length);
  if (stickerIndex === null) return JSON.stringify({ error: "Invalid sticker_index" });

  if (!state.viewedPacks.has(packIndex)) {
    return JSON.stringify({ error: "Pack not viewed yet: call view_sticker_pack on this pack first" });
  }
  if (state.sentStickerUids.size >= MAX_STICKERS_PER_REPLY) {
    return JSON.stringify({ error: `Sticker limit reached: at most ${MAX_STICKERS_PER_REPLY} stickers per reply` });
  }

  const candidate: StickerCandidate = pack.stickers[stickerIndex - 1]!;
  if (state.sentStickerUids.has(candidate.sticker.file_unique_id)) {
    return JSON.stringify({ error: "Duplicate sticker: already sent this exact sticker in this reply, pick a different one" });
  }

  const sentMessageId: number | undefined = await sendSticker(chatId, candidate.sticker.file_id);
  if (sentMessageId === undefined) return JSON.stringify({ error: "Failed to send sticker" });

  state.sentStickerUids.add(candidate.sticker.file_unique_id);
  onSent(describeStickerForContext(candidate.sticker, candidate.description), sentMessageId);
  return JSON.stringify({ success: true });
}
