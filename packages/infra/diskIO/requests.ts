/** Disk I/O 主线程逐请求通道：发号、超时、投递与回执结算。 */

import {
  DISK_IO_REQUEST_CHANNELS,
  blocklistIdPageReadRequests,
  identityPolicyReadRequests,
  joinLogReadRequests,
  luckSecretRequests,
} from "../../cache/main/diskIO";
import type { DiskIORequestChannel, PendingDiskIORequest } from "../../cache/main/diskIO";
import type {
  DiskIORequestMessage,
  EnsureLuckSecretRequest,
  ReadBlocklistIdPageRequest,
  ReadIdentityPoliciesRequest,
  ReadJoinLogRequest,
} from "../../types/diskIO/messages";
import type { JoinLogRecord, LuckReceiptSecret } from "../../types/diskIO/storage";
import type { IdentityPolicyRawReadResult } from "../../types/identityStorage";
import type { BlocklistIdPage } from "../../types/identityStorage";
import { safePostDiskIO } from "./transport";

/** 结算一条通道上的全部等待者；Worker 代际失效与 terminate 共用。 */
export function rejectPendingDiskIORequests<TResult>(
  channel: DiskIORequestChannel<TResult>,
  error: Error
): void {
  for (const pending of channel.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  channel.pending.clear();
}

/** 一次结算全部通道；漏掉任何一类等待者都会让调用方干等到自己的超时。 */
export function rejectAllPendingDiskIORequests(describe: (label: string) => string): void {
  for (const channel of DISK_IO_REQUEST_CHANNELS) {
    rejectPendingDiskIORequests(channel, new Error(describe(channel.label)));
  }
}

interface RequestDiskIOParams<TResult, TRequest extends DiskIORequestMessage> {
  worker: Worker;
  channel: DiskIORequestChannel<TResult>;
  timeoutMs: number;
  /** 用通道发出的 requestId 组装信封；调用方不自行编号。 */
  buildRequest: (requestId: number) => TRequest;
  /** 覆盖文案里的领域名；恢复握手用它区分「恢复期的那一次请求」。 */
  context?: string;
}

/**
 * main -> diskIO 的统一 request/reply 发起点：发号、登记等待者、装超时、投递，
 * 同步拒收时立刻摘除并结算等待者。四个领域只提供信封与文案。
 */
function requestDiskIO<TResult, TRequest extends DiskIORequestMessage>({
  worker,
  channel,
  timeoutMs,
  buildRequest,
  context,
}: RequestDiskIOParams<TResult, TRequest>): Promise<TResult> {
  const label: string = context ?? channel.label;
  const requestId: number = channel.nextRequestId++;
  return new Promise((
    resolve: (value: TResult | PromiseLike<TResult>) => void,
    reject: (reason?: unknown) => void
  ): void => {
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      channel.pending.delete(requestId);
      reject(new Error(`[diskIO] ${label} request timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    channel.pending.set(requestId, { resolve, reject, timer });
    if (safePostDiskIO(worker, buildRequest(requestId), `${label} request`)) return;
    channel.pending.delete(requestId);
    clearTimeout(timer);
    reject(new Error(`[diskIO] persistence Worker rejected the ${label} request.`));
  });
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
  const pending: PendingDiskIORequest<TResult> | undefined = channel.pending.get(requestId);
  if (pending === undefined) return;
  channel.pending.delete(requestId);
  clearTimeout(pending.timer);
  if (error !== undefined || payload === undefined) {
    pending.reject(new Error(error ?? channel.missingPayload));
    return;
  }
  pending.resolve(payload);
}

/**
 * 向指定代际请求运势密钥。公开入口与恢复 scoped transport 共用同一套 waiter
 * 记账，Worker 崩溃或恢复失败时由宿主统一拒绝。
 */
export interface RequestLuckSecretParams {
  worker: Worker;
  day: string;
  timeoutMs: number;
  context: string;
}

export function requestLuckSecretFromWorker({
  worker,
  day,
  timeoutMs,
  context,
}: RequestLuckSecretParams): Promise<LuckReceiptSecret> {
  return requestDiskIO<LuckReceiptSecret, EnsureLuckSecretRequest>({
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

/** 向当前可写代际按需读取本群滚动时间窗内的入群日志。 */
export interface RequestJoinLogParams {
  worker: Worker;
  chatId: number;
  since: number;
  now: number;
  timeoutMs: number;
}

export function requestJoinLogFromWorker({
  worker,
  chatId,
  since,
  now,
  timeoutMs,
}: RequestJoinLogParams): Promise<readonly JoinLogRecord[]> {
  return requestDiskIO<readonly JoinLogRecord[], ReadJoinLogRequest>({
    worker,
    channel: joinLogReadRequests,
    timeoutMs,
    buildRequest: (requestId: number): ReadJoinLogRequest => ({
      type: "readJoinLog",
      requestId,
      chatId,
      since,
      now,
    }),
  });
}

/** 向当前 Disk I/O 代际批量读取永久策略与临时白名单累计表。 */
export interface RequestIdentityPoliciesParams {
  worker: Worker;
  ids: readonly number[];
  timeoutMs: number;
}

export function requestIdentityPoliciesFromWorker({
  worker,
  ids,
  timeoutMs,
}: RequestIdentityPoliciesParams): Promise<IdentityPolicyRawReadResult> {
  return requestDiskIO<IdentityPolicyRawReadResult, ReadIdentityPoliciesRequest>({
    worker,
    channel: identityPolicyReadRequests,
    timeoutMs,
    buildRequest: (requestId: number): ReadIdentityPoliciesRequest => ({
      type: "readIdentityPolicies",
      requestId,
      ids,
    }),
  });
}

/** 向当前 Disk I/O 代际按稳定主键游标读取一页黑名单。 */
export function requestBlocklistIdPageFromWorker(
  worker: Worker,
  afterId: number | null,
  timeoutMs: number
): Promise<BlocklistIdPage> {
  return requestDiskIO<BlocklistIdPage, ReadBlocklistIdPageRequest>({
    worker,
    channel: blocklistIdPageReadRequests,
    timeoutMs,
    buildRequest: (requestId: number): ReadBlocklistIdPageRequest => ({
      type: "readBlocklistIdPage",
      requestId,
      afterId,
    }),
  });
}
