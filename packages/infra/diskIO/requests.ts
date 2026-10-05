/** Disk I/O 主线程逐请求通道：投递、结局解包与回执结算，等待表机制见 libs/workerRequestTable.ts。 */

import {
  DISK_IO_REQUEST_CHANNELS,
  luckSecretRequests,
} from "../../cache/main/diskIO";
import type { DiskIORequestChannel } from "../../cache/main/diskIO";
import { beginWorkerRequest, failAllWorkerRequests, settleWorkerRequest } from "../../libs/workerRequestTable";
import { DISK_IO_REQUEST_REJECTED, DISK_IO_REQUEST_TIMED_OUT } from "../../consts/diskIO/common";
import type { DiskIORequestMessage, EnsureLuckSecretRequest } from "../../types/diskIO/messages";
import type { DiskIORequestOutcome } from "../../types/diskIO/replies";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";
import { safePostDiskIO } from "./transport";

/** 一次结算全部通道；漏掉任何一类等待者都会让调用方干等到自己的超时。 */
export function rejectAllPendingDiskIORequests(describe: (label: string) => string): void {
  for (const channel of DISK_IO_REQUEST_CHANNELS) {
    failAllWorkerRequests<DiskIORequestOutcome<never>>(channel.table, {
      ok: false,
      failure: "error",
      message: describe(channel.label),
    });
  }
}

/** requestDiskIO 的入参。 */
export interface RequestDiskIOParams<TResult> {
  worker: Worker;
  channel: DiskIORequestChannel<TResult>;
  timeoutMs: number;
  /** 用等待表发出的 requestId 组装信封；调用方不自行编号。 */
  buildRequest: (requestId: number) => DiskIORequestMessage;
  /** 覆盖文案里的领域名；恢复握手用它区分「恢复期的那一次请求」。 */
  context?: string;
}

/**
 * main -> diskIO 的统一 request/reply 发起点：登记等待者、装超时、投递，同步拒收时
 * 立刻结算。失败结局在这里按领域名组装成 Error 抛给调用方。
 */
export async function requestDiskIO<TResult>({
  worker,
  channel,
  timeoutMs,
  buildRequest,
  context,
}: RequestDiskIOParams<TResult>): Promise<TResult> {
  const label: string = context ?? channel.label;
  const outcome: DiskIORequestOutcome<TResult> = await beginWorkerRequest<DiskIORequestOutcome<TResult>>({
    table: channel.table,
    timeoutMs,
    post: (requestId: number): boolean => safePostDiskIO(worker, buildRequest(requestId), `${label} request`),
    timedOut: DISK_IO_REQUEST_TIMED_OUT,
    rejected: DISK_IO_REQUEST_REJECTED,
  });
  if (outcome.ok) return outcome.value;
  switch (outcome.failure) {
    case "timedOut":
      throw new Error(`[diskIO] ${label} request timed out after ${timeoutMs}ms.`);
    case "rejected":
      throw new Error(`[diskIO] persistence Worker rejected the ${label} request.`);
    case "error":
      throw new Error(outcome.message);
  }
}

interface SettleDiskIOReplyParams<TResult> {
  channel: DiskIORequestChannel<TResult>;
  requestId: number;
  /** Worker 明确报出的领域错误；缺席才看载荷。 */
  error: string | undefined;
  /** 已经收窄成本通道结果类型的载荷；缺席按失败结算。 */
  payload: TResult | undefined;
}

/**
 * 用一条回执结算对应等待者。迟到、重复或已超时的 requestId 一律忽略；
 * Worker 明确报错或没带载荷时按失败结算，绝不把「没读到」解释成空结果。
 */
export function settleDiskIOReply<TResult>({
  channel,
  requestId,
  error,
  payload,
}: SettleDiskIOReplyParams<TResult>): void {
  settleWorkerRequest<DiskIORequestOutcome<TResult>>(
    channel.table,
    requestId,
    error !== undefined || payload === undefined
      ? { ok: false, failure: "error", message: error ?? channel.missingPayload }
      : { ok: true, value: payload }
  );
}

/** requestLuckSecretFromWorker 的入参。 */
export interface RequestLuckSecretParams {
  worker: Worker;
  day: string;
  timeoutMs: number;
  context: string;
}

/**
 * 向指定代际请求运势密钥。公开入口与恢复 scoped transport 共用同一套 waiter
 * 记账，Worker 崩溃或恢复失败时由宿主统一拒绝。
 */
export function requestLuckSecretFromWorker({
  worker,
  day,
  timeoutMs,
  context,
}: RequestLuckSecretParams): Promise<LuckReceiptSecret> {
  return requestDiskIO<LuckReceiptSecret>({
    worker,
    channel: luckSecretRequests,
    timeoutMs,
    context,
    buildRequest: (requestId: number): EnsureLuckSecretRequest => ({
      type: "ensureLuckSecret",
      requestId,
      day,
    }),
  });
}
