import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactVerificationDay,
  flushVerificationChanges,
  handleVerificationDelete,
  handleVerificationUpsert,
  recoverVerificationDay,
} from "../../../src/workers/diskIO/verificationFiles";
import {
  verificationFileState,
  verificationFlushTimer,
  verificationPendingChanges,
  verificationRolloverTimer,
  verificationWorkerCache,
} from "../../../src/cache/diskIOWorker";
import type { VerificationPersistedReply, VerificationSnapshot } from "../../../src/types";
import { VERIFICATION_FILE_COMPACT_BYTES } from "../../../src/consts/diskIO";

const DAY_ONE = "2026-07-19";
const DAY_TWO = "2026-07-20";

let dir: string;
let replies: VerificationPersistedReply[];

function snapshot(revision: number, overrides: Partial<VerificationSnapshot> = {}): VerificationSnapshot {
  return {
    chatId: -1001,
    userId: 42,
    generation: 1,
    revision,
    label: "@pending_user",
    isBot: false,
    messageIds: [10],
    trackedMessageTimes: [1_000],
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: 1_000,
    expiresAt: 121_000,
    ...overrides,
  };
}

const receiveReply = (reply: VerificationPersistedReply): void => {
  replies.push(reply);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verification-day-test-"));
  replies = [];
  verificationWorkerCache.clear();
  verificationPendingChanges.clear();
  verificationFileState.current = null;
  verificationFileState.appendedEntries = 0;
  verificationFileState.appendedBytes = 0;
  if (verificationFlushTimer.timer !== null) clearTimeout(verificationFlushTimer.timer);
  if (verificationRolloverTimer.timer !== null) clearTimeout(verificationRolloverTimer.timer);
  verificationFlushTimer.timer = null;
  verificationRolloverTimer.timer = null;
  // 生产中所有业务消息都晚于 diskIOWorker 的 load 握手；测试同样先接管当天。
  recoverVerificationDay(DAY_ONE, dir);
});

