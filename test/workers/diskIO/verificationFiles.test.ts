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
} from "../../../packages/workers/diskIO/verificationFiles";
import {
  resetVerificationPersistenceCache,
  verificationFileState,
  verificationPendingChanges,
} from "../../../packages/cache/workers/diskIO/verification";
import type {
  PendingVerificationSnapshot,
  VerificationDeleteDiskMessage,
  VerificationPersistedReply,
  VerificationSnapshot,
  VerificationSnapshotBase,
  VerificationUpsertDiskMessage,
} from "../../../packages/types";
import {
  VERIFICATION_FILE_COMPACT_BYTES,
  VERIFICATION_FILE_VERSION,
} from "../../../packages/consts/diskIO";

const DAY_ONE = "2026-07-19";
const DAY_TWO = "2026-07-20";
const DAY_ZERO = "2026-07-18";

let dir: string;
let replies: VerificationPersistedReply[];

function snapshot(
  revision: number,
  overrides: Partial<VerificationSnapshotBase> = {}
): PendingVerificationSnapshot {
  return {
    chatId: -1001,
    userId: 42,
    generation: 1,
    revision,
    phase: "pending",
    label: "@pending_user",
    isBot: false,
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
        record: snapshot(revision, { trackedMessageTimes: [revision] }),
        critical: false,
      });
    }

    expect(verificationPendingChanges.size).toBe(1);
    expect(replies.map((reply) => reply.revision)).toEqual([1]);
    flushVerificationChanges(receiveReply, dir, DAY_ONE);

    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")).toMatchObject({
      revision: 500,
      trackedMessageTimes: [500],
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
      "-1001:43": { version: VERIFICATION_FILE_VERSION, ...snapshot(2, { userId: 43, label: "第二位" }) },
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

  test("跨午夜停机后从最新旧日迁移 active，再删除旧日", () => {
    resetVerificationPersistenceCache();
    writeFileSync(
      join(dir, `${DAY_ONE}.json`),
      JSON.stringify({ "-1001:42": { version: VERIFICATION_FILE_VERSION, ...snapshot(1) } }, null, 2)
    );

    const recovered: Map<string, VerificationSnapshot> =
      recoverVerificationDay(DAY_TWO, dir);

    expect(recovered.get("-1001:42")).toMatchObject({ revision: 1 });
    expect(existsSync(join(dir, `${DAY_ONE}.json`))).toBeFalse();
    expect(JSON.parse(readFileSync(join(dir, `${DAY_TWO}.json`), "utf8")))
      .toEqual({ "-1001:42": { version: VERIFICATION_FILE_VERSION, ...snapshot(1) } });
  });

  test("只以最新旧日为迁移基线，不从更早残留复活已终结成员", () => {
    resetVerificationPersistenceCache();
    writeFileSync(
      join(dir, `${DAY_ZERO}.json`),
      JSON.stringify({ "-1001:42": { version: VERIFICATION_FILE_VERSION, ...snapshot(1) } }, null, 2)
    );
    // 最新旧日的 active 快照已不含 user 42，等价于更早记录已经终结。
    writeFileSync(join(dir, `${DAY_ONE}.json`), JSON.stringify({}, null, 2));

    const recovered: Map<string, VerificationSnapshot> =
      recoverVerificationDay(DAY_TWO, dir);

    expect(recovered.has("-1001:42")).toBeFalse();
    expect(existsSync(join(dir, `${DAY_ZERO}.json`))).toBeFalse();
    expect(existsSync(join(dir, `${DAY_ONE}.json`))).toBeFalse();
    expect(JSON.parse(readFileSync(join(dir, `${DAY_TWO}.json`), "utf8")))
      .toEqual({});
  });

  test("时钟回拨：晚于今天的日文件一律保留，绝不未读删除", () => {
    resetVerificationPersistenceCache();
    // 宿主 RTC 快于真实时间（VM 恢复、NTP 同步前启动）时写出的那一份。
    // latestPriorVerificationDay 用 `candidate >= day` 明确拒绝把它并进本次恢复，
    // 删掉就等于把这一整天的待验证记录未读丢弃：那批人永不被超时踢出，群里还
    // 挂着一堆背后没有状态机的验证按钮。
    const DAY_FUTURE: string = "2026-07-21";
    writeFileSync(
      join(dir, `${DAY_FUTURE}.json`),
      JSON.stringify({ "-1001:44": { version: VERIFICATION_FILE_VERSION, ...snapshot(1, { userId: 44 }) } }, null, 2)
    );
    writeFileSync(
      join(dir, `${DAY_ZERO}.json`),
      JSON.stringify({ "-1001:42": { version: VERIFICATION_FILE_VERSION, ...snapshot(1) } }, null, 2)
    );

    const recovered: Map<string, VerificationSnapshot> =
      recoverVerificationDay(DAY_ONE, dir);

    // 更早的旧日照常并进来并删除；未来那份原封不动留着。
    expect(recovered.has("-1001:42")).toBeTrue();
    expect(recovered.has("-1001:44")).toBeFalse();
    expect(existsSync(join(dir, `${DAY_ZERO}.json`))).toBeFalse();
    expect(existsSync(join(dir, `${DAY_FUTURE}.json`))).toBeTrue();

    // 时钟走到那天时它自己就是当天文件，照常恢复出来——留着不会常驻。
    resetVerificationPersistenceCache();
    expect(recoverVerificationDay(DAY_FUTURE, dir).has("-1001:44")).toBeTrue();
  });

  test("没有旧日可迁移时同样不删未来日文件", () => {
    resetVerificationPersistenceCache();
    const DAY_FUTURE: string = "2026-07-21";
    writeFileSync(
      join(dir, `${DAY_FUTURE}.json`),
      JSON.stringify({ "-1001:44": { version: VERIFICATION_FILE_VERSION, ...snapshot(1, { userId: 44 }) } }, null, 2)
    );

    expect(recoverVerificationDay(DAY_ONE, dir).size).toBe(0);
    expect(existsSync(join(dir, `${DAY_FUTURE}.json`))).toBeTrue();
  });

  test("跨午夜停机恢复以新日 active 和 tombstone 覆盖旧日", () => {
    resetVerificationPersistenceCache();
    writeFileSync(
      join(dir, `${DAY_ONE}.json`),
      JSON.stringify({
        "-1001:42": { version: VERIFICATION_FILE_VERSION, ...snapshot(1) },
        "-1001:43": {
          version: VERIFICATION_FILE_VERSION,
          ...snapshot(1, { userId: 43, label: "旧日成员" }),
        },
      }, null, 2)
    );
    writeFileSync(
      join(dir, `${DAY_TWO}.json`),
      JSON.stringify({
        "-1001:42": null,
        "-1001:43": {
          version: VERIFICATION_FILE_VERSION,
          ...snapshot(2, { userId: 43, label: "新日成员" }),
        },
      }, null, 2)
    );

    const recovered: Map<string, VerificationSnapshot> =
      recoverVerificationDay(DAY_TWO, dir);

    expect(recovered.has("-1001:42")).toBeFalse();
    expect(recovered.get("-1001:43")).toMatchObject({
      revision: 2,
      label: "新日成员",
    });
    expect(existsSync(join(dir, `${DAY_ONE}.json`))).toBeFalse();
  });

  test("待迁移旧日损坏时不改写新旧文件，也不清理旧日", () => {
    resetVerificationPersistenceCache();
    const oldContent: string = "{\"-1001:42\":";
    const currentContent: string = JSON.stringify({
      "-1001:43": {
        version: VERIFICATION_FILE_VERSION,
        ...snapshot(1, { userId: 43, label: "新日成员" }),
      },
    }, null, 2);
    const oldPath: string = join(dir, `${DAY_ONE}.json`);
    const currentPath: string = join(dir, `${DAY_TWO}.json`);
    writeFileSync(oldPath, oldContent);
    writeFileSync(currentPath, currentContent);

    expect((): Map<string, VerificationSnapshot> =>
      recoverVerificationDay(DAY_TWO, dir)
    ).toThrow();
    expect(readFileSync(oldPath, "utf8")).toBe(oldContent);
    expect(readFileSync(currentPath, "utf8")).toBe(currentContent);
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
      "-1001:99": { version: VERIFICATION_FILE_VERSION, ...snapshot(2, { userId: 99 }) },
      "-1001:42": { version: VERIFICATION_FILE_VERSION, ...snapshot(1), expiresAt: "soon" },
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
      "-1001_42": { version: VERIFICATION_FILE_VERSION, ...snapshot(1) },
    }, null, 2));

    expect(() => recoverVerificationDay(DAY_ONE, dir)).toThrow(
      "invalid active pending verification record for key -1001_42"
    );
  });

  test("旧版验证记录不在代码中兼容，必须停机后手工迁移", () => {
    const path: string = join(dir, `${DAY_ONE}.json`);
    const original: string = JSON.stringify({
      "-1001:42": { version: 1, ...snapshot(1), messageIds: [7, 8] },
    }, null, 2);
    writeFileSync(path, original);

    expect(() => recoverVerificationDay(DAY_ONE, dir)).toThrow(
      "invalid active pending verification record for key -1001:42"
    );
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("消息窗口随当天快照恢复，缺失当前必填字段时拒绝启动", () => {
    upsert({
      type: "verificationUpsert",
      record: snapshot(1, { trackedMessageTimes: [10_000, 20_000] }),
      critical: true,
    });
    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")?.trackedMessageTimes).toEqual([10_000, 20_000]);

    const incompatible: Record<string, unknown> = { version: VERIFICATION_FILE_VERSION, ...snapshot(2) };
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
    const { phase: _phase, ...pending } = snapshot(1);
    upsert({
      type: "verificationUpsert",
      record: {
        ...pending,
        phase: "expelling",
        expelReason: "timeout",
        successNoticeSent: true,
      },
      critical: true,
    });
    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")?.successNoticeSent).toBe(true);

    const invalidPending: Record<string, unknown> = {
      ...snapshot(2),
      successNoticeSent: true,
    };
    writeFileSync(join(dir, `${DAY_ONE}.json`), JSON.stringify({
      "-1001:42": { version: VERIFICATION_FILE_VERSION, ...invalidPending },
    }));
    expect(() => recoverVerificationDay(DAY_ONE, dir)).toThrow("invalid active pending verification record");
  });

  test("checkingInviter 阶段可完整持久化并恢复", () => {
    const { phase: _phase, ...pending } = snapshot(1);
    const record: VerificationSnapshot = {
      ...pending,
      phase: "checkingInviter",
      terminalInviterId: 88,
    };

    upsert({
      type: "verificationUpsert",
      record,
      critical: true,
    });

    expect(recoverVerificationDay(DAY_ONE, dir).get("-1001:42")).toEqual(record);
  });
});
