import type { Sticker } from "@grammyjs/types";
import { logger } from "../infra/logger";
import { sendSticker } from "../infra/telegram";
import { describeStickerForContext, getAllStickers, matchCandidateEmojis } from "./stickerSets";
import { getCatalogEntry } from "./stickerCatalog";
import { extractOutputText, requestXaiResponse } from "./xai";
import { stickerConfig } from "./stickerConfig";
import { pickRandom } from "../libs/random";
import { sanitizeInline } from "../libs/text";
import { STICKER_SELECTION_MAX_TOKENS, STICKER_SELECTION_SYSTEM_PROMPT, STICKER_SELECTION_TEMPERATURE, XAI_MODEL } from "../consts/aiChat";
import type { StickerCatalogEntry } from "../types";

/**
 * AI 回复贴纸包：每次 AI 回复（含随机搭话）后，有一定概率从白名单贴纸包里挑一枚
 * 「应景」的贴纸跟发。白名单、触发概率、（兜底用的）情绪关键词映射都放在
 * config/stickers.json 里，改配置不需要碰代码，且该文件不进 .gitignore（随
 * 仓库一起提交），见 ai/stickerConfig.ts。
 *
 * 挑选优先走「按画面描述选」（pickStickerByDescription）：白名单贴纸的
 * 画面描述目录由 ai/stickerCatalog.ts 生成/持久化，把回复文本 + 编号目录
 * 交给模型挑一枚编号——比原来「关键词 -> 贴纸自带 emoji 元数据」的两层
 * 间接匹配准得多（贴纸作者随手标的 emoji 经常文不对题）。目录未覆盖到的
 * 贴纸、模型弃权（NONE）、解析失败或请求失败，都回退到原有的关键词匹配
 * （pickStickerByKeywords），保证目录还没生成完那阵子功能不中断。
 */

/** 按目录描述挑一枚应景贴纸：只在有画面描述的贴纸里选（没生成描述的贴纸
 *  目录还不认识，交给关键词兜底路处理），把回复文本和编号清单交给模型
 *  挑一个编号；模型弃权（NONE）、输出解析不出合法编号、或请求失败，均
 *  返回 null 交给调用方回退。 */
async function pickStickerByDescription(contextText: string): Promise<{ sticker: Sticker; description: string } | null> {
  const allStickers: Sticker[] = await getAllStickers(stickerConfig.packs);
  if (allStickers.length === 0) return null;

  const candidates: { sticker: Sticker; entry: StickerCatalogEntry }[] = [];
  for (const sticker of allStickers) {
    const entry: StickerCatalogEntry | undefined = getCatalogEntry(sticker.file_unique_id);
    if (entry) candidates.push({ sticker, entry });
  }
  if (candidates.length === 0) return null;

  const listText: string = candidates.map((c, i: number) => `${i + 1}. ${c.entry.emoji || "（无 emoji）"} ${c.entry.description}`).join("\n");
  const data: any = await requestXaiResponse(
    {
      model: XAI_MODEL,
      input: [
        { role: "system", content: STICKER_SELECTION_SYSTEM_PROMPT },
        {
          role: "user",
          content: `即将发送的回复内容：「${sanitizeInline(contextText)}」\n\n可选贴纸清单：\n${listText}`,
        },
      ],
      temperature: STICKER_SELECTION_TEMPERATURE,
      max_output_tokens: STICKER_SELECTION_MAX_TOKENS,
    },
    "xAI sticker selection API"
  );
  if (!data) return null;

  const index: number | null = parseStickerSelectionIndex(extractOutputText(data), candidates.length);
  if (index === null) return null;

  const picked = candidates[index - 1]!;
  return { sticker: picked.sticker, description: picked.entry.description };
}

/**
 * 从模型的挑选调用输出里解析出一个合法的贴纸编号（1-based）。模型按指令
 * 应该只输出一个数字或 NONE，但仍按「取输出里第一段数字」的宽容策略解析
 * （容忍偶尔多余的标点/空白），越界或解析不出数字（含 NONE、空输出）一律
 * 返回 null，交给调用方回退到关键词匹配。
 */