afterEach(() => {
  if (verificationFlushTimer.timer !== null) clearTimeout(verificationFlushTimer.timer);
  if (verificationRolloverTimer.timer !== null) clearTimeout(verificationRolloverTimer.timer);
  verificationFlushTimer.timer = null;
  verificationRolloverTimer.timer = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("pending verification daily append JSON", () => {
  test("新建立即写入，同一 key 高频普通更新只追加窗口内最终快照", () => {
    handleVerificationUpsert({ type: "verificationUpsert", record: snapshot(1), critical: true }, receiveReply, dir, DAY_ONE);
    for (let revision = 2; revision <= 500; revision++) {
      handleVerificationUpsert({
        type: "verificationUpsert",
        record: snapshot(revision, { messageIds: [10, revision] }),
        critical: false,
      }, receiveReply, dir, DAY_ONE);
    }

    expect(verificationPendingChanges.size).toBe(1);
    expect(replies.map((reply) => reply.revision)).toEqual([1]);
    flushVerificationChanges(receiveReply, dir, DAY_ONE);

    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")).toMatchObject({
      revision: 500,
      messageIds: [10, 500],
    });
    expect(replies.map((reply) => reply.revision)).toEqual([1, 500]);
  });

  test("终结 null 覆盖尚未 flush 的旧 upsert，不会复活", () => {
    handleVerificationUpsert({ type: "verificationUpsert", record: snapshot(1), critical: false }, receiveReply, dir, DAY_ONE);
    handleVerificationDelete({
      type: "verificationDelete",
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 2,
    }, receiveReply, dir, DAY_ONE);

    expect(recoverVerificationDay(DAY_ONE, dir).size).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8"))).toEqual({ "-1001:42": null });
    expect(replies.at(-1)).toMatchObject({ revision: 2, deleted: true });
  });

  test("尾部截断修复保留此前完整 revision，随后仍可追加", () => {
    handleVerificationUpsert({ type: "verificationUpsert", record: snapshot(1), critical: true }, receiveReply, dir, DAY_ONE);
    handleVerificationUpsert({ type: "verificationUpsert", record: snapshot(2), critical: true }, receiveReply, dir, DAY_ONE);
    const path: string = join(dir, `${DAY_ONE}.json`);
    const full: string = readFileSync(path, "utf8");
    writeFileSync(path, full.slice(0, full.lastIndexOf('"revision": 2') + 18));

    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")?.revision).toBe(1);
    handleVerificationUpsert({ type: "verificationUpsert", record: snapshot(3), critical: true }, receiveReply, dir, DAY_ONE);
    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")?.revision).toBe(3);
  });

  test("跨日先复制 active 快照到新日文件，再删除旧日文件", () => {
    handleVerificationUpsert({ type: "verificationUpsert", record: snapshot(1), critical: true }, receiveReply, dir, DAY_ONE);
    handleVerificationUpsert({
      type: "verificationUpsert",
      record: snapshot(1, { userId: 43, label: "第二位" }),
      critical: true,
    }, receiveReply, dir, DAY_TWO);

    expect(existsSync(join(dir, `${DAY_ONE}.json`))).toBeFalse();
    const recovered = recoverVerificationDay(DAY_TWO, dir);
    expect([...recovered.keys()].sort()).toEqual(["-1001:42", "-1001:43"]);
  });

  test("压缩前后恢复结果一致，并移除重复 key 与 null 历史", () => {
    handleVerificationUpsert({ type: "verificationUpsert", record: snapshot(1), critical: true }, receiveReply, dir, DAY_ONE);
    handleVerificationUpsert({ type: "verificationUpsert", record: snapshot(2), critical: true }, receiveReply, dir, DAY_ONE);
    handleVerificationUpsert({
      type: "verificationUpsert",
      record: snapshot(1, { userId: 43, label: "第二位" }),
      critical: true,
    }, receiveReply, dir, DAY_ONE);
    handleVerificationDelete({ type: "verificationDelete", chatId: -1001, userId: 43, generation: 1, revision: 2 }, receiveReply, dir, DAY_ONE);
    const before = recoverVerificationDay(DAY_ONE, dir);

    compactVerificationDay(DAY_ONE, dir);
    expect(recoverVerificationDay(DAY_ONE, dir)).toEqual(before);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8")))).toEqual(["-1001:42"]);
  });

  test("增量历史达到条数阈值时自动收敛为 active 快照", () => {
    handleVerificationUpsert({ type: "verificationUpsert", record: snapshot(1), critical: true }, receiveReply, dir, DAY_ONE);
    verificationFileState.appendedEntries = 9_999;

    handleVerificationUpsert({ type: "verificationUpsert", record: snapshot(2), critical: true }, receiveReply, dir, DAY_ONE);

    expect(verificationFileState.appendedEntries).toBe(0);
    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")?.revision).toBe(2);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8")))).toEqual(["-1001:42"]);
  });

  test("增量历史达到字节阈值时自动收敛，但不把 active 基线反复计入历史", () => {
    handleVerificationUpsert({ type: "verificationUpsert", record: snapshot(1), critical: true }, receiveReply, dir, DAY_ONE);
    verificationFileState.appendedBytes = VERIFICATION_FILE_COMPACT_BYTES - 1;

    handleVerificationUpsert({ type: "verificationUpsert", record: snapshot(2), critical: true }, receiveReply, dir, DAY_ONE);

    expect(verificationFileState.appendedEntries).toBe(0);
    expect(verificationFileState.appendedBytes).toBe(0);
    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")?.revision).toBe(2);
  });

  test("启动扫描也会收敛已达到条数阈值的当天历史", () => {
    const entries: Record<string, null> = {};
    for (let userId = 1; userId <= 10_000; userId++) entries[`-1001:${userId}`] = null;
    writeFileSync(join(dir, `${DAY_ONE}.json`), JSON.stringify(entries, null, 2));

    expect(recoverVerificationDay(DAY_ONE, dir).size).toBe(0);
    expect(verificationFileState.appendedEntries).toBe(0);
    expect(verificationFileState.appendedBytes).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8"))).toEqual({});
  });

  test("启动只留当天日期文件，并逐字段拒绝损坏记录", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    writeFileSync(join(dir, "2026-07-18.json"), "{}");
    writeFileSync(join(dir, "notes.json"), "{}");
    writeFileSync(join(dir, `${DAY_ONE}.json`), JSON.stringify({
      "-1001:42": { version: 1, ...snapshot(1), expiresAt: "soon" },
      "-1001:99": { version: 1, ...snapshot(2) },
      "-1001:50": null,
    }, null, 2));

    expect(recoverVerificationDay(DAY_ONE, dir).size).toBe(0);
    expect(existsSync(join(dir, "2026-07-18.json"))).toBeFalse();
    expect(existsSync(join(dir, "notes.json"))).toBeTrue();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  test("消息窗口随当天快照恢复，旧版缺失字段按空窗口兼容", () => {
    handleVerificationUpsert({
      type: "verificationUpsert",
      record: snapshot(1, { trackedMessageTimes: [10_000, 20_000] }),
      critical: true,
    }, receiveReply, dir, DAY_ONE);
    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")?.trackedMessageTimes).toEqual([10_000, 20_000]);

    const legacy = snapshot(2);
    delete legacy.trackedMessageTimes;
    writeFileSync(join(dir, `${DAY_ONE}.json`), JSON.stringify({ "-1001:42": { version: 1, ...legacy } }, null, 2));
    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")?.trackedMessageTimes).toBeUndefined();
  });
});
