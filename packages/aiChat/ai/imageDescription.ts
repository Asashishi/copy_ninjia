import {
  MEDIA_CLOSED_RESULT,
  MEDIA_BACKOFF_RESULT,
  MEDIA_TASK_REJECTED_RESULT,
  MEDIA_CANCELLED_RESULT,
  IMAGE_DESCRIPTION_MAX_CHARS,
  MEDIA_DESCRIPTION_ERROR_LABEL,
  SHORT_MEDIA_DESCRIPTION_MAX_CHARS,
} from "../../consts/aiChat/media";
/**
 * 群聊媒体的异步解析入口，四种媒体共用：图片/贴纸/GIF 走视觉描述（下载 Telegram
 * 文件，按需转码，见 infra/image.ts），语音走转写（原样把音频字节交给语音接口，
 * 见 aiChat/ai/voiceTranscription.ts）。产出供 workers/aiChat/mediaIngest.ts 的
 * recordChatMedia 替换对话缓存里的占位文本，视觉描述同时供
 * aiChat/ai/stickers/catalog.ts 生成机器人自己贴纸目录的描述条目。跑在 AI Worker 线程里。
 *
 * 去重缓存、有界执行器、占位→回填时序只有一份，逐媒体的差异只落在 resolveMedia 这一个分支上。
 *
 * 失败一律返回 null、不抛错；调用方按各自的兜底处理（图片退化成「[图片]」占位、
 * 贴纸退化成原有的元数据行、GIF/语音退化成失败占位）。
 */

import { logger } from "../../infra/logger";
import { mediaAiProvider } from "../provider";
import { createSharedResult } from "../../libs/sharedResult";
import type { SharedResult } from "../../libs/sharedResult";
import { sanitizeInline, truncateAtClauseBoundary } from "../../libs/text";
import {
  transientDescriptionTasks,
  transientDescriptionCache,
} from "../../cache/workers/aiChat/imageDescription";
import {
  clearMediaInputProbe,
  getMediaInputProbe,
  getMediaInputState,
  isMediaInputProbeCoolingDown,
  recordMediaInputResult,
  setMediaInputProbe,
} from "../../cache/workers/aiChat/mediaInputSupport";
import { isMediaInputClosed } from "../../states/mediaInputSupport";
import { ANIMATION_DESCRIPTION_PROMPT, IMAGE_DESCRIPTION_PROMPT, STICKER_DESCRIPTION_PROMPT } from "../../consts/aiChat/prompts/media";
import type { MediaKind, VisionImage } from "../../types/media";
import { downloadTelegramVisionImage } from "./telegramImage";
import { hasMediaTaskCapacity, mediaTaskRunner, reserveMediaProbeWait } from "../../cache/workers/aiChat/mediaTasks";
import { transcribeVoiceUncached } from "./voiceTranscription";
import type {
  AiTextResult,
  AiProviderTaskPriority,
  MediaInputCapability,
  MediaInputSupport,
} from "../../types/aiChat/provider";
import type { MediaInputModalityState } from "../../types/states/mediaInputSupport";

/** 模态不可用时复用的同一个已完成 Promise。 */
const MEDIA_CLOSED_PROMISE: Promise<AiTextResult> = Promise.resolve(MEDIA_CLOSED_RESULT);

/** 退避期内复用的同一个已完成 Promise。 */
const MEDIA_BACKOFF_PROMISE: Promise<AiTextResult> = Promise.resolve(MEDIA_BACKOFF_RESULT);

/** 聊天媒体这一轮不解析时复用的空描述。 */
const SKIPPED_DESCRIPTION_PROMISE: Promise<string | null> = Promise.resolve(null);

/** 按媒体类型选喂给视觉模型的描述指令。 */
function promptFor(kind: MediaKind): string {
  switch (kind) {
    case "sticker":
      return STICKER_DESCRIPTION_PROMPT;
    case "animation":
      return ANIMATION_DESCRIPTION_PROMPT;
    default:
      return IMAGE_DESCRIPTION_PROMPT;
  }
}

/** 按媒体类型选描述入缓存前的截断上限：photo 用 IMAGE_DESCRIPTION_MAX_CHARS，
 *  其余用 SHORT_MEDIA_DESCRIPTION_MAX_CHARS。语音的上限在 aiChat/ai/voiceTranscription.ts。 */
function maxCharsFor(kind: MediaKind): number {
  return kind === "photo" ? IMAGE_DESCRIPTION_MAX_CHARS : SHORT_MEDIA_DESCRIPTION_MAX_CHARS;
}

/** describeMedia 的入参。语音专用的 voiceMime 在其余媒体上为 undefined，
 *  形状约束见 types/aiChat/protocol.ts 的 AiRecordMediaMessage。 */
