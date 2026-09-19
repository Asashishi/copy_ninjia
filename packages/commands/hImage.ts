/**
 * `/h_image`：从随机图片目录（state.global.assets.randomImageDir，见
 * infra/storage/stateStore.ts 的 getRandomImageDirectory）均匀抽一张发到本群。
 *
 * 群是否已 `/init`、私聊是否放行由 infra/updateGate.ts 的前置网关统一判定，这里不再
 * 重复。update runner 严格串行（见 docs/cn/04-invariants.md），目录枚举与最大 10 MB
 * 的上传不能在 handler 里等待：参数校验后交给有界执行器即返回，照 `/wed` 的接纳方式
 * 恢复取消上下文。用法、忙碌与各失败提示走 sendCommandMessage，30 秒后删除；结果
 * 图片只经 sendHImageResult 发送。
 */

import type { CommandContext, Context } from "grammy";
import { hImageRuntime } from "../cache/main/hImage";
import { H_IMAGE_MAX_CONCURRENT, H_IMAGE_MAX_PENDING } from "../consts/hImage";
import { chatAtmosphere } from "../infra/atmosphere";
import { trackBackgroundTask } from "../infra/backgroundTasks";
import { pickRandomImage } from "../infra/randomImage";
import { getRandomImageDirectory } from "../infra/storage/stateStore";
import { sendCommandMessage, sendPhotoWithResult } from "../infra/telegram";
import { combineWithUpdateAbortSignal, runWithUpdateAbortSignal } from "../infra/updateContext";
import { forumTopicThreadId } from "../libs/forumTopic";
import { settleWithinBudget } from "../libs/inflight";
import { createPrioritizedBoundedTaskRunner } from "../libs/prioritizedBoundedTaskRunner";
import type { AtmosphereTexts } from "../types/atmosphere";
import type { HImageRuntime } from "../types/hImage";
import type { FlushResult } from "../types/lifecycle";
import type { RandomImagePick } from "../types/randomImage";

/** 一次 `/h_image` 请求出队后要用到的会话坐标。 */
interface HImageRequest {
  readonly chatId: number;
  /** 触发命令的消息；结果与失败提示都回复它。 */
  readonly messageId: number | undefined;
  /** 论坛群里触发消息所在话题；General 与非论坛群为 undefined。 */
  readonly messageThreadId: number | undefined;
}

/** sendHImageResult 的入参。 */
interface SendHImageResultParams extends HImageRequest {
  readonly pick: Extract<RandomImagePick, { status: "ok" }>;
}

/**
 * `/h_image` 结果图片的唯一发送边界。**长期保留**：这是用户授权的保留例外（见
 * AGENTS.md「Telegram 提示留存」），不挂固定延迟删除；论坛群带触发消息所在话题并
 * 回复触发消息。经共享的 sendPhotoWithResult 发送，自发登记、throttler 与 429 分类闸
 * 都在那一层。
 */
async function sendHImageResult({ chatId, messageId, messageThreadId, pick }: SendHImageResultParams): Promise<void> {
  await sendPhotoWithResult({
    chatId,
    bytes: pick.bytes,
    mimeType: pick.mimeType,
    replyToMessageId: messageId,
    messageThreadId,
  });
}

/** 出队后抽取并发送；抽取失败按结果回一句 30 秒提示。 */
async function deliverRandomImage(request: HImageRequest): Promise<void> {
  const pick: RandomImagePick = await pickRandomImage(getRandomImageDirectory());
  if (pick.status === "ok") {
    await sendHImageResult({ ...request, pick });
    return;
  }
  const texts: AtmosphereTexts["H_IMAGE_TEXTS"] = chatAtmosphere(request.chatId).H_IMAGE_TEXTS;
  const text: string = pick.status === "missingDirectory"
    ? texts.missingDirectory
    : pick.status === "empty" ? texts.empty : texts.tooLarge(pick.fileName);
  await sendCommandMessage({ chatId: request.chatId, text, replyToMessageId: request.messageId });
}

/**
 * 同步接纳一条请求；执行器未启动、已停止接纳或等待位已满时返回 false。每项恢复
 * 接纳时的 update 取消上下文并合入运行时停止信号。
 */
function submitHImageRequest(request: HImageRequest): boolean {
  const runtime: HImageRuntime | null = hImageRuntime.current;
  if (runtime === null || !runtime.accepting || runtime.runner.pendingCount >= H_IMAGE_MAX_PENDING) return false;
  const taskSignal: AbortSignal = combineWithUpdateAbortSignal(runtime.controller.signal)!;
  if (taskSignal.aborted) return false;
  const completion: Promise<unknown> = runtime.runner.run("interactive", (): Promise<void> =>
    runWithUpdateAbortSignal(taskSignal, (): Promise<void> => deliverRandomImage(request)), taskSignal)
    .catch((error: unknown): void => {
      if (!taskSignal.aborted) throw error;
    });
  trackBackgroundTask(runtime.tasks, completion, "Unexpected error while processing /h_image request:");
  return true;
}

/** 处理 `/h_image`：不接受参数；接纳后立即返回，满额时回「稍后再试」。 */
export async function handleHImageCommand(ctx: CommandContext<Context>): Promise<void> {
  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const texts: AtmosphereTexts["H_IMAGE_TEXTS"] = chatAtmosphere(chatId).H_IMAGE_TEXTS;
  if (ctx.match.trim().length > 0) {
    await sendCommandMessage({ chatId, text: texts.usage, replyToMessageId: messageId });
    return;
  }
  if (!submitHImageRequest({ chatId, messageId, messageThreadId: forumTopicThreadId(ctx.msg) })) {
    await sendCommandMessage({ chatId, text: texts.busy, replyToMessageId: messageId });
  }
}

/** 启动时创建唯一执行器；上一代还有任务时禁止重建。 */
export function initHImageRuntime(): void {
  const previous: HImageRuntime | null = hImageRuntime.current;
  if (previous !== null && previous.tasks.size > 0) {
    throw new Error("Cannot initialize /h_image while requests are unsettled.");
  }
  previous?.controller.abort();
  hImageRuntime.current = {
    runner: createPrioritizedBoundedTaskRunner({
      maxConcurrent: H_IMAGE_MAX_CONCURRENT,
      maxPending: H_IMAGE_MAX_PENDING,
      maxBackgroundPending: 0,
      interactiveBurst: 1,
    }),
    controller: new AbortController(),
    tasks: new Set(),
    accepting: true,
  };
}

/** 停机关闭接纳；已接纳的请求仍在原执行器中按序排空。 */
export function quiesceHImageRuntime(): void {
  if (hImageRuntime.current !== null) hImageRuntime.current.accepting = false;
}

/** 等待已接纳的请求结算；预算耗尽时取消排队与在途请求，零预算可用于紧急停机。 */
export async function drainHImageRuntime(timeoutMs: number): Promise<FlushResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError("/h_image drain timeout must be finite and non-negative.");
  quiesceHImageRuntime();
  const runtime: HImageRuntime | null = hImageRuntime.current;
  if (runtime === null || runtime.tasks.size === 0) return "flushed";
  if (timeoutMs > 0 && await settleWithinBudget(runtime.tasks, timeoutMs)) return "flushed";
  runtime.controller.abort();
  return "timedOut";
}
