import { logger } from "../../infra/logger";
import { sleep } from "../../libs/sleep";
import { LinkedQueue } from "../../libs/linkedQueue";
import type { GenerateContentResponse } from "@google/genai";
import { sanitizeInline, truncateAtClauseBoundary } from "../../libs/text";
import { formatBufferedMessageLine } from "../../aiChat/ai/utils/chatTranscript";
import { requestGeminiTextResult } from "../../aiChat/ai/gemini";
import {
  COMPACTION_MAX_PENDING_PER_CHAT,
  GEMINI_SUMMARY_MODEL,
  MAX_SUMMARY_ROUNDS,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_RETRY_DELAYS_MS,
  SUMMARY_TEMPERATURE,
} from "../../consts/aiChat/memory";
import { SUMMARY_SYSTEM_PROMPT } from "../../consts/aiChat/prompts/memory";
import { botInfoState } from "../../cache/workers/aiChat/identity";
import { chatSummaries, dirtyMemoryChats, pendingSummaries } from "../../cache/workers/aiChat/memory";
import { compactionPendingCounts, compactionRunner } from "../../cache/workers/aiChat/compaction";
import {
  cachedReplyGeneration,
  isCachedReplyGenerationCurrent,
} from "../../cache/workers/aiChat/replies";
import type { BufferedMessage } from "../../types/aiChat/memory";
import type { GeminiTextGenerationResult } from "../../types/aiChat/gemini";
import { currentTimeSentence } from "./timeSentence";
import { trackReplyGenerationTask } from "./replyGeneration";

/**
 * 中期记忆的轮换/压缩：镜像块攒满后串行执行「晋升上一轮摘要 + AI 压缩新
 * 镜像」，机制见 consts/aiChat/memory.ts 的 COMPACT_BATCH_SIZE 注释。入口是
 * scheduleRotation，由 rollingMemory.ts 的 pushBufferedMessage 在块边界调用。
 */

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
  const generation: number = cachedReplyGeneration(chatId);
  const pendingCount: number = compactionPendingCounts.get(chatId) ?? 0;
  if (pendingCount >= COMPACTION_MAX_PENDING_PER_CHAT) {
    logger.error(
      `AI compaction backlog reached ${COMPACTION_MAX_PENDING_PER_CHAT} tasks for chat ${chatId}; ` +
      `dropping one ${mirrorBatch.length}-message batch to keep memory bounded.`
    );
    return;
  }

  compactionPendingCounts.set(chatId, pendingCount + 1);
  const next: Promise<void> = compactionRunner.run(chatId, (): Promise<void> => rotateCompaction({
    chatId,
    mirrorBatch,
    promoteFirst,
    generation,
  }));
  trackReplyGenerationTask(chatId, generation, next);
  void next.then(
    (): void => finishCompactionTask(chatId),
    (): void => finishCompactionTask(chatId)
  );
}

/** 完成任务后释放计数（链本身的清理由 keyedSerialTaskRunner 负责，见其
 *  内部的同一性检查）。 */
function finishCompactionTask(chatId: number): void {
  const remaining: number = Math.max(0, (compactionPendingCounts.get(chatId) ?? 1) - 1);
  if (remaining === 0) compactionPendingCounts.delete(chatId);
  else compactionPendingCounts.set(chatId, remaining);
}

export interface RotateCompactionParams {
  chatId: number;
  mirrorBatch: BufferedMessage[];
  promoteFirst: boolean;
  generation: number;
}

/** 执行一轮轮换：先晋升上一轮镜像的摘要（若有），再 AI 压缩新镜像存为待晋升。 */
async function rotateCompaction({
  chatId,
  mirrorBatch,
  promoteFirst,
  generation,
}: RotateCompactionParams): Promise<void> {
  try {
    if (!isCachedReplyGenerationCurrent(chatId, generation)) return;
    if (promoteFirst) {
      promotePendingSummary(chatId);
    }
    const summary: string | null = await summarizeBatchWithRetry(chatId, mirrorBatch);
    if (!isCachedReplyGenerationCurrent(chatId, generation)) return;
    if (summary) {
      pendingSummaries.set(chatId, summary);
      dirtyMemoryChats.add(chatId);
    } else {
      // SDK 请求重试或业务层重采样用尽后才放弃，且不回灌：镜像原文此刻还在
      // 逐字区，要到下一轮滑出时这段中期记忆才真正缺失。
      logger.error(`AI compaction failed: chat ${chatId}'s ${mirrorBatch.length} mirrored messages produced no summary after eligible retries; mid-term memory for this window will be missing once it slides out.`);
    }
  } catch (error: unknown) {
    logger.error("Error in chat compaction task:", error);
  }
}

/**
 * 带退避重采样的镜像压缩：只有 HTTP 成功但 candidate 异常或清洗后正文为空
 * 才按 SUMMARY_RETRY_DELAYS_MS 再发请求。网络/HTTP 失败已由 Gemini SDK 重试，
 * 此处立即停止，避免两层次数相乘。等待期间镜像原文仍在逐字区；本函数在该群
 * 的轮换串行链上执行，只顺延本群后续轮换，不阻塞消息分发。
 */
async function summarizeBatchWithRetry(chatId: number, batch: BufferedMessage[]): Promise<string | null> {
  for (let attempt: number = 0; ; attempt++) {
    const result: GeminiTextGenerationResult = await summarizeBatch(batch);
    if (result.ok) return result.text;
    if (!result.retryable || attempt >= SUMMARY_RETRY_DELAYS_MS.length) return null;
    const delayMs: number = SUMMARY_RETRY_DELAYS_MS[attempt]!;
    logger.error(`AI compaction attempt ${attempt + 1} returned no usable summary for chat ${chatId}; resampling in ${delayMs} ms.`);
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
 *
 * 截断用子句边界而不是硬切：SUMMARY_MAX_TOKENS 远大于 SUMMARY_MAX_CHARS，
 * 上游不会把长度约束到这个量级附近，硬切留下的半句会被 buildMemorySnapshot
 * 落进 memory/ai/<chat>.json，再作为中期记忆回喂模型最多 MAX_SUMMARY_ROUNDS 轮
 * （truncateAtClauseBoundary 的 JSDoc 记的正是这类残留）。
 */
async function summarizeBatch(batch: BufferedMessage[]): Promise<GeminiTextGenerationResult> {
  const selfNote: string = botInfoState.current
    ? `注意：[id:${botInfoState.current.id}] 是群里的聊天机器人「${botInfoState.current.first_name}」本人的发言，摘要里请以「${botInfoState.current.first_name}」称呼它。\n\n`
    : "";
  return requestGeminiTextResult(
    {
      model: GEMINI_SUMMARY_MODEL,
      contents: [{ role: "user", parts: [{ text: selfNote + batch.map(formatBufferedMessageLine).join("\n") }] }],
      config: {
        systemInstruction: currentTimeSentence() + SUMMARY_SYSTEM_PROMPT,
        temperature: SUMMARY_TEMPERATURE,
        maxOutputTokens: SUMMARY_MAX_TOKENS,
      },
    },
    "Gemini summarize API",
    (data: GenerateContentResponse): string => {
      const sanitized: string = sanitizeInline(data.text ?? "");
      return sanitized ? truncateAtClauseBoundary(sanitized, SUMMARY_MAX_CHARS) : "";
    }
  );
}
