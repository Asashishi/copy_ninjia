/**
 * /block 黑名单的落盘逻辑：文件是一个顶层 JSON 对象
 * { "<userId>": { "isBlocked": true, "blockedAt": "2026/07/25 19:38:09" }, ... }，
 * 位于 config/blocklist.json（见 consts/paths.ts）。写入方式与日志一致——复用
 * appendOnlyDayFile.ts 的按位置追加，只覆写结尾的「\n}」，不整文件重写；
 * 差别是黑名单只有一个固定文件，不按天滚动，也永不过期清理。
 *
 * 时序由主线程定：先更新内存 Map（cache/blocklist.ts），再投递本消息追加落盘。
 * 因此内存永远不落后于磁盘；反过来若先落盘再更新内存，两步之间进来的入群
 * 更新就会漏踢。
 *
 * 拉黑是低频且关键的操作，这里不做合并窗口：收到消息立即追加。写盘失败时
 * 条目留在 blocklistPendingEntries 里，由下一次拉黑或停机前的统一 flush 重试。
 *
 * 解除拉黑（/unblock）走另一条路：追加型文件删不掉已有条目，只能把主线程
 * 删除后的完整内存 Map 整份原子重写回来（rewriteBlocklist）。因此本文件读回
 * 的必须是完整记录而不只是「在不在」——降级成 true 再重写，会把名单里其他
 * 人的 blockedAt 一起抹平。
 */

import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { BlockUserDiskMessage, UnblockUserDiskMessage } from "../../types/diskIO";
import type { AppendOnlyFileState, BlockedUserRecord } from "../../types/diskIO/storage";
import { BLOCKLIST_FILE_PATH, RUNTIME_CONFIG_DIR, TMP_FILE_SUFFIX } from "../../consts/paths";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { DAY_FILE_JSON_INDENT } from "../../consts/diskIO/appendOnly";
import { atomicWriteTextSync } from "../../libs/atomicFile";
import {
  blocklistFileState,
  blocklistKnownIds,
  blocklistPendingEntries,
  blocklistPendingRewrite,
  resetBlocklistCache,
} from "../../cache/diskIO/blocklist";
import {
  AppendOnlyFileFormatError,
  appendToAppendOnlyFile,
  openAppendOnlyFile,
  serializeDayFileEntry,
} from "./appendOnlyDayFile";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * 逐条校验黑名单文件的领域 schema。key 必须是能还原成整数的用户 id，value
 * 必须是 `{ isBlocked: true, blockedAt: string }`。任何一条不合规都整体抛错：
 * 黑名单是安全边界，宁可拒绝启动也不能静默丢掉几条记录继续跑——被漏掉的
 * 那个人会因此重新进群。
 */
function decodeBlocklist(parsed: unknown): Map<number, BlockedUserRecord> {
  if (!isRecord(parsed)) {
    throw new AppendOnlyFileFormatError(BLOCKLIST_FILE_PATH, "must contain a top-level JSON object.");
  }
  const blocked: Map<number, BlockedUserRecord> = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    const userId: number = Number(key);
    // 必须原样还原：Number 会吞下 "0x1f4"/"1e3"/"7.0"/"" 这些形态，它们都是
    // 安全整数，却和键面上的文本对不上——手工编辑时多敲一个字符就会静默
    // 拉黑另一个 id，而真正想拉黑的那个人根本不在名单里。
    if (!Number.isSafeInteger(userId) || String(userId) !== key) {
      throw new AppendOnlyFileFormatError(BLOCKLIST_FILE_PATH, `contains a non-numeric user id key ${key}.`);
    }
    if (!isRecord(value) || value.isBlocked !== true || typeof value.blockedAt !== "string") {
      throw new AppendOnlyFileFormatError(BLOCKLIST_FILE_PATH, `contains an invalid block record for key ${key}.`);
    }
    // 整条记录原样带回，不降级成 true：/unblock 要把主线程那份内存 Map 整份
    // 重写回文件，只留「在不在」的话，重写会把其他人的 blockedAt 一起抹平。
    blocked.set(userId, { isBlocked: true, blockedAt: value.blockedAt });
  }
  return blocked;
}

/**
 * 清掉本文件原子写被中断留下的临时文件。config/ 与其它落盘目录不同——它同时
 * 放着手工维护的 mood/stickers/reactions，因此只认自己这个文件名前缀，绝不
 * 按后缀无差别清扫。
 */
function sweepOrphanedBlocklistTemps(): void {
  const prefix: string = `.${basename(BLOCKLIST_FILE_PATH)}.`;
  for (const name of readdirSync(RUNTIME_CONFIG_DIR)) {
    if (!name.startsWith(prefix) || !name.endsWith(TMP_FILE_SUFFIX)) continue;
    try {
      unlinkSync(join(RUNTIME_CONFIG_DIR, name));
    } catch (error: unknown) {
      console.error(`[diskIOWorker] failed to remove orphaned blocklist temp file ${name}:`, error);
    }
  }
}

/**
 * 启动恢复：建目录、清孤儿临时文件、打开黑名单文件、逐条解码校验，返回给
 * 主线程用于重建 Map<number, true>。文件不存在时返回空表——那只是还没有人
 * 被拉黑过，不是异常。
 *
 * 与日志/运势/待验证不同，这里明确禁用截断自愈（repair=false）：那三者丢掉
 * 末尾几条不影响正确性，黑名单少一条就等于放一个人回群，宁可整体拒绝启动
 * 等人工恢复（见 docs/04-invariants.md）。
 */
