import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  resetVerificationPersistenceCache,
  verificationFileState,
  verificationPendingChanges,
} from "../../../src/cache/diskIO/verification";
import type {
  VerificationDeleteDiskMessage,
  VerificationPersistedReply,
  VerificationSnapshot,
  VerificationUpsertDiskMessage,
} from "../../../src/types";
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
    phase: "pending",
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

function upsert(msg: VerificationUpsertDiskMessage, day: string = DAY_ONE): void {
  handleVerificationUpsert({ msg, reply: receiveReply, dir, day });
}

function deleteVerification(msg: VerificationDeleteDiskMessage, day: string = DAY_ONE): void {
  handleVerificationDelete({ msg, reply: receiveReply, dir, day });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verification-day-test-"));
  replies = [];
  resetVerificationPersistenceCache();
  // 生产中所有业务消息都晚于 diskIOWorker 的 load 握手；测试同样先接管当天。
  recoverVerificationDay(DAY_ONE, dir);
});

afterEach(() => {
  resetVerificationPersistenceCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("pending verification daily append JSON", () => {
  test("新建立即写入，同一 key 高频普通更新只追加窗口内最终快照", () => {
    upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    for (let revision = 2; revision <= 500; revision++) {
      upsert({
        type: "verificationUpsert",
        record: snapshot(revision, { messageIds: [10, revision] }),
        critical: false,
      });
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

  test("终结以 durable tombstone 覆盖尚未 flush 的旧 upsert，不会复活", () => {
    upsert({ type: "verificationUpsert", record: snapshot(1), critical: false });
    deleteVerification({
      type: "verificationDelete",
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 2,
    });

    expect(recoverVerificationDay(DAY_ONE, dir).size).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8"))).toEqual({ "-1001:42": null });
    expect(replies.at(-1)).toMatchObject({ revision: 2, deleted: true });
  });

  test("验证终结只追加 tombstone，不因单次 delete 全量重写其它 active", () => {
    upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    upsert({
      type: "verificationUpsert",
      record: snapshot(1, { userId: 43, label: "第二位" }),
      critical: true,
    });
    upsert({
      type: "verificationUpsert",
      record: snapshot(2, { userId: 43, label: "第二位" }),
      critical: true,
    });

    deleteVerification({
      type: "verificationDelete",
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 2,
    });

    const content: string = readFileSync(join(dir, `${DAY_ONE}.json`), "utf8");
    expect(content.match(/"-1001:43":/g)).toHaveLength(2);
    expect(JSON.parse(content)).toEqual({
      "-1001:42": null,
      "-1001:43": { version: 1, ...snapshot(2, { userId: 43, label: "第二位" }) },
    });
    expect(recoverVerificationDay(DAY_ONE, dir).has("-1001:42")).toBeFalse();
  });

  test("批量终结按 delete 数线性追加，不在每次终结后重置历史计数", () => {
    const total: number = 200;
    for (let userId = 1; userId <= total; userId++) {
      upsert({
        type: "verificationUpsert",
        record: snapshot(1, { userId, label: `member-${userId}` }),
        critical: true,
      });
    }
    expect(verificationFileState.appendedEntries).toBe(total);

    for (let userId = 1; userId <= total; userId++) {
      deleteVerification({
        type: "verificationDelete",
        chatId: -1001,
        userId,
        generation: 1,
        revision: 2,
      });
    }

    expect(verificationFileState.appendedEntries).toBe(total * 2);
    expect(recoverVerificationDay(DAY_ONE, dir).size).toBe(0);
  });

  test("尾部截断修复保留此前完整 revision，随后仍可追加", () => {
    upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    upsert({ type: "verificationUpsert", record: snapshot(2), critical: true });
    const path: string = join(dir, `${DAY_ONE}.json`);
    const full: string = readFileSync(path, "utf8");
    writeFileSync(path, full.slice(0, full.lastIndexOf('"revision": 2') + 18));

    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")?.revision).toBe(1);
    upsert({ type: "verificationUpsert", record: snapshot(3), critical: true });
    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")?.revision).toBe(3);
  });

  test("尾部截断不会丢弃重复 key 的 tombstone、复活已终结验证", () => {
    upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    upsert({
      type: "verificationUpsert",
      record: snapshot(1, { userId: 43, label: "仍在验证" }),
      critical: true,
    });
    deleteVerification({
      type: "verificationDelete",
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 2,
    });
    upsert({
      type: "verificationUpsert",
      record: snapshot(1, { userId: 44, label: "写到一半" }),
      critical: true,
    });

    const path: string = join(dir, `${DAY_ONE}.json`);
    const full: string = readFileSync(path, "utf8");
    const tornEntryStart: number = full.lastIndexOf('"-1001:44"');
    writeFileSync(path, full.slice(0, tornEntryStart + 50));

    const recovered: Map<string, VerificationSnapshot> = recoverVerificationDay(DAY_ONE, dir);
    expect(recovered.has("-1001:42")).toBeFalse();
    expect(recovered.get("-1001:43")?.label).toBe("仍在验证");
    expect(recovered.has("-1001:44")).toBeFalse();
  });

  test("跨日先复制 active 快照到新日文件，再删除旧日文件", () => {
    upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    upsert({
      type: "verificationUpsert",
      record: snapshot(1, { userId: 43, label: "第二位" }),
      critical: true,
    }, DAY_TWO);

    expect(existsSync(join(dir, `${DAY_ONE}.json`))).toBeFalse();
    const recovered = recoverVerificationDay(DAY_TWO, dir);
    expect([...recovered.keys()].sort()).toEqual(["-1001:42", "-1001:43"]);
  });

  test("压缩前后恢复结果一致，并移除重复 key 与 null 历史", () => {
    upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    upsert({ type: "verificationUpsert", record: snapshot(2), critical: true });
    upsert({
      type: "verificationUpsert",
      record: snapshot(1, { userId: 43, label: "第二位" }),
      critical: true,
    });
    deleteVerification({ type: "verificationDelete", chatId: -1001, userId: 43, generation: 1, revision: 2 });
    const before = recoverVerificationDay(DAY_ONE, dir);

    compactVerificationDay(DAY_ONE, dir);
    expect(recoverVerificationDay(DAY_ONE, dir)).toEqual(before);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8")))).toEqual(["-1001:42"]);
  });

  test("增量历史达到条数阈值时自动收敛为 active 快照", () => {
    upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    verificationFileState.appendedEntries = 9_999;

    upsert({ type: "verificationUpsert", record: snapshot(2), critical: true });

    expect(verificationFileState.appendedEntries).toBe(0);
    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")?.revision).toBe(2);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8")))).toEqual(["-1001:42"]);
  });

  test("增量历史达到字节阈值时自动收敛，但不把 active 基线反复计入历史", () => {
    upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    verificationFileState.appendedBytes = VERIFICATION_FILE_COMPACT_BYTES - 1;

    upsert({ type: "verificationUpsert", record: snapshot(2), critical: true });

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

  test("同一文件一条合法、一条损坏时 fail closed，且不改写原文件或清理旧日", () => {
    writeFileSync(join(dir, "2026-07-18.json"), "{}");
    writeFileSync(join(dir, "notes.json"), "{}");
    const original: string = JSON.stringify({
      "-1001:99": { version: 1, ...snapshot(2, { userId: 99 }) },
      "-1001:42": { version: 1, ...snapshot(1), expiresAt: "soon" },
      "-1001:50": null,
    }, null, 2);
    writeFileSync(join(dir, `${DAY_ONE}.json`), original);

    expect(() => recoverVerificationDay(DAY_ONE, dir)).toThrow(
      "invalid active pending verification record for key -1001:42"
    );
    expect(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8")).toBe(original);
    expect(existsSync(join(dir, "2026-07-18.json"))).toBeTrue();
    expect(existsSync(join(dir, "notes.json"))).toBeTrue();
  });

  test("顶层不是对象时 fail closed，并保持文件字节不变", () => {
    const path: string = join(dir, `${DAY_ONE}.json`);
    const original: string = "[{\"bad\":\"shape\"}]";
    writeFileSync(path, original);

    expect(() => recoverVerificationDay(DAY_ONE, dir)).toThrow("must contain a JSON object");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("旧下划线键不再兼容，必须手动改成冒号格式", () => {
    writeFileSync(join(dir, `${DAY_ONE}.json`), JSON.stringify({
      "-1001_42": { version: 1, ...snapshot(1) },
    }, null, 2));

    expect(() => recoverVerificationDay(DAY_ONE, dir)).toThrow(
      "invalid active pending verification record for key -1001_42"
    );
  });

  test("消息窗口随当天快照恢复，缺失当前必填字段时拒绝启动", () => {
    upsert({
      type: "verificationUpsert",
      record: snapshot(1, { trackedMessageTimes: [10_000, 20_000] }),
      critical: true,
    });
    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")?.trackedMessageTimes).toEqual([10_000, 20_000]);

    const incompatible: Record<string, unknown> = { version: 1, ...snapshot(2) };
    delete incompatible.trackedMessageTimes;
    const path: string = join(dir, `${DAY_ONE}.json`);
    const original: string = JSON.stringify({ "-1001:42": incompatible }, null, 2);
    writeFileSync(path, original);
    expect(() => recoverVerificationDay(DAY_ONE, dir)).toThrow(
      "invalid active pending verification record for key -1001:42"
    );
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("成功播报标记只允许出现在 expelling 终态并可完整恢复", () => {
    upsert({
      type: "verificationUpsert",
      record: snapshot(1, {
        phase: "expelling",
        expelReason: "timeout",
        successNoticeSent: true,
      }),
      critical: true,
    });
    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")?.successNoticeSent).toBe(true);

    const invalidPending = snapshot(2, { successNoticeSent: true });
    writeFileSync(join(dir, `${DAY_ONE}.json`), JSON.stringify({
      "-1001:42": { version: 1, ...invalidPending },
    }));
    expect(() => recoverVerificationDay(DAY_ONE, dir)).toThrow("invalid active pending verification record");
  });
});