export function parseStickerSelectionIndex(raw: string, candidateCount: number): number | null {
  const match: RegExpMatchArray | null = raw.trim().match(/\d+/);
  if (!match) return null;
  const index: number = Number.parseInt(match[0], 10);
  if (!Number.isInteger(index) || index < 1 || index > candidateCount) return null;
  return index;
}

/**
 * 按回复文本挑一枚「应景」的贴纸（关键词兜底路）：优先在候选 emoji（见
 * matchCandidateEmojis）命中的贴纸里随机选一枚；没命中任何情绪关键词，
 * 或命中的 emoji 在白名单贴纸里都找不到，就退化为在全部白名单贴纸里随机
 * 选。贴纸包全部拉取失败时返回 null。
 */
async function pickStickerByKeywords(contextText: string): Promise<Sticker | null> {
  const allStickers: Sticker[] = await getAllStickers(stickerConfig.packs);
  if (allStickers.length === 0) return null;

  const candidateEmojis: Set<string> = matchCandidateEmojis(stickerConfig.emotionKeywords, contextText);
  if (candidateEmojis.size > 0) {
    const matched: Sticker[] = allStickers.filter((sticker: Sticker) => sticker.emoji && candidateEmojis.has(sticker.emoji));
    const picked: Sticker | undefined = pickRandom(matched);
    if (picked) return picked;
  }

  return pickRandom(allStickers) ?? null;
}

/** 挑一枚要跟发的贴纸：按画面描述选，选不出（无目录条目/模型弃权/请求
 *  失败）则回退关键词匹配。关键词路径选出的贴纸若恰好目录里已有描述
 *  （只是没被选择调用命中——它可能没进候选清单，也可能被模型放弃了），
 *  顺手查出来一并带上，自录记忆行不因为走了兜底路就丢了这份画面信息。 */
async function pickSticker(contextText: string): Promise<{ sticker: Sticker; description?: string } | null> {
  const byDescription = await pickStickerByDescription(contextText);
  if (byDescription) return byDescription;

  const byKeywords: Sticker | null = await pickStickerByKeywords(contextText);
  if (!byKeywords) return null;
  return { sticker: byKeywords, description: getCatalogEntry(byKeywords.file_unique_id)?.description };
}

/**
 * 以配置的概率（默认 1/2）触发一次贴纸发送：按 contextText 挑一枚应景的白名单贴纸
 * 发到目标聊天。fire-and-forget，不阻塞调用方；白名单为空、概率未命中或贴纸包
 * 拉取失败时静默跳过。
 * @param chatId 目标聊天 ID。
 * @param contextText 用于匹配情绪/挑选应景贴纸的文本（通常是本次 AI 回复的原文）。
 * @param onSent 贴纸确认发送成功后的回调，参数是这枚贴纸的上下文描述行
 *   （见 describeStickerForContext）与发出去那条消息的 ID——调用方用描述行
 *   把贴纸自录进 AI 对话缓存，用消息 ID 报回主线程登记自发消息（防频道
 *   自回环，见 infra/selfSentTracker.ts）。用回调而不是让本模块直接调
 *   aiChat 的 recordChatMessage，是为了避免 stickers.ts 和
 *   workers/aiChatWorker.ts 互相 import 形成循环依赖。
 */
export function maybeSendStickerReply(chatId: number, contextText: string, onSent?: (stickerDescription: string, messageId: number) => void): void {
  if (stickerConfig.packs.length === 0) return;
  if (Math.random() >= stickerConfig.replyStickerProbability) return;

  void (async (): Promise<void> => {
    const picked = await pickSticker(contextText);
    if (!picked) return;
    const sentMessageId: number | undefined = await sendSticker(chatId, picked.sticker.file_id);
    if (sentMessageId !== undefined && onSent) {
      onSent(describeStickerForContext(picked.sticker, picked.description), sentMessageId);
    }
  })().catch((error: unknown) => {
    logger.error("Error in sticker reply task:", error);
  });
}
