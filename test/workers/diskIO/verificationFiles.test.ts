import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptVerificationDay,
  compactVerificationDay,
  inspectVerificationDay,
  maintainVerificationDay,
} from "../../../packages/workers/diskIO/verificationRecovery";
import {
  flushVerificationChanges,
  handleVerificationDelete,
  handleVerificationUpsert,
} from "../../../packages/workers/diskIO/verificationWrites";
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
} from "../../../packages/consts/diskIO/verification";
import { VERIFICATION_RECORD_CAPACITY } from "../../../packages/consts/antiRaid/verification";

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

async function upsert(
  msg: VerificationUpsertDiskMessage,
  day: string = DAY_ONE
): Promise<void> {
  await handleVerificationUpsert({ msg, reply: receiveReply, dir, day });
}

async function deleteVerification(
  msg: VerificationDeleteDiskMessage,
  day: string = DAY_ONE
): Promise<void> {
  await handleVerificationDelete({ msg, reply: receiveReply, dir, day });
}

/**
 * 单领域恢复的测试编排：按生产 handleDiskIOStartupLoad 的顺序跑
 * inspect -> adopt -> maintenance（见 workers/diskIO/startup.ts）。
 *
 * 生产没有这个包装。两点与生产不同，读断言时要记住：生产的 runMaintenance 对
 * 每个领域单独 try/catch 并只记一行 console.error，不上抛、也不重置本领域缓存；
 * 这里保留旧包装的「重置后上抛」，好让维护阶段的失败在用例里可断言。
 */
async function recoverVerificationDay(
  day: string,
  dir: string
): Promise<Map<string, VerificationSnapshot>> {
  const inspection = await inspectVerificationDay(day, dir);
  const recovered = adoptVerificationDay(inspection);
  try {
    maintainVerificationDay(inspection);
  } catch (error: unknown) {
    resetVerificationPersistenceCache();
    throw error;
  }
  return recovered;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "verification-day-test-"));
  replies = [];
  resetVerificationPersistenceCache();
  // 生产中所有业务消息都晚于 diskIOWorker 的 load 握手；测试同样先接管当天。
  await recoverVerificationDay(DAY_ONE, dir);
});

