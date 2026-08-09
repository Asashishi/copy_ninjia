/**
 * 群聊媒体的异步解析入口，四种媒体共用：图片/贴纸/GIF 走视觉描述（下载 Telegram
 * 文件，按需转码成视觉接口通吃的 jpg/png，见 libs/image.ts），语音走转写（原样把
 * 音频字节交给语音接口，见 aiChat/ai/voiceTranscription.ts）。产出供
 * workers/aiChat/mediaIngest.ts 的 recordChatMedia 把对话缓存里的占位文本替换掉，
 * 视觉那条同时供 aiChat/ai/stickers/catalog.ts 生成机器人自己贴纸目录的描述条目。
 * 跑在 AI Worker 线程里（调用方就是它）。
 *
 * 四种媒体共用这一个入口是有代价换来的：**去重缓存、有界执行器、占位→回填时序
 * 只有一份**。语音另起一条并行管线的话，同一份媒体的并发合并、容量淘汰、执行槽
 * 竞争就要各写一遍，而那几处的正确性恰恰是最难在测试里覆盖的（见下方
 * transientDescriptionCache 的 peek 注释）。逐媒体的差异只落在
 * resolveMediaUncached 这一个分支上。
 *
 * 失败一律返回 null、绝不抛错——调用方按各自的兜底处理（图片退化成
 * 「[图片]」占位、贴纸退化成原有的元数据行、GIF/语音退化成失败占位），转录里
 * 至少留下痕迹，AI 流水线不因一份媒体挂掉。
 */

import { logger } from "../../infra/logger";
import { mediaAiProvider } from "../provider";
import { sanitizeInline, truncateAtClauseBoundary } from "../../libs/text";
import { transientDescriptionCache } from "../../cache/workers/aiChat/imageDescription";
import {
  clearMediaInputProbe,
  getMediaInputProbe,
  getMediaInputSupport,
  isMediaInputClosed,
  isMediaInputProbeCoolingDown,
  recordMediaInputResult,
  setMediaInputProbe,
} from "../../cache/workers/aiChat/mediaInputSupport";
import {
  IMAGE_DESCRIPTION_MAX_CHARS,
  MEDIA_DESCRIPTION_ERROR_LABEL,
  SHORT_MEDIA_DESCRIPTION_MAX_CHARS,
} from "../../consts/aiChat/media";
import { ANIMATION_DESCRIPTION_PROMPT, IMAGE_DESCRIPTION_PROMPT, STICKER_DESCRIPTION_PROMPT } from "../../consts/aiChat/prompts/media";
import type { MediaKind } from "../../types/media";
import { downloadTelegramVisionImage } from "./telegramImage";
import { runMediaTask } from "./mediaTaskRunner";
import { transcribeVoiceUncached } from "./voiceTranscription";
import type { VisionImage } from "../../types/media";
import type {
  AiTextResult,
  AiProviderTaskPriority,
  MediaInputCapability,
  MediaInputSupport,
} from "../../types/aiChat/provider";

/**
 * 模态已被判定为不可用（明确不支持或端点配置错误）时的共享结果。
 *
 * 不带 mediaFailure：它不是一次新的真实调用的结论，只是把已有结论复述给调用方。
 * 带上去只会让状态机对同一个结论反复落库。retryable=false 让贴纸目录那条路知道
 * 「再采样一次也是同一个结果」。
 */
const MEDIA_CLOSED_RESULT: AiTextResult = { ok: false, retryable: false };

/**
 * 探测退避期内的共享结果。retryable=true：这是端点抖动，不是终局结论，贴纸目录
 * 的定期补跑（retryIncompleteStickerCatalogs）应当在退避到期后重新采样。
 */
const MEDIA_BACKOFF_RESULT: AiTextResult = { ok: false, retryable: true };

/** 执行器拒绝接纳任务时的共享瞬时失败结果。 */
const MEDIA_TASK_REJECTED_RESULT: AiTextResult = { ok: false, retryable: true };

/** 模态不可用时复用同一个已完成 Promise，避免每条后续媒体都分配新 Promise。 */
const MEDIA_CLOSED_PROMISE: Promise<AiTextResult> = Promise.resolve(MEDIA_CLOSED_RESULT);

/** 退避期内复用同一个已完成 Promise，理由同上。 */
const MEDIA_BACKOFF_PROMISE: Promise<AiTextResult> = Promise.resolve(MEDIA_BACKOFF_RESULT);

/** 聊天媒体这一轮不解析时复用的空描述，避免建立临时 LRU 条目与 then 链。 */
const SKIPPED_DESCRIPTION_PROMISE: Promise<string | null> = Promise.resolve(null);

/** 按媒体类型选喂给视觉模型的描述指令，三者风格/侧重点不同。 */
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

