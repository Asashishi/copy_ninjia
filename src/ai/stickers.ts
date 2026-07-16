import type { Sticker } from "@grammyjs/types";
import { sendSticker } from "../infra/telegram";
import { describeStickerForContext, getAllStickers } from "./stickerSets";
import { getCatalogEntry } from "./stickerCatalog";
import { stickerConfig } from "./stickerConfig";
import { SEND_STICKER_TOOL_INSTRUCTION } from "../consts/aiChat";
import { SEND_STICKER_TOOL } from "../consts/tools";
import type { StickerCatalogEntry, ToolDefinition } from "../types";

/**
 * 应景贴纸：不再是「AI 回复后按概率跟发」的独立步骤，而是做成一个 function
 * calling 工具（send_sticker）——模型在生成回复的同一次对话里，如果判断
 * 配一枚贴纸合适，就直接从编号清单里选一个调用；不合适就不调用，没有
 * 触发概率这道闸了。清单只列白名单包（config/stickers.json）里已经生成过
 * 画面描述的贴纸（见 ai/stickerCatalog.ts），模型照着「emoji + 画面描述」
 * 直接选，不再需要「关键词 -> 贴纸自带 emoji 元数据」那套间接匹配，也不用
 * 为选贴纸单独再发一次请求。
 *
 * 工具定义是按次请求现组装的（不进 src/tools/ 的静态清单）：候选清单会
 * 随目录内容变化，且模型选中的编号要和组装工具描述时用的同一份候选数组
 * 对应，两处必须共享 buildStickerCandidates() 同一次调用的产出，见
 * workers/aiChatWorker.ts 的 callGrok。
 */

export interface StickerCandidate {
  sticker: Sticker;
  emoji: string;
  description: string;
}

/**
 * 组装当前可选的贴纸候选清单：只收白名单包里已经生成过画面描述的贴纸
 * （还没来得及生成描述的贴纸不出现在清单里，等下一轮目录对账补上，见
 * ai/stickerCatalog.ts 的 ensureStickerCatalogs）。
 */
export async function buildStickerCandidates(): Promise<StickerCandidate[]> {
  const allStickers: Sticker[] = await getAllStickers(stickerConfig.packs);
  const candidates: StickerCandidate[] = [];
  for (const sticker of allStickers) {
    const entry: StickerCatalogEntry | undefined = getCatalogEntry(sticker.file_unique_id);
    if (entry) candidates.push({ sticker, emoji: entry.emoji, description: entry.description });
  }
  return candidates;
}

/**
 * 构造 send_sticker 的工具定义：description 里带上编号清单，index 参数按
 * 清单长度约束取值范围。candidates 为空（白名单为空、或目录还没生成出任何
 * 描述）时返回 null——不提供这个工具，模型也就无从调用，比给一个空清单
 * 更干净。
 */
export function buildSendStickerToolDefinition(candidates: StickerCandidate[]): ToolDefinition | null {
  if (candidates.length === 0) return null;

  const listText: string = candidates.map((c: StickerCandidate, i: number) => `${i + 1}. ${c.emoji || "（无 emoji）"} ${c.description}`).join("\n");
  return {
    type: "function",
    name: SEND_STICKER_TOOL,
    description: SEND_STICKER_TOOL_INSTRUCTION + listText,
    parameters: {
      type: "object",
      properties: {
        index: { type: "integer", description: `要发送的贴纸在清单里的编号，1 到 ${candidates.length} 之间。` },
      },
      required: ["index"],
    },
  };
}

/**
 * 从工具调用的参数 JSON 里解析出合法的贴纸编号（1-based）；JSON 解析失败、
 * index 字段缺失/类型不对/不是整数，或超出候选范围，一律返回 null。
 */
export function parseStickerToolIndex(argumentsJson: string, candidateCount: number): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  const index: unknown = (parsed as { index?: unknown } | null)?.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1 || index > candidateCount) return null;
  return index;
}

/**
 * 执行一次 send_sticker 工具调用：解析参数里的编号、发送对应贴纸。
 * @param candidates 必须是同一次 callGrok 调用里 buildStickerCandidates
 *   产出的那份数组（与组装工具描述时用的编号一一对应，见模块头注）。
 * @param argumentsJson 模型给的参数（JSON 字符串），期望形如 `{"index": 3}`。
 * @param onSent 发送成功后的回调（描述行 + 消息 ID），供调用方自录记忆/
 *   登记自发消息（防频道自回环，见 infra/selfSentTracker.ts）。
 * @returns 喂回模型的结果字符串（成功/失败的简短说明，供模型决定后续
 *   措辞——如编号非法或发送失败，模型该知道贴纸没发出去）。
 */
export async function sendStickerTool(
  chatId: number,
  candidates: StickerCandidate[],
  argumentsJson: string,
  onSent: (stickerDescription: string, messageId: number) => void
): Promise<string> {
  const index: number | null = parseStickerToolIndex(argumentsJson, candidates.length);
  if (index === null) return JSON.stringify({ error: "Invalid sticker index" });

  const candidate: StickerCandidate = candidates[index - 1]!;
  const sentMessageId: number | undefined = await sendSticker(chatId, candidate.sticker.file_id);
  if (sentMessageId === undefined) return JSON.stringify({ error: "Failed to send sticker" });

  onSent(describeStickerForContext(candidate.sticker, candidate.description), sentMessageId);
  return JSON.stringify({ success: true });
}
