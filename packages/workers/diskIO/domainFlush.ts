/**
 * Disk I/O Worker 按领域与 scope 的统一 flush：各领域缓冲立即落盘，失败按领域回报。
 * 回执出口由调用方（diskIOWorker.ts）传入。所属线程：Disk I/O Worker；本模块不持有缓存。
 */

import { flushAdSampleBuffer } from "./adSampleFile";
import { collectStorageDatabaseFailures, flushStorageDatabase } from "./storageDatabase";
import { flushLogBuffer } from "./logFiles";
import { flushAiCacheBuffer } from "./aiCacheFile";
import { flushLuckAppends } from "./luckFiles";
import { flushJoinLogBuffer } from "./joinLogFiles";
import { purgeJoinLogDeletions } from "./joinLogRecovery";
import { flushVerificationChanges } from "./verificationWrites";
import { flushStickerCatalogs } from "./stickerCatalogFiles";
import { flushWedMemberFiles } from "./wedMemberFiles";
import { takeVerificationWriteRejection } from "../../cache/workers/diskIO/verification";
import type { DiskFlushScope } from "../../types/diskIO/messages";
import type { DiskIODomain, DiskIOReply } from "../../types/diskIO/replies";

/**
 * 把单个领域的缓冲立即落盘，失败时把该领域记进 failedDomains。各自的窗口阈值在这里
 * 不生效，不论是否攒够条数/等够时间都立即刷。共享 SQLite 的各领域（含 AI 上下文）
 * 共用一个事务，经任一领域名提交一次即覆盖全部表，但只取走并回报这一个领域的失败；
 * all/business 由 flushScope 一次回报全部领域。
 */
async function flushDomain(
  domain: DiskIODomain,
  failedDomains: DiskIODomain[],
  reply: (reply: DiskIOReply) => void
): Promise<void> {
  switch (domain) {
    case "log":
      if (!await flushLogBuffer()) failedDomains.push("log");
      return;
    case "stickerCatalog":
      if (!flushStickerCatalogs()) failedDomains.push("stickerCatalog");
      return;
    case "wedMembers":
      if (!flushWedMemberFiles()) failedDomains.push("wedMembers");
      return;
    case "luck":
      if (!await flushLuckAppends()) failedDomains.push("luck");
      return;
    case "verification": {
      const rejected: boolean = takeVerificationWriteRejection();
      if (!await flushVerificationChanges(reply) || rejected) failedDomains.push("verification");
      return;
    }
    case "whitelist":
    case "blocklist":
    case "temporaryAdBypass":
    case "blocklistRemovalOutbox":
    case "chatState":
    case "chatQa":
    case "aiMemory":
      flushStorageDatabase(reply);
      collectStorageDatabaseFailures(domain, failedDomains);
      return;
    case "joinLog":
      if (!await flushJoinLogBuffer()) failedDomains.push("joinLog");
      return;
    case "joinLogPurge":
      // 整群删除单独占一格，与入群追写分开判定（见 types/diskIO/replies.ts 的 DiskIODomain）。
      if (!purgeJoinLogDeletions()) failedDomains.push("joinLogPurge");
      return;
    default: {
      // 穷尽性断言：新增领域时这一行编译失败，必须在本 switch 里点名它的 flush 出口。
      const unhandled: never = domain;
      void unhandled;
    }
  }
}

/**
 * 按 scope 执行 flush（范围语义见 types/diskIO/messages.ts 的 DiskFlushScope），由
 * diskIOWorker.ts 的 flush 消息调用。单领域屏障只刷该领域；`all` 与 `business` 依次刷出
 * 全部业务领域，并刷出 AI 缓存用量统计与广告样本两类旁路数据，旁路失败不进回执。
 */
export async function flushScope(
  scope: DiskFlushScope,
  reply: (reply: DiskIOReply) => void
): Promise<readonly DiskIODomain[]> {
  const failedDomains: DiskIODomain[] = [];
  if (scope !== "all" && scope !== "business") {
    await flushDomain(scope, failedDomains, reply);
    return failedDomains;
  }
  // 不短路：即使前一领域失败，其余领域仍必须获得本轮落盘机会。
  if (scope === "all") await flushDomain("log", failedDomains, reply);
  // 旁路统计与样本：照常刷出，失败只丢这一批并由各自模块记 console.error，
  // 不计入失败领域。
  await flushAiCacheBuffer();
  await flushAdSampleBuffer();
  await flushDomain("stickerCatalog", failedDomains, reply);
  await flushDomain("wedMembers", failedDomains, reply);
  await flushDomain("luck", failedDomains, reply);
  await flushDomain("verification", failedDomains, reply);
  // 共享 SQLite 事务一次提交全部表与 AI 上下文，并取走全部领域的拒收标记。
  flushStorageDatabase(reply);
  collectStorageDatabaseFailures(null, failedDomains);
  await flushDomain("joinLog", failedDomains, reply);
  await flushDomain("joinLogPurge", failedDomains, reply);
  // 失败按领域列出，调用方只按自己等待的领域判定；各领域的写盘错误只进 console.error。
  return failedDomains;
}