export function hydrateBlocklist(): Map<number, BlockedUserRecord> {
  resetBlocklistCache();
  mkdirSync(RUNTIME_CONFIG_DIR, { recursive: true });
  sweepOrphanedBlocklistTemps();
  const state: AppendOnlyFileState = openAppendOnlyFile(BLOCKLIST_FILE_PATH, PERSISTED_FILE_MODE, false);
  blocklistFileState.current = state;
  if (state.empty) return new Map();
  const blocked: Map<number, BlockedUserRecord> = decodeBlocklist(JSON.parse(readFileSync(BLOCKLIST_FILE_PATH, "utf8")));
  for (const userId of blocked.keys()) blocklistKnownIds.add(userId);
  return blocked;
}

/**
 * 按主线程送来的完整名单整文件重写。/unblock 走这条路：追加型文件删不掉
 * 已有条目，唯一的办法是把删除后的内存 Map 整份写回去。
 *
 * 写入用 tmp + fsync + rename，与 openAppendOnlyFile 的维护性重写同一套原子
 * 语义——重写被杀一半会留下撕裂 JSON，而这个文件明确禁止截断自愈，撕裂就是
 * 拒绝启动。重写完必须重置追加游标与已知 id：文件长度变了，旧游标指向的
 * 位置不再是结尾的「\n}」，照着它继续追加会把 JSON 写坏。待追加缓冲也一并
 * 丢弃——那些条目已经在本次全量内容里了（主线程 Map 是它们的超集）。
 */
export function rewriteBlocklist(records: Map<number, BlockedUserRecord>): boolean {
  const content: Record<string, BlockedUserRecord> = {};
  // 键按 id 升序，让人工核对文件时顺序稳定，也让重写结果可复现。
  const userIds: number[] = [...records.keys()].sort((a: number, b: number): number => a - b);
  for (const userId of userIds) content[String(userId)] = records.get(userId)!;
  try {
    // 不在这里建目录：hydrateBlocklist 启动时已经建过，而追加路径同样不建。
    // 重写若因为目录不在而失败，那是真的失败，不该被一次 mkdir 掩盖过去。
    atomicWriteTextSync(
      BLOCKLIST_FILE_PATH,
      JSON.stringify(content, null, DAY_FILE_JSON_INDENT),
      PERSISTED_FILE_MODE
    );
  } catch (error: unknown) {
    // 游标作废：重写可能已经换掉了文件，旧位置不可信。这份快照必须单独记下来
    // ——删除只能靠重写表达，追加缓冲里是空的，不记的话 flush 会直接报成功，
    // 于是 /unblock 告诉管理员「划掉了」而文件里那条还在。
    blocklistFileState.current = null;
    blocklistPendingRewrite.current = new Map(records);
    console.error("[diskIOWorker] failed to rewrite the blocklist file:", error);
    return false;
  }
  blocklistPendingRewrite.current = null;
  blocklistPendingEntries.length = 0;
  blocklistKnownIds.clear();
  for (const userId of userIds) blocklistKnownIds.add(userId);
  // 重新探测而不是凭内容长度推算 size：以物理文件大小为准是本机制的一贯要求。
  blocklistFileState.current = openAppendOnlyFile(BLOCKLIST_FILE_PATH, PERSISTED_FILE_MODE, false);
  return true;
}

/** 处理一条解除拉黑消息：按主线程送来的完整名单整文件重写。 */
export function handleUnblockUserMessage(msg: UnblockUserDiskMessage): void {
  rewriteBlocklist(new Map(msg.blocked));
}

/** 把缓冲中的条目一次性追加落盘；成功后清空缓冲。 */
export function flushBlocklistAppends(): boolean {
  // 没落地的整份重写先补上：它是「删除」的唯一载体，追加补不回来，而且它
  // 失败时追加缓冲是空的——不在这里拦一道，本轮 flush 会假报成功。
  if (blocklistPendingRewrite.current !== null && !rewriteBlocklist(blocklistPendingRewrite.current)) {
    return false;
  }
  if (blocklistPendingEntries.length === 0) return true;
  const entries: string[] = [...blocklistPendingEntries];
  try {
    // 上一次追加失败会把游标置 null；重新打开时重新校验文件形态，但同样
    // 不允许截断自愈（理由见 hydrateBlocklist）。
    blocklistFileState.current ??= openAppendOnlyFile(BLOCKLIST_FILE_PATH, PERSISTED_FILE_MODE, false);
    appendToAppendOnlyFile({
      path: BLOCKLIST_FILE_PATH,
      state: blocklistFileState.current,
      chunk: entries.join(",\n"),
      mode: PERSISTED_FILE_MODE,
      repair: false,
    });
    blocklistPendingEntries.length = 0;
    return true;
  } catch (error: unknown) {
    // 条目留在缓冲里等下次重试；游标作废，下次写入前重新校验文件。
    blocklistFileState.current = null;
    console.error("[diskIOWorker] failed to append blocklist entries:", error);
    return false;
  }
}

/** 处理一条拉黑消息：记账、序列化进缓冲，随即立即落盘。 */
export function handleBlockUserMessage(msg: BlockUserDiskMessage): void {
  if (blocklistKnownIds.has(msg.userId)) return;
  blocklistKnownIds.add(msg.userId);
  const record: BlockedUserRecord = { isBlocked: true, blockedAt: msg.blockedAt };
  // 有整份重写还没落地：这条必须并进那份快照，不能只走追加。否则重试重写时
  // 用的还是旧快照，刚拉黑的这个人会被直接挤掉——名单里没有他，而主线程
  // 以为有。
  if (blocklistPendingRewrite.current !== null) {
    blocklistPendingRewrite.current.set(msg.userId, record);
    rewriteBlocklist(blocklistPendingRewrite.current);
    return;
  }
  blocklistPendingEntries.push(serializeDayFileEntry(String(msg.userId), record));
  flushBlocklistAppends();
}
