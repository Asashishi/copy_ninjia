import {
  AVATAR_FETCH_MAX_ATTEMPTS,
  AVATAR_FETCH_TIMEOUT_MS,
  AVATAR_MAX_DOWNLOAD_BYTES,
} from "../../../consts/telegram";
import { signalWithTimeout } from "../../../libs/abortSignal";
import { discardResponseBody, readBoundedResponseBytes } from "../../../libs/boundedResponse";
import type { BoundedResponseResult } from "../../../libs/boundedResponse";
import { sniffImageFormat } from "../../image";
import type { SniffedImageFormat } from "../../image";
import { redactUrlForLog } from "../../../libs/redaction";
import { logger } from "../../logger";
import { logApiError } from "../client";
import { runTelegramCategorizedRequest } from "../outboundGate";
import { avatarFailureFor, runAvatarFetchAttempts, setBotProfilePhoto } from "./shared";
import type {
  AvatarFetchAttemptsOutcome,
  AvatarOperationAttemptResult,
} from "./shared";
import type { DefaultAvatarSource } from "../../../types/config";

/** 取默认头像字节的一次结果：可上传的 JPEG/PNG 字节，或已记过日志的失败分类。 */
type DefaultAvatarBytes = Uint8Array | "transient-failure" | "permanent-failure";

/**
 * 按配置来源恢复机器人默认头像；调用方在主线程 copy/avatarQueue.ts 读取素材配置。
 *
 * `url` 来源允许配置的 HTTP/HTTPS 地址并跟随重定向。请求进入主线程 download 类
 * 出站闸，等待与 429 重放共用本次下载的超时预算，取消信号传到实际 fetch。
 * `path` 来源每次尝试都重新读取经 config/assets.ts 校验的绝对路径；读取失败不重试。
 *
 * 两种来源都按 AVATAR_MAX_DOWNLOAD_BYTES 有界读取，并在上传前校验 JPEG/PNG 签名。
 * runAvatarFetchAttempts 仅对瞬时失败执行有界重试；超限、非图片和 Telegram 400
 * 属确定性失败。跨模块约束见 docs/cn/04-invariants.md 的「出站请求与消息安全」。
 * @returns 恢复成功为 true；读取、校验或上传失败以及取消为 false。
 */
export async function restoreDefaultProfilePhoto(
  source: Readonly<DefaultAvatarSource>,
  signal?: AbortSignal
): Promise<boolean> {
  const outcome: AvatarFetchAttemptsOutcome = await runAvatarFetchAttempts(
    (attempt: number): Promise<AvatarOperationAttemptResult> =>
      attemptRestoreDefaultProfilePhoto(source, attempt, signal),
    signal
  );
  return outcome === "ok";
}

/** 单次「取默认头像并换上」的尝试；失败按可否重试分类，日志已在各分支记过。 */
async function attemptRestoreDefaultProfilePhoto(
  source: Readonly<DefaultAvatarSource>,
  attempt: number,
  signal?: AbortSignal
): Promise<AvatarOperationAttemptResult> {
  const label: string = source.kind === "url" ? redactUrlForLog(source.url) : source.path;
  try {
    const bytes: DefaultAvatarBytes = source.kind === "url"
      ? await downloadDefaultAvatar(source.url, attempt, signal)
      : await readDefaultAvatarFile(source.path);
    if (typeof bytes === "string") return bytes;
    await setBotProfilePhoto(bytes, signal);
    return "ok";
  } catch (error: unknown) {
    if (signal?.aborted) return "permanent-failure";
    logApiError(`restore default profile photo from ${label} (attempt ${attempt}/${AVATAR_FETCH_MAX_ATTEMPTS})`, error);
    return avatarFailureFor(error);
  }
}

/** 下载 `url` 来源：429 由统一出站闸重放，其余非 2xx 属瞬时失败；超限与非图片不重试。 */
async function downloadDefaultAvatar(url: string, attempt: number, signal?: AbortSignal): Promise<DefaultAvatarBytes> {
  const response: Response = await runTelegramCategorizedRequest({
    category: "download",
    signal: signalWithTimeout(signal, AVATAR_FETCH_TIMEOUT_MS),
    execute: (requestSignal: AbortSignal): Promise<Response> => fetch(url, {
      redirect: "follow",
      signal: requestSignal,
    }),
  });
  if (!response.ok) {
    void discardResponseBody(response);
    logger.error(`Failed to download the default avatar (${response.status}) from ${redactUrlForLog(url)} (attempt ${attempt}/${AVATAR_FETCH_MAX_ATTEMPTS})`);
    return "transient-failure";
  }
  const download: BoundedResponseResult = await readBoundedResponseBytes(response, AVATAR_MAX_DOWNLOAD_BYTES);
  if (!download.ok) {
    logger.error(`The default avatar at ${redactUrlForLog(url)} exceeded the download limit (${download.observedBytes} bytes)`);
    return "permanent-failure";
  }
  const format: SniffedImageFormat = sniffImageFormat(download.bytes);
  if (format !== "jpeg" && format !== "png") {
    logger.error(
      `The default avatar link ${redactUrlForLog(url)} did not return a JPEG or PNG image ` +
      `(sniffed=${format}, bytes=${download.bytes.byteLength}); it must serve raw image bytes ` +
      "rather than an HTML page such as a login, quota or virus-scan interstitial"
    );
    return "permanent-failure";
  }
  return download.bytes;
}

/**
 * 读 `path` 来源：最多读 AVATAR_MAX_DOWNLOAD_BYTES 加一个字节。读不到、超限与非 JPEG/PNG
 * 都属确定性失败。
 */
async function readDefaultAvatarFile(path: string): Promise<DefaultAvatarBytes> {
  let bytes: Uint8Array;
  try {
    bytes = await Bun.file(path).slice(0, AVATAR_MAX_DOWNLOAD_BYTES + 1).bytes();
  } catch (error: unknown) {
    logger.error(`Failed to read the default avatar file ${path}:`, error);
    return "permanent-failure";
  }
  if (bytes.byteLength > AVATAR_MAX_DOWNLOAD_BYTES) {
    logger.error(`The default avatar file ${path} exceeds the size limit (${AVATAR_MAX_DOWNLOAD_BYTES} bytes)`);
    return "permanent-failure";
  }
  const format: SniffedImageFormat = sniffImageFormat(bytes);
  if (format !== "jpeg" && format !== "png") {
    logger.error(
      `The default avatar file ${path} is not a JPEG or PNG image (sniffed=${format}, bytes=${bytes.byteLength})`
    );
    return "permanent-failure";
  }
  return bytes;
}