/** 按媒体类型选描述入缓存前的截断上限：贴纸/GIF 更短，见
 *  SHORT_MEDIA_DESCRIPTION_MAX_CHARS 注释。语音不走这里，它的上限在
 *  aiChat/ai/voiceTranscription.ts（那是群友原话，不是概括）。 */
function maxCharsFor(kind: MediaKind): number {
  return kind === "photo" ? IMAGE_DESCRIPTION_MAX_CHARS : SHORT_MEDIA_DESCRIPTION_MAX_CHARS;
}

/** describeMedia 的入参。语音专用的两项在其余媒体上分别为 undefined 与 0，
 *  形状约束见 types/aiChat/protocol.ts 的 AiRecordMediaMessage。 */
export interface DescribeMediaParams {
  /** 媒体类型，决定走视觉描述还是语音转写，以及用哪份提示词与长度上限。 */
  kind: MediaKind;
  /**
   * 要下载的 Telegram file_id：图片是本体；贴纸是本体（静态）或缩略图（动态/
   * 视频，见 aiChat/ai/stickers/describe.ts 的 pickStickerVisionSource）；GIF 是
   * 缩略图（本项目无法解码 mp4/gif 抽帧，只能分析封面帧）；语音是本体。
   */
  fileId: string;
  /**
   * 缓存去重键：图片用同档位的 file_unique_id；贴纸/GIF 固定用媒体自身（而非
   * 缩略图）的 file_unique_id，保证同一份贴纸/GIF 无论走本体还是缩略图素材，
   * 描述都记在同一个键下。
   */
  fileUniqueId: string;
  /** 语音的 Telegram 声明容器；其余媒体为 undefined。 */
  voiceMime: string | undefined;
  /** 语音时长（秒）；其余媒体为 0。 */
  voiceDurationSeconds: number;
}

/**
 * 下载并解析一份未命中本地贴纸目录的媒体（带 file_unique_id 临时去重
 * 缓存，见 transientDescriptionCache）。四种媒体共用这份
 * MEDIA_DESCRIPTION_CACHE_MAX 项的 LRU 缓存——键空间不冲突（file_unique_id
 * 本就是 Telegram 全局唯一），且同一份媒体不会同时是两种类型。白名单贴纸
 * 由调用方先查 stickerCatalog 的常驻目录，不会走到这里。
 * @returns 压成单行、截断后的中文描述或语音转写；下载/转码/解析任一步失败则 null。
 */
export function describeMedia(params: DescribeMediaParams): Promise<string | null> {
  const capability: MediaInputCapability = params.kind === "voice" ? "voice" : "vision";
  // 两类跳过都在建立 LRU 条目之前返回：不下载、不排队、也不留下一条注定为 null
  // 的缓存项。退避到期后同一份媒体仍可被下一条消息重新解析。
  if (
    isMediaInputClosed(getMediaInputSupport(capability)) ||
    isMediaInputProbeCoolingDown(capability, Date.now())
  ) {
    return SKIPPED_DESCRIPTION_PROMISE;
  }
  const fileUniqueId: string = params.fileUniqueId;
  const cached: Promise<string | null> | undefined = transientDescriptionCache.get(fileUniqueId);
  if (cached) return cached;

  const pending: Promise<string | null> = resolveMedia(params)
    .then((attempt: AiTextResult): string | null => {
    // 执行槽位和等待队列都满时返回 undefined；按普通解析失败降级，不再
    // 启动下载、转码或视觉 API 请求。
      const result: string | null = attempt?.ok === true ? attempt.text : null;
      // 按引用而非按 key 删，用 peek 而不是 get——不能让这次内部核对被当成
      // 一次真实访问去刷新淘汰顺位。这份 pending 在解析期间可能已经因为超过
      // 容量上限被淘汰、又被新的并发请求重新插入了一份新 pending，此时这里
      // 必须认得出"当前占着这个 key 的不是自己"，不能把新插入的那份连锅
      // 端掉（否则新请求的合并会落空，还会误删一份可能已经解析成功、本该
      // 继续留在缓存里的有效结果）。
      if (result === null && transientDescriptionCache.peek(fileUniqueId) === pending) {
        transientDescriptionCache.delete(fileUniqueId);
      }
      return result;
    });
  // 写入即满足容量上限的淘汰（超容量删最久未使用的一个），见
  // cache/workers/aiChat/imageDescription.ts 的 LruCache 用法。
  transientDescriptionCache.set(fileUniqueId, pending);
  return pending;
}

/**
 * 为白名单贴纸目录生成一条常驻描述。目录自身负责按 file_unique_id 去重、
 * 持久化和线上变更对账，因此这里刻意绕过 transientDescriptionCache 临时
 * 缓存；成功后调用方会立即写入 stickerCatalog，消息记录随后可直接命中
 * 常驻目录。失败结果额外声明目录层能否重新采样：供应商 SDK 已耗尽 HTTP 重试时
 * 禁止再次套完整请求，下载/排队或成功响应正文不可用时则允许。
 */