afterEach(() => {
  resetVerificationPersistenceCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("pending verification daily append JSON", () => {
  test("kickPending 以 critical 快照落盘并完整恢复动作代际", async () => {
    const { phase: _phase, ...base } = snapshot(1, {
      trackedMessageTimes: [],
      joinedAt: 2_000,
      expiresAt: 2_000,
      reminderSuperseded: true,
    });
    const record: VerificationSnapshot = {
      ...base,
      phase: "kickPending",
      requestedAt: 2_000,
      countedJoinAt: 2_000,
    };

    await upsert({ type: "verificationUpsert", record, critical: true });

    expect((await recoverVerificationDay(DAY_ONE, dir)).get("-1001:42")).toEqual(record);
    expect(replies).toContainEqual({
      type: "verificationPersisted",
      key: "-1001:42",
      generation: 1,
      revision: 1,
      deleted: false,
    });
  });

  test("新建立即写入，同一 key 高频普通更新只追加窗口内最终快照", async () => {
    await upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    for (let revision = 2; revision <= 500; revision++) {
      await upsert({
        type: "verificationUpsert",
        record: snapshot(revision, { trackedMessageTimes: [revision] }),
        critical: false,
      });
    }

    expect(verificationPendingChanges.size).toBe(1);
    expect(replies.map((reply) => reply.revision)).toEqual([1]);
    await flushVerificationChanges(receiveReply, dir, DAY_ONE);

    expect((await recoverVerificationDay(DAY_ONE, dir)).get("-1001:42")).toMatchObject({
      revision: 500,
      trackedMessageTimes: [500],
    });
    expect(replies.map((reply) => reply.revision)).toEqual([1, 500]);
  });

  test("终结以 durable tombstone 覆盖尚未 flush 的旧 upsert，不会复活", async () => {
    await upsert({ type: "verificationUpsert", record: snapshot(1), critical: false });
    await deleteVerification({
      type: "verificationDelete",
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 2,
    });

    expect((await recoverVerificationDay(DAY_ONE, dir)).size).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8"))).toEqual({ "-1001:42": null });
    expect(replies.at(-1)).toMatchObject({ revision: 2, deleted: true });
  });

  test("验证终结只追加 tombstone，不因单次 delete 全量重写其它 active", async () => {
    await upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    await upsert({
      type: "verificationUpsert",
      record: snapshot(1, { userId: 43, label: "第二位" }),
      critical: true,
    });
    await upsert({
      type: "verificationUpsert",
      record: snapshot(2, { userId: 43, label: "第二位" }),
      critical: true,
    });

    await deleteVerification({
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
    expect((await recoverVerificationDay(DAY_ONE, dir)).has("-1001:42")).toBeFalse();
  });

  test("批量终结按 delete 数线性追加，不在每次终结后重置历史计数", async () => {
    const total: number = 200;
    for (let userId = 1; userId <= total; userId++) {
      await upsert({
        type: "verificationUpsert",
        record: snapshot(1, { userId, label: `member-${userId}` }),
        critical: true,
      });
    }
    expect(verificationFileState.appendedEntries).toBe(total);

    for (let userId = 1; userId <= total; userId++) {
      await deleteVerification({
        type: "verificationDelete",
        chatId: -1001,
        userId,
        generation: 1,
        revision: 2,
      });
    }

    expect(verificationFileState.appendedEntries).toBe(total * 2);
    expect((await recoverVerificationDay(DAY_ONE, dir)).size).toBe(0);
  });

  test("尾部截断时拒绝恢复，并保持原始字节不变", async () => {
    await upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    await upsert({ type: "verificationUpsert", record: snapshot(2), critical: true });
    const path: string = join(dir, `${DAY_ONE}.json`);
    const full: string = readFileSync(path, "utf8");
    const truncated: string = full.slice(0, full.lastIndexOf('"revision": 2') + 18);
    writeFileSync(path, truncated);

    await expect(recoverVerificationDay(DAY_ONE, dir)).rejects.toThrow("must be valid JSON");
    expect(readFileSync(path, "utf8")).toBe(truncated);
  });

  test("tombstone 后的尾部截断同样拒绝恢复，不猜测最后完整 revision", async () => {
    await upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    await upsert({
      type: "verificationUpsert",
      record: snapshot(1, { userId: 43, label: "仍在验证" }),
      critical: true,
    });
    await deleteVerification({
      type: "verificationDelete",
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 2,
    });
    await upsert({
      type: "verificationUpsert",
      record: snapshot(1, { userId: 44, label: "写到一半" }),
      critical: true,
    });

    const path: string = join(dir, `${DAY_ONE}.json`);
    const full: string = readFileSync(path, "utf8");
    const tornEntryStart: number = full.lastIndexOf('"-1001:44"');
    const truncated: string = full.slice(0, tornEntryStart + 50);
    writeFileSync(path, truncated);

    await expect(recoverVerificationDay(DAY_ONE, dir)).rejects.toThrow("must be valid JSON");
    expect(readFileSync(path, "utf8")).toBe(truncated);
  });

  test("跨日先复制 active 快照到新日文件，再删除旧日文件", async () => {
    await upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    await upsert({
      type: "verificationUpsert",
      record: snapshot(1, { userId: 43, label: "第二位" }),
      critical: true,
    }, DAY_TWO);

    expect(existsSync(join(dir, `${DAY_ONE}.json`))).toBeFalse();
    const recovered = await recoverVerificationDay(DAY_TWO, dir);
    expect([...recovered.keys()].sort()).toEqual(["-1001:42", "-1001:43"]);
  });

  test("跨午夜停机后从最新旧日迁移 active，再删除旧日", async () => {
    resetVerificationPersistenceCache();
    writeFileSync(
      join(dir, `${DAY_ONE}.json`),
      JSON.stringify({ "-1001:42": { version: VERIFICATION_FILE_VERSION, ...snapshot(1) } }, null, 2)
    );

    const recovered: Map<string, VerificationSnapshot> =
      await recoverVerificationDay(DAY_TWO, dir);

    expect(recovered.get("-1001:42")).toMatchObject({ revision: 1 });
    expect(existsSync(join(dir, `${DAY_ONE}.json`))).toBeFalse();
    expect(JSON.parse(readFileSync(join(dir, `${DAY_TWO}.json`), "utf8")))
      .toEqual({ "-1001:42": { version: VERIFICATION_FILE_VERSION, ...snapshot(1) } });
  });

  test("跨日 inspect 不改盘，adopt 只发布内存，maintenance 才 compact 和清旧日", async () => {
    resetVerificationPersistenceCache();
    const priorPath: string = join(dir, `${DAY_ONE}.json`);
    const currentPath: string = join(dir, `${DAY_TWO}.json`);
    writeFileSync(
      priorPath,
      JSON.stringify({ "-1001:42": { version: VERIFICATION_FILE_VERSION, ...snapshot(1) } }, null, 2)
    );

    const inspection = await inspectVerificationDay(DAY_TWO, dir);
    expect(existsSync(priorPath)).toBeTrue();
    expect(existsSync(currentPath)).toBeFalse();
    expect(verificationFileState.current).toBeNull();

    adoptVerificationDay(inspection);
    expect(existsSync(priorPath)).toBeTrue();
    expect(existsSync(currentPath)).toBeFalse();

    maintainVerificationDay(inspection);
    expect(existsSync(priorPath)).toBeFalse();
    expect(existsSync(currentPath)).toBeTrue();
  });

  test("只以最新旧日为迁移基线，不从更早残留复活已终结成员", async () => {
    resetVerificationPersistenceCache();
    writeFileSync(
      join(dir, `${DAY_ZERO}.json`),
      JSON.stringify({ "-1001:42": { version: VERIFICATION_FILE_VERSION, ...snapshot(1) } }, null, 2)
    );
    // 最新旧日的 active 快照已不含 user 42，等价于更早记录已经终结。
    writeFileSync(join(dir, `${DAY_ONE}.json`), JSON.stringify({}, null, 2));

    const recovered: Map<string, VerificationSnapshot> =
      await recoverVerificationDay(DAY_TWO, dir);

    expect(recovered.has("-1001:42")).toBeFalse();
    expect(existsSync(join(dir, `${DAY_ZERO}.json`))).toBeFalse();
    expect(existsSync(join(dir, `${DAY_ONE}.json`))).toBeFalse();
    expect(JSON.parse(readFileSync(join(dir, `${DAY_TWO}.json`), "utf8")))
      .toEqual({});
  });

  test("时钟回拨：晚于今天的日文件一律保留，绝不未读删除", async () => {
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
      await recoverVerificationDay(DAY_ONE, dir);

    // 更早的旧日照常并进来并删除；未来那份原封不动留着。
    expect(recovered.has("-1001:42")).toBeTrue();
    expect(recovered.has("-1001:44")).toBeFalse();
    expect(existsSync(join(dir, `${DAY_ZERO}.json`))).toBeFalse();
    expect(existsSync(join(dir, `${DAY_FUTURE}.json`))).toBeTrue();

    // 时钟走到那天时它自己就是当天文件，照常恢复出来——留着不会常驻。
    resetVerificationPersistenceCache();
    expect((await recoverVerificationDay(DAY_FUTURE, dir)).has("-1001:44")).toBeTrue();
  });

  test("没有旧日可迁移时同样不删未来日文件", async () => {
    resetVerificationPersistenceCache();
    const DAY_FUTURE: string = "2026-07-21";
    writeFileSync(
      join(dir, `${DAY_FUTURE}.json`),
      JSON.stringify({ "-1001:44": { version: VERIFICATION_FILE_VERSION, ...snapshot(1, { userId: 44 }) } }, null, 2)
    );

    expect((await recoverVerificationDay(DAY_ONE, dir)).size).toBe(0);
    expect(existsSync(join(dir, `${DAY_FUTURE}.json`))).toBeTrue();
  });

  test("跨午夜停机恢复以新日 active 和 tombstone 覆盖旧日", async () => {
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
      await recoverVerificationDay(DAY_TWO, dir);

    expect(recovered.has("-1001:42")).toBeFalse();
    expect(recovered.get("-1001:43")).toMatchObject({
      revision: 2,
      label: "新日成员",
    });
    expect(existsSync(join(dir, `${DAY_ONE}.json`))).toBeFalse();
  });

  test("待迁移旧日损坏时不改写新旧文件，也不清理旧日", async () => {
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

    await expect(recoverVerificationDay(DAY_TWO, dir)).rejects.toThrow();
    expect(readFileSync(oldPath, "utf8")).toBe(oldContent);
    expect(readFileSync(currentPath, "utf8")).toBe(currentContent);
  });

  test("压缩前后恢复结果一致，并移除重复 key 与 null 历史", async () => {
    await upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    await upsert({ type: "verificationUpsert", record: snapshot(2), critical: true });
    await upsert({
      type: "verificationUpsert",
      record: snapshot(1, { userId: 43, label: "第二位" }),
      critical: true,
    });
    await deleteVerification({ type: "verificationDelete", chatId: -1001, userId: 43, generation: 1, revision: 2 });
    const before = await recoverVerificationDay(DAY_ONE, dir);

    compactVerificationDay(DAY_ONE, dir);
    expect(await recoverVerificationDay(DAY_ONE, dir)).toEqual(before);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8")))).toEqual(["-1001:42"]);
  });

  test("增量历史达到条数阈值时自动收敛为 active 快照", async () => {
    await upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    verificationFileState.appendedEntries = 9_999;

    await upsert({ type: "verificationUpsert", record: snapshot(2), critical: true });

    expect(verificationFileState.appendedEntries).toBe(0);
    expect((await recoverVerificationDay(DAY_ONE, dir)).get("-1001:42")?.revision).toBe(2);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8")))).toEqual(["-1001:42"]);
  });

  test("增量历史达到字节阈值时自动收敛，但不把 active 基线反复计入历史", async () => {
    await upsert({ type: "verificationUpsert", record: snapshot(1), critical: true });
    verificationFileState.appendedBytes = VERIFICATION_FILE_COMPACT_BYTES - 1;

    await upsert({ type: "verificationUpsert", record: snapshot(2), critical: true });

    expect(verificationFileState.appendedEntries).toBe(0);
    expect(verificationFileState.appendedBytes).toBe(0);
    expect((await recoverVerificationDay(DAY_ONE, dir)).get("-1001:42")?.revision).toBe(2);
  });

  test("启动扫描也会收敛已达到条数阈值的当天历史", async () => {
    const entries: Record<string, null> = {};
    for (let userId = 1; userId <= 10_000; userId++) entries[`-1001:${userId}`] = null;
    writeFileSync(join(dir, `${DAY_ONE}.json`), JSON.stringify(entries, null, 2));

    expect((await recoverVerificationDay(DAY_ONE, dir)).size).toBe(0);
    expect(verificationFileState.appendedEntries).toBe(0);
    expect(verificationFileState.appendedBytes).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8"))).toEqual({});
  });

  test("同一文件一条合法、一条损坏时 fail closed，且不改写原文件或清理旧日", async () => {
    writeFileSync(join(dir, "2026-07-18.json"), "{}");
    writeFileSync(join(dir, "notes.txt"), "diagnostic");
    const original: string = JSON.stringify({
      "-1001:99": { version: VERIFICATION_FILE_VERSION, ...snapshot(2, { userId: 99 }) },
      "-1001:42": { version: VERIFICATION_FILE_VERSION, ...snapshot(1), expiresAt: "soon" },
      "-1001:50": null,
    }, null, 2);
    writeFileSync(join(dir, `${DAY_ONE}.json`), original);

    await expect(recoverVerificationDay(DAY_ONE, dir)).rejects.toThrow(
      "$.<record> must be a current verification record or null tombstone"
    );
    expect(readFileSync(join(dir, `${DAY_ONE}.json`), "utf8")).toBe(original);
    expect(existsSync(join(dir, "2026-07-18.json"))).toBeTrue();
    expect(existsSync(join(dir, "notes.txt"))).toBeTrue();
  });

  test("顶层不是对象时 fail closed，并保持文件字节不变", async () => {
    const path: string = join(dir, `${DAY_ONE}.json`);
    const original: string = "[{\"bad\":\"shape\"}]";
    writeFileSync(path, original);

    await expect(recoverVerificationDay(DAY_ONE, dir)).rejects.toThrow("must be a JSON object of verification records");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("恢复 active 记录超过硬顶时 fail closed，且不截断或改写文件", async () => {
    const path: string = join(dir, `${DAY_ONE}.json`);
    const records: Record<string, unknown> = {};
    for (
      let index: number = 1;
      index <= VERIFICATION_RECORD_CAPACITY + 1;
      index++
    ) {
      records[`-1001:${index}`] = {
        version: VERIFICATION_FILE_VERSION,
        ...snapshot(1, { userId: index }),
      };
    }
    const original: string = JSON.stringify(records);
    writeFileSync(path, original);

    await expect(recoverVerificationDay(DAY_ONE, dir))
      .rejects.toThrow(`$ must be a JSON object with at most ${VERIFICATION_RECORD_CAPACITY} active verification records`);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("正数私聊 ID 不能恢复为群级待验证状态", async () => {
    const path: string = join(dir, `${DAY_ONE}.json`);
    const original: string = JSON.stringify({
      "1001:42": {
        version: VERIFICATION_FILE_VERSION,
        ...snapshot(1, { chatId: 1001 }),
      },
    }, null, 2);
    writeFileSync(path, original);

    await expect(recoverVerificationDay(DAY_ONE, dir)).rejects.toThrow("$.<record>");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("非法日期文件名不会在启动扫描中被静默忽略", async () => {
    const path: string = join(dir, "2026-02-30.json");
    writeFileSync(path, "{}");

    await expect(recoverVerificationDay(DAY_ONE, dir)).rejects.toThrow("$filename must be a canonical calendar date");
    expect(readFileSync(path, "utf8")).toBe("{}");
  });

  test("旧下划线键不再兼容，必须手动改成冒号格式", async () => {
    writeFileSync(join(dir, `${DAY_ONE}.json`), JSON.stringify({
      "-1001_42": { version: VERIFICATION_FILE_VERSION, ...snapshot(1) },
    }, null, 2));

    await expect(recoverVerificationDay(DAY_ONE, dir)).rejects.toThrow(
      "$.<record> must be a current verification record or null tombstone"
    );
  });

  test("旧版验证记录不在代码中兼容，必须停机后手工迁移", async () => {
    const path: string = join(dir, `${DAY_ONE}.json`);
    const original: string = JSON.stringify({
      "-1001:42": { version: 1, ...snapshot(1), messageIds: [7, 8] },
    }, null, 2);
    writeFileSync(path, original);

    await expect(recoverVerificationDay(DAY_ONE, dir)).rejects.toThrow(
      "$.<record> must be a current verification record or null tombstone"
    );
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("消息窗口随当天快照恢复，缺失当前必填字段时拒绝启动", async () => {
    await upsert({
      type: "verificationUpsert",
      record: snapshot(1, { trackedMessageTimes: [10_000, 20_000] }),
      critical: true,
    });
    expect((await recoverVerificationDay(DAY_ONE, dir)).get("-1001:42")?.trackedMessageTimes).toEqual([10_000, 20_000]);

    const incompatible: Record<string, unknown> = { version: VERIFICATION_FILE_VERSION, ...snapshot(2) };
    delete incompatible.trackedMessageTimes;
    const path: string = join(dir, `${DAY_ONE}.json`);
    const original: string = JSON.stringify({ "-1001:42": incompatible }, null, 2);
    writeFileSync(path, original);
    await expect(recoverVerificationDay(DAY_ONE, dir)).rejects.toThrow(
      "$.<record> must be a current verification record or null tombstone"
    );
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("成功播报标记只允许出现在 expelling 终态并可完整恢复", async () => {
    const { phase: _phase, ...pending } = snapshot(1);
    await upsert({
      type: "verificationUpsert",
      record: {
        ...pending,
        phase: "expelling",
        expelReason: "timeout",
        successNoticeSent: true,
      },
      critical: true,
    });
    expect((await recoverVerificationDay(DAY_ONE, dir)).get("-1001:42")?.successNoticeSent).toBe(true);

    const invalidPending: Record<string, unknown> = {
      ...snapshot(2),
      successNoticeSent: true,
    };
    writeFileSync(join(dir, `${DAY_ONE}.json`), JSON.stringify({
      "-1001:42": { version: VERIFICATION_FILE_VERSION, ...invalidPending },
    }));
    await expect(recoverVerificationDay(DAY_ONE, dir)).rejects.toThrow("$.<record> must be a current verification record");
  });

  test("checkingInviter 阶段可完整持久化并恢复", async () => {
    const { phase: _phase, ...pending } = snapshot(1);
    const record: VerificationSnapshot = {
      ...pending,
      phase: "checkingInviter",
      terminalInviterId: 88,
    };

    await upsert({
      type: "verificationUpsert",
      record,
      critical: true,
    });

    expect((await recoverVerificationDay(DAY_ONE, dir)).get("-1001:42")).toEqual(record);
  });
});
