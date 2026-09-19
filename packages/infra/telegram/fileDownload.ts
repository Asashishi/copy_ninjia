/**
 * 主线程的 Telegram 文件下载：getFile 取路径，再经 download 类出站闸把文件读进有界内存。
 * Worker 代理的媒体下载、头像下载与 `/h_image add` 收图共用这一处；不创建本地文件。
 */

import { signalWithTimeout } from "../../libs/abortSignal";
import { readBoundedResponseBytes } from "../../libs/boundedResponse";
import type { BoundedResponseResult } from "../../libs/boundedResponse";
import type { TelegramFileDownloadResult } from "../../types/telegram";
import { bot } from "./mainClient";
import type { HydratedTelegramFile } from "./mainClient";
import { runTelegramCategorizedRequest } from "./outboundGate";

/** downloadTelegramFileBytes 的入参。 */
export interface DownloadTelegramFileParams {
  readonly fileId: string;
  /** 读到超过这个字节数即停下并报 tooLarge。 */
  readonly maxBytes: number;
  /** getFile 自己的超时；与下载分开计时，前者排 429 队列不会吃掉后者的预算。 */
  readonly metadataTimeoutMs: number;
  /** 下载请求从发出到读完的超时。 */
  readonly downloadTimeoutMs: number;
  /** 调用方的取消信号；两段超时都合入它。 */
  readonly signal: AbortSignal | undefined;
}

/**
 * 下载一个 Telegram 文件到有界内存。getFile 与下载抛出的异常（含取消与超时）原样上抛，
 * 由调用方按自己的语义归类；非 2xx 响应不读错误页，并显式释放响应体。
 */
export async function downloadTelegramFileBytes({
  fileId,
  maxBytes,
  metadataTimeoutMs,
  downloadTimeoutMs,
  signal,
}: DownloadTelegramFileParams): Promise<TelegramFileDownloadResult> {
  const file: HydratedTelegramFile = await bot.api.getFile(
    fileId,
    signalWithTimeout(signal, metadataTimeoutMs) as never
  );
  if (!file.file_path) return { status: "missingPath" };
  const response: Response = await runTelegramCategorizedRequest({
    category: "download",
    signal: signalWithTimeout(signal, downloadTimeoutMs),
    execute: (requestSignal: AbortSignal): Promise<Response> => fetch(file.getUrl(), {
      redirect: "error",
      signal: requestSignal,
    }),
  });
  if (!response.ok) {
    void response.body?.cancel().catch((): undefined => undefined);
    return { status: "httpError", httpStatus: response.status };
  }
  const download: BoundedResponseResult = await readBoundedResponseBytes(response, maxBytes);
  if (!download.ok) return { status: "tooLarge", observedBytes: download.observedBytes };
  if (download.bytes.byteLength === 0) return { status: "empty" };
  return { status: "ok", bytes: download.bytes };
}