export interface DescribeMediaParams {
  /** 媒体类型，决定走视觉描述还是语音转写，以及用哪份提示词与长度上限。 */
  kind: MediaKind;
  /**
   * 要下载的 Telegram file_id：图片是本体；贴纸是本体（静态）或缩略图（动态/
   * 视频，见 aiChat/ai/stickers/describe.ts 的 pickStickerVisionSource）；GIF 是
   * 缩略图（只分析封面帧）；语音是本体。
   */
  fileId: string;
  /**
   * 缓存去重键：图片用同档位的 file_unique_id；贴纸/GIF 固定用媒体自身（而非
   * 缩略图）的 file_unique_id，同一份贴纸/GIF 无论走本体还是缩略图素材，描述都记在同一个键下。
   */
  fileUniqueId: string;
  /** 语音的 Telegram 声明容器；其余媒体为 undefined。 */
  voiceMime: string | undefined;
  /** 当前聊天回复代际失效时停止等待；共享底层任务由消费者计数决定是否中止。 */
  signal?: AbortSignal;
}

/**
 * 下载并解析一份未命中本地贴纸目录的媒体。四种媒体共用 transientDescriptionCache
 * （容量 MEDIA_DESCRIPTION_CACHE_MAX 的 LRU），键为 file_unique_id。白名单贴纸由调用方
 * 先查 stickerCatalog 的常驻目录，不会走到这里。
 * @returns 压成单行、截断后的中文描述或语音转写；下载/转码/解析任一步失败则 null。
 */
export function describeMedia(params: DescribeMediaParams): Promise<string | null> {
  if (params.signal?.aborted === true) return SKIPPED_DESCRIPTION_PROMISE;
  const capability: MediaInputCapability = params.kind === "voice" ? "voice" : "vision";
  // 模态已关闭与探测退避中两类跳过都在建立 LRU 条目之前返回：不下载、不排队、不写缓存。
  if (
    isMediaInputClosed(getMediaInputState(capability).support) ||
    isMediaInputProbeCoolingDown(capability, Date.now())
  ) {
    return SKIPPED_DESCRIPTION_PROMISE;
  }
  const fileUniqueId: string = params.fileUniqueId;
  const cached: Promise<string | null> | undefined = transientDescriptionCache.get(fileUniqueId);
  if (cached) {
    return transientDescriptionTasks.get(cached)?.wait(params.signal) ?? cached;
  }
  if (!hasMediaTaskCapacity(
    getMediaInputState(capability).support !== "supported" && getMediaInputProbe(capability) !== null
  )) return SKIPPED_DESCRIPTION_PROMISE;

  const controller: AbortController = new AbortController();
  const task: SharedResult<string | null> = createSharedResult(
    resolveMedia({ ...params, signal: controller.signal }).then((attempt: AiTextResult): string | null =>
      attempt.ok ? attempt.text : null
    ),
    {
      cancelled: null,
      rejected: null,
      onUnused: (): void => {
        controller.abort();
        // 仅摘除本任务，LRU 淘汰后同键的新任务不受影响。
        if (transientDescriptionCache.peek(fileUniqueId) === pending) transientDescriptionCache.delete(fileUniqueId);
      },
    }
  );
  const pending: Promise<string | null> = task.promise;
  void pending.then((result: string | null): void => {
    transientDescriptionTasks.delete(pending);
    if (result === null && transientDescriptionCache.peek(fileUniqueId) === pending) {
      transientDescriptionCache.delete(fileUniqueId);
    }
  });
  transientDescriptionTasks.set(pending, task);
  transientDescriptionCache.set(fileUniqueId, pending);
  return task.wait(params.signal);
}

/**
 * 为白名单贴纸目录生成一条常驻描述，不经过 transientDescriptionCache；成功后由调用方
 * 写入 stickerCatalog。失败结果的 retryable 声明目录层能否重新采样。
 */
export function describeMediaForStickerCatalog(
  fileId: string,
  signal?: AbortSignal
): Promise<AiTextResult> {
  return runMediaInputRequest(
    "vision",
    (): Promise<AiTextResult> => describeVisionUncached({
      kind: "sticker",
      fileId,
      priority: "background",
      signal,
    }),
    signal
  );
}

/** 按媒体类型分派到语音转写与视觉描述两条解析实现。 */
function resolveMedia({
  kind,
  fileId,
  voiceMime,
  signal,
}: DescribeMediaParams): Promise<AiTextResult> {
  const capability: MediaInputCapability = kind === "voice" ? "voice" : "vision";
  return runMediaInputRequest(
    capability,
    kind === "voice"
      ? (): Promise<AiTextResult> => transcribeVoiceUncached({
        fileId,
        declaredMime: voiceMime,
        signal,
      })
      : (): Promise<AiTextResult> => describeVisionUncached({
        kind,
        fileId,
        signal,
      }),
    signal
  );
}

/**
 * 把一次真实媒体调用交给有界执行器，并把结果交给模态状态机归因。执行器满载时返回
 * 不带 mediaFailure 的瞬时失败，不推进支持度判定。
 */