export function describeMediaForStickerCatalog(fileId: string): Promise<AiTextResult> {
  return runMediaInputRequest(
    "vision",
    (): Promise<AiTextResult> => describeVisionUncached("sticker", fileId, "background")
  );
}

/** 按媒体类型分派到两条解析实现；这是四种媒体在本管线里**唯一**的差异点。 */
function resolveMedia({
  kind,
  fileId,
  voiceMime,
  voiceDurationSeconds,
}: DescribeMediaParams): Promise<AiTextResult> {
  const capability: MediaInputCapability = kind === "voice" ? "voice" : "vision";
  return runMediaInputRequest(
    capability,
    kind === "voice"
      ? (): Promise<AiTextResult> => transcribeVoiceUncached({
        fileId,
        declaredMime: voiceMime,
        durationSeconds: voiceDurationSeconds,
      })
      : (): Promise<AiTextResult> => describeVisionUncached(kind, fileId)
  );
}

/**
 * 把一次真实媒体调用交给有界执行器，并把结果交给模态状态机归因。执行器满载返回
 * 的是不带 mediaFailure 的瞬时失败，不会污染支持度；SDK 自己负责首次请求后的
 * 最多五次 HTTP 重试。
 */
function runTrackedMediaAttempt(
  capability: MediaInputCapability,
  task: () => Promise<AiTextResult>
): Promise<AiTextResult> {
  return runMediaTask(task).then((result: AiTextResult | undefined): AiTextResult => {
    const attempt: AiTextResult = result ?? MEDIA_TASK_REJECTED_RESULT;
    recordMediaInputResult(capability, attempt, Date.now());
    return attempt;
  });
}

/**
 * 媒体请求的准入闸，四条路互斥：
 *
 * 1. 模态已判定不可用（不支持 / 端点配置错误）：复用共享结论，不下载不请求。
 * 2. 在退避窗口内：复用共享瞬时失败，同样不下载、不占执行器槽位。端点持续故障
 *    时这条路挡掉了「每条群媒体各付一次下载 + 一整轮 SDK 重试」。
 * 3. 已确认支持：直接进有界执行器。
 * 4. 尚无结论：**只放行一个**首次真实请求，并发等待者共享它的结果——冷启动时
 *    25 条媒体不会把同一能力并发探测 25 次。探测成功后等待者各自进队列；探测
 *    失败则共享本次失败，退避到期后仍可重新探测，瞬时故障不会被永久锁死。
 */
function runMediaInputRequest(
  capability: MediaInputCapability,
  task: () => Promise<AiTextResult>
): Promise<AiTextResult> {
  const support: MediaInputSupport = getMediaInputSupport(capability);
  if (isMediaInputClosed(support)) return MEDIA_CLOSED_PROMISE;
  if (isMediaInputProbeCoolingDown(capability, Date.now())) return MEDIA_BACKOFF_PROMISE;
  if (support === "supported") return runTrackedMediaAttempt(capability, task);

  const activeProbe: Promise<AiTextResult> | null = getMediaInputProbe(capability);
  if (activeProbe !== null) {
    return activeProbe.then((result: AiTextResult): Promise<AiTextResult> | AiTextResult =>
      result.ok ? runTrackedMediaAttempt(capability, task) : result
    );
  }

  const probe: Promise<AiTextResult> = runTrackedMediaAttempt(capability, task)
    .finally((): void => clearMediaInputProbe(capability, probe));
  setMediaInputProbe(capability, probe);
  return probe;
}

async function describeVisionUncached(
  kind: MediaKind,
  fileId: string,
  priority: AiProviderTaskPriority = "interactive"
): Promise<AiTextResult> {
  try {
    const image: VisionImage | null = await downloadTelegramVisionImage({ fileId, logLabel: `chat media (kind=${kind})` });
    if (!image) return { ok: false, retryable: true };
    return await mediaAiProvider(priority).describeVision({
      prompt: promptFor(kind),
      image,
      errorLabel: MEDIA_DESCRIPTION_ERROR_LABEL,
      normalize: (text: string): string => {
        const description: string = sanitizeInline(text);
        if (!description) return "";
        // 模型超限时收在子句边界而不是硬切——memory/stickers/ 里曾大批量出现
        // 「……以戏谑的口」式断在半句的目录条目，就是硬切造成的。
        return truncateAtClauseBoundary(description, maxCharsFor(kind));
      },
    });
  } catch (error: unknown) {
    logger.error(`Error describing chat media (kind=${kind}):`, error);
    return { ok: false, retryable: false };
  }
}
