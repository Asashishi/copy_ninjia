import { logger } from "../../infra/logger";
import { sleep } from "../../libs/sleep";
import { LinkedQueue } from "../../libs/linkedQueue";
import type { GenerateContentResponse } from "@google/genai";
import { sanitizeInline, truncateInline } from "../../libs/text";
import { formatBufferedMessageLine } from "../../ai/utils/chatTranscript";
import { requestGeminiResponse } from "../../ai/gemini";
import { extractOutputText } from "../../ai/utils/geminiResponse";
import {
  COMPACTION_MAX_PENDING_PER_CHAT,
  GEMINI_SUMMARY_MODEL,
  MAX_SUMMARY_ROUNDS,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_RETRY_DELAYS_MS,
  SUMMARY_TEMPERATURE,
} from "../../consts/aiChat";
import { SUMMARY_SYSTEM_PROMPT } from "../../consts/aiChatPrompts";
import {
  botInfoState,
  chatSummaries,
  compactionChains,
  compactionPendingCounts,
  dirtyMemoryChats,
  pendingSummaries,
  replyGenerations,
} from "../../cache/aiChatWorker";
import { createKeyedSerialTaskRunner } from "../../libs/keyedSerialTaskRunner";
import type { BufferedMessage } from "../../types";
import { currentTimeSentence } from "./timeSentence";

/**
 * 中期记忆的轮换/压缩：镜像块攒满后串行执行「晋升上一轮摘要 + AI 压缩新
 * 镜像」，机制见 consts/aiChat.ts 的 COMPACT_BATCH_SIZE 注释。入口是
 * scheduleRotation，由 rollingMemory.ts 的 pushBufferedMessage 在块边界调用。
 */

const compactionRunner = createKeyedSerialTaskRunner(compactionChains);

/**
 * 把一轮「晋升旧摘要 + 压缩新镜像」挂到该群的轮换串行链上（链的机制见
 * libs/keyedSerialTaskRunner.ts）。链保证时序：洪峰下第 N+1 轮可能在第 N
 * 轮的压缩调用返回前就到来，串行执行才能保证晋升到手的一定是上一轮的
 * 结果、摘要严格按时间顺序入队。rotateCompaction 自身兜错，链永不因此
 * 中断。
 * @param mirrorBatch 刚攒满、成为新镜像的一块消息（快照，之后缓存继续滚动不影响它）。
 * @param promoteFirst 本轮是否有旧镜像滑出（首轮没有），有则先晋升其摘要。
 */
export function scheduleRotation(chatId: number, mirrorBatch: BufferedMessage[], promoteFirst: boolean): void {
  const generation: number = replyGenerations.get(chatId) ?? 0;
  const pendingCount: number = compactionPendingCounts.get(chatId) ?? 0;
  if (pendingCount >= COMPACTION_MAX_PENDING_PER_CHAT) {
    logger.error(
      `AI compaction backlog reached ${COMPACTION_MAX_PENDING_PER_CHAT} tasks for chat ${chatId}; ` +
      `dropping one ${mirrorBatch.length}-message batch to keep memory bounded.`
    );
    return;
  }

  compactionPendingCounts.set(chatId, pendingCount + 1);
  const next: Promise<void> = compactionRunner.run(chatId, () => rotateCompaction(chatId, mirrorBatch, promoteFirst, generation));
  void next.then(
    () => finishCompactionTask(chatId),
    () => finishCompactionTask(chatId)
  );
}

/** 完成任务后释放计数（链本身的清理由 keyedSerialTaskRunner 负责，见其
 *  内部的同一性检查）。 */
function finishCompactionTask(chatId: number): void {
  const remaining: number = Math.max(0, (compactionPendingCounts.get(chatId) ?? 1) - 1);
  if (remaining === 0) compactionPendingCounts.delete(chatId);
  else compactionPendingCounts.set(chatId, remaining);
}