function runTrackedMediaAttempt(
  capability: MediaInputCapability,
  task: () => Promise<AiTextResult>,
  signal?: AbortSignal
): Promise<AiTextResult> {
  const attemptState: MediaInputModalityState = getMediaInputState(capability);
  return mediaTaskRunner.run("interactive", task, signal).then((result: AiTextResult | undefined): AiTextResult => {
    // undefined 表示任务没有启动：执行槽位和共享等待额度都满，或出队时已取消；不推进模态状态机。
    if (result === undefined) {
      return signal?.aborted === true ? MEDIA_CANCELLED_RESULT : MEDIA_TASK_REJECTED_RESULT;
    }
    // 归因先于取消判定：请求已拿到结论时照常交给 recordMediaInputResult，再按 signal 返回取消或原结果。
    recordMediaInputResult({ capability, result, attemptState });
    return signal?.aborted === true ? MEDIA_CANCELLED_RESULT : result;
  });
}

/**
 * 媒体请求的准入闸，四条路互斥：
 *
 * 1. 模态已判定不可用（不支持 / 端点配置错误）：复用共享结论，不下载不请求。
 * 2. 在退避窗口内：复用共享瞬时失败，不下载、不占执行器槽位。
 * 3. 已确认支持：直接进有界执行器。
 * 4. 尚无结论：只放行一个首次真实请求，同一能力同时只有一份探测，并发等待者在共享
 *    等待额度内观察它的结果。探测成功后等待者各自进队列；探测结果带 mediaFailure
 *    （模态结论或端点故障）时等待者共享本次失败，退避到期后可重新探测。不带
 *    mediaFailure 的失败只属于探测者自己那份媒体（或那次取消、未获执行槽），等待者
 *    重新进入本闸：在 `.finally` 清掉旧探测后同步重入的第一个等待者成为下一个探测，
 *    其余继续等待它，每个等待者至多各自发起一次真实请求。
 */
function runMediaInputRequest(
  capability: MediaInputCapability,
  task: () => Promise<AiTextResult>,
  signal?: AbortSignal
): Promise<AiTextResult> {
  if (signal?.aborted === true) return Promise.resolve(MEDIA_CANCELLED_RESULT);
  const support: MediaInputSupport = getMediaInputState(capability).support;
  if (isMediaInputClosed(support)) return MEDIA_CLOSED_PROMISE;
  if (isMediaInputProbeCoolingDown(capability, Date.now())) return MEDIA_BACKOFF_PROMISE;
  if (support === "supported") return runTrackedMediaAttempt(capability, task, signal);

  const activeProbe: SharedResult<AiTextResult> | null = getMediaInputProbe(capability);
  if (activeProbe !== null) {
    const release: (() => void) | undefined = reserveMediaProbeWait();
    if (release === undefined) return Promise.resolve(MEDIA_TASK_REJECTED_RESULT);
    return activeProbe.wait(signal).then(
      (result: AiTextResult): Promise<AiTextResult> | AiTextResult => {
        // 释放与转入执行器在同一个同步段内完成，不重复占用等待额度。
        release();
        if (result.ok) return runTrackedMediaAttempt(capability, task, signal);
        // 本等待者自己已取消时，重入第一步即返回 MEDIA_CANCELLED_RESULT。
        return result.mediaFailure === undefined ? runMediaInputRequest(capability, task, signal) : result;
      }
    );
  }

  const probe: SharedResult<AiTextResult> = createSharedResult(
    runTrackedMediaAttempt(capability, task, signal)
      .finally((): void => clearMediaInputProbe(capability, probe)),
    { cancelled: MEDIA_CANCELLED_RESULT, rejected: MEDIA_TASK_REJECTED_RESULT }
  );
  setMediaInputProbe(capability, probe);
  return probe.promise;
}

interface DescribeVisionUncachedParams {
  readonly kind: MediaKind;
  readonly fileId: string;
  readonly priority?: AiProviderTaskPriority;
  readonly signal?: AbortSignal;
}

async function describeVisionUncached({
  kind,
  fileId,
  priority = "interactive",
  signal,
}: DescribeVisionUncachedParams): Promise<AiTextResult> {
  try {
    const image: VisionImage | null = await downloadTelegramVisionImage({
      fileId,
      logLabel: `chat media (kind=${kind})`,
      signal,
    });
    if (!image) return { ok: false, retryable: true };
    return await mediaAiProvider(priority).describeVision({
      prompt: promptFor(kind),
      image,
      signal,
      errorLabel: MEDIA_DESCRIPTION_ERROR_LABEL,
      normalize: (text: string): string => {
        const description: string = sanitizeInline(text);
        if (!description) return "";
        // 模型超限时收在子句边界，不在半句中间硬切。
        return truncateAtClauseBoundary(description, maxCharsFor(kind));
      },
    });
  } catch (error: unknown) {
    if (signal?.aborted === true) return MEDIA_CANCELLED_RESULT;
    logger.error(`Error describing chat media (kind=${kind}):`, error);
    return { ok: false, retryable: false };
  }
}
