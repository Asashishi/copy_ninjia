import { logger } from "../../infra/logger";
import { sleep } from "../../libs/sleep";
import { BoundedDeque } from "../../libs/boundedDeque";
import { sanitizeInline, truncateAtClauseBoundary } from "../../libs/text";
import { formatBufferedMessageLine } from "../../aiChat/ai/utils/chatTranscript";
import { summaryAiProvider } from "../../aiChat/provider";
import {
  COMPACTION_MAX_PENDING_PER_CHAT,
  MAX_SUMMARY_ROUNDS,
  CHAT_SUMMARY_ERROR_LABEL,
  SUMMARY_MAX_CHARS,
  SUMMARY_RETRY_DELAYS_MS,
} from "../../consts/aiChat/memory";
import { CURRENT_TIME_LABEL, SUMMARY_SYSTEM_PROMPT, summarySelfNote } from "../../consts/aiChat/prompts/memory";
import { botInfoState } from "../../cache/workers/aiChat/identity";
import { chatSummaries, dirtyMemoryChats, pendingSummaries } from "../../cache/workers/aiChat/memory";
import { compactionPendingCounts, compactionRunner } from "../../cache/workers/aiChat/compaction";
import {
  cachedReplyGeneration,
  isCachedReplyGenerationCurrent,
} from "../../cache/workers/aiChat/replies";
import type { BufferedMessage } from "../../types/aiChat/memory";
import type { AiTextResult } from "../../types/aiChat/provider";
import { currentTimeSentence } from "../../aiChat/ai/timeSentence";
import { replyGenerationSignal, trackReplyGenerationTask } from "./replyGeneration";

/**
 * 中期记忆的轮换/压缩：镜像块攒满后串行执行「晋升上一轮摘要 + AI 压缩新
 * 镜像」，机制见 consts/aiChat/memory.ts 的 COMPACT_BATCH_SIZE 注释。入口是
 * scheduleRotation，由 rollingMemory.ts 的 pushBufferedMessage 在块边界调用。
 */

/**
 * 把一轮「晋升旧摘要 + 压缩新镜像」挂到该群的轮换串行链上（链的机制见
 * libs/keyedSerialTaskRunner.ts）。同群轮换串行执行，晋升的摘要来自上一轮的
 * 压缩结果，摘要按时间顺序入队。rotateCompaction 自身兜错，链不因单轮失败中断。
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

  // 溢出判定之后才取 signal：replyGenerationSignal 惰性创建 AbortController 并登记进
  // replyAbortControllers，登记项由 trackReplyGenerationTask 的 finally 或整代失效清理摘除。
  const signal: AbortSignal = replyGenerationSignal(generation);
  compactionPendingCounts.set(chatId, pendingCount + 1);
  const next: Promise<void> = compactionRunner.run(chatId, (): Promise<void> => rotateCompaction({
    chatId,
    mirrorBatch,
    promoteFirst,
    generation,
    signal,
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
  signal: AbortSignal;
}

/** 执行一轮轮换：先晋升上一轮镜像的摘要（若有），再 AI 压缩新镜像存为待晋升。 */
async function rotateCompaction({
  chatId,
  mirrorBatch,
  promoteFirst,
  generation,
  signal,
}: RotateCompactionParams): Promise<void> {
  try {
    if (signal.aborted || !isCachedReplyGenerationCurrent(chatId, generation)) return;
    if (promoteFirst) {
      promotePendingSummary(chatId);
    }
    const summary: string | null = await summarizeBatchWithRetry(chatId, mirrorBatch, signal);
    if (signal.aborted || !isCachedReplyGenerationCurrent(chatId, generation)) return;
    if (summary) {
      pendingSummaries.set(chatId, summary);
      dirtyMemoryChats.add(chatId);
    } else {
      // SDK 请求重试或业务层重采样用尽后放弃，不回灌；镜像原文在下一轮滑出逐字区时
      // 这段中期记忆才缺失。
      logger.error(`AI compaction failed: chat ${chatId}'s ${mirrorBatch.length} mirrored messages produced no summary after eligible retries; mid-term memory for this window will be missing once it slides out.`);
    }
  } catch (error: unknown) {
    if (signal.aborted) return;
    logger.error("Error in chat compaction task:", error);
  }
}