/** 执行一轮轮换：先晋升上一轮镜像的摘要（若有），再 AI 压缩新镜像存为待晋升。 */
async function rotateCompaction(chatId: number, mirrorBatch: BufferedMessage[], promoteFirst: boolean, generation: number): Promise<void> {
  try {
    if ((replyGenerations.get(chatId) ?? 0) !== generation) return;
    if (promoteFirst) {
      promotePendingSummary(chatId);
    }
    const summary: string | null = await summarizeBatchWithRetry(chatId, mirrorBatch);
    if ((replyGenerations.get(chatId) ?? 0) !== generation) return;
    if (summary) {
      pendingSummaries.set(chatId, summary);
      dirtyMemoryChats.add(chatId);
    } else {
      // 重试全败才放弃，且不回灌：镜像原文此刻还在逐字区，要到下一轮
      // 滑出时这段中期记忆才真正缺失。
      logger.error(`AI compaction failed: chat ${chatId}'s ${mirrorBatch.length} mirrored messages produced no summary after ${SUMMARY_RETRY_DELAYS_MS.length + 1} attempts; mid-term memory for this window will be missing once it slides out.`);
    }
  } catch (error: unknown) {
    logger.error("Error in chat compaction task:", error);
  }
}

/**
 * 带退避重试的镜像压缩：summarizeBatch 失败（返回 null）按
 * SUMMARY_RETRY_DELAYS_MS 逐次等待后重试，全败返回 null。这类失败多为
 * 瞬时（网络抖动/临时超载，重启后同一批就能压成功），跨请求重试通常能
 * 救回；重试期间镜像原文仍在逐字区，等得起。本函数在该群的轮换串行链上
 * 执行，等待只顺延本群后续轮换，不阻塞消息分发。
 */
async function summarizeBatchWithRetry(chatId: number, batch: BufferedMessage[]): Promise<string | null> {
  for (let attempt: number = 0; ; attempt++) {
    const summary: string | null = await summarizeBatch(batch);
    if (summary) return summary;
    if (attempt >= SUMMARY_RETRY_DELAYS_MS.length) return null;
    const delayMs: number = SUMMARY_RETRY_DELAYS_MS[attempt]!;
    logger.error(`AI compaction attempt ${attempt + 1} produced no summary for chat ${chatId}; retrying in ${delayMs} ms.`);
    await sleep(delayMs);
  }
}

/** 把上一轮镜像的摘要（其原文刚滑出逐字区）晋升进该群的中期记忆队列。 */
function promotePendingSummary(chatId: number): void {
  const pending: string | undefined = pendingSummaries.get(chatId);
  pendingSummaries.delete(chatId);
  if (!pending) return; // 上一轮压缩失败：无可晋升项，失败当时已记过日志。
  let queue: LinkedQueue<string> | undefined = chatSummaries.get(chatId);
  if (!queue) {
    queue = new LinkedQueue<string>();
    chatSummaries.set(chatId, queue);
  }
  queue.push(pending);
  while (queue.size > MAX_SUMMARY_ROUNDS) {
    queue.shift();
  }
  dirtyMemoryChats.add(chatId);
}

/**
 * 调 Gemini 把一批冷消息压缩成一条摘要。走独立的中性总结提示词（不带
 * 人设、不带工具），产出压成单行并截断——摘要虽是模型生成的，但源头是
 * 用户文本，保持「一行一条」的转录结构，多行伪造向量在这里同样失效。
 */
async function summarizeBatch(batch: BufferedMessage[]): Promise<string | null> {
  const selfNote: string = botInfoState.current
    ? `注意：[id:${botInfoState.current.id}] 是群里的聊天机器人「${botInfoState.current.first_name}」本人的发言，摘要里请以「${botInfoState.current.first_name}」称呼它。\n\n`
    : "";
  const data: GenerateContentResponse | null = await requestGeminiResponse(
    {
      model: GEMINI_SUMMARY_MODEL,
      contents: [{ role: "user", parts: [{ text: selfNote + batch.map(formatBufferedMessageLine).join("\n") }] }],
      config: {
        systemInstruction: currentTimeSentence() + SUMMARY_SYSTEM_PROMPT,
        temperature: SUMMARY_TEMPERATURE,
        maxOutputTokens: SUMMARY_MAX_TOKENS,
      },
    },
    "Gemini summarize API"
  );
  if (!data) return null;
  const sanitized: string = sanitizeInline(extractOutputText(data));
  if (!sanitized) return null;
  return truncateInline(sanitized, SUMMARY_MAX_CHARS);
}