/**
 * 带退避重采样的镜像压缩：只有 HTTP 成功但 candidate 异常或清洗后正文为空
 * 才按 SUMMARY_RETRY_DELAYS_MS 再发请求。网络/HTTP 失败由供应商 SDK 重试，
 * 此处不再重试。本函数在该群的轮换串行链上执行，只顺延本群后续轮换，不阻塞消息分发。
 */
async function summarizeBatchWithRetry(
  chatId: number,
  batch: BufferedMessage[],
  signal: AbortSignal
): Promise<string | null> {
  for (let attempt: number = 0; ; attempt++) {
    if (signal.aborted) return null;
    const result: AiTextResult = await summarizeBatch(batch, signal);
    if (signal.aborted) return null;
    if (result.ok) return result.text;
    if (!result.retryable || attempt >= SUMMARY_RETRY_DELAYS_MS.length) return null;
    const delayMs: number = SUMMARY_RETRY_DELAYS_MS[attempt]!;
    logger.warn(`AI compaction attempt ${attempt + 1} returned no usable summary for chat ${chatId}; resampling in ${delayMs} ms.`);
    await sleep(delayMs, signal);
  }
}

/** 把上一轮镜像的摘要（其原文刚滑出逐字区）晋升进该群的中期记忆队列。 */
function promotePendingSummary(chatId: number): void {
  const pending: string | undefined = pendingSummaries.get(chatId);
  pendingSummaries.delete(chatId);
  if (!pending) return; // 上一轮压缩失败：无可晋升项，失败当时已记过日志。
  let queue: BoundedDeque<string> | undefined = chatSummaries.get(chatId);
  if (!queue) {
    queue = new BoundedDeque<string>(MAX_SUMMARY_ROUNDS);
    chatSummaries.set(chatId, queue);
  }
  if (queue.size === MAX_SUMMARY_ROUNDS) queue.shift();
  queue.push(pending);
  dirtyMemoryChats.add(chatId);
}

/**
 * 调当前供应商把一批冷消息压缩成一条摘要。使用独立的中性总结提示词（不带
 * 人设、不带工具），产出压成单行并截断，保持「一行一条」的转录结构。
 *
 * systemPrompt 只放逐字恒定的 SUMMARY_SYSTEM_PROMPT，当前时间拼在 userContent
 * **末尾**、整批转录之后；转录行自带每条消息的发送时间（见 chatTranscript.ts 的
 * formatBufferedMessageLine），末尾这句只补当前时间。
 *
 * 截断用 truncateAtClauseBoundary 按子句边界进行，上限为 SUMMARY_MAX_CHARS；摘要经
 * buildMemorySnapshot 落进 chat_states.ai_context，并作为中期记忆回喂模型最多
 * MAX_SUMMARY_ROUNDS 轮。
 */
async function summarizeBatch(batch: BufferedMessage[], signal: AbortSignal): Promise<AiTextResult> {
  const selfId: number | undefined = botInfoState.current?.id;
  const selfNote: string = selfId !== undefined ? summarySelfNote(selfId) : "";
  return summaryAiProvider().generateText({
    purpose: "chatSummary",
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    userContent: selfNote + batch.map((message: BufferedMessage): string => formatBufferedMessageLine(message, selfId)).join("\n") + "\n\n" + currentTimeSentence(CURRENT_TIME_LABEL),
    signal,
    errorLabel: CHAT_SUMMARY_ERROR_LABEL,
    normalize: (text: string): string => {
      const sanitized: string = sanitizeInline(text);
      return sanitized ? truncateAtClauseBoundary(sanitized, SUMMARY_MAX_CHARS) : "";
    },
  });
}
