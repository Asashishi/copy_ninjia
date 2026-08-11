import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  AntiRaidWorkerEvent,
  PendingVerificationSnapshot,
  VerificationSnapshot,
  VerificationUpsertEvent,
} from "../../../packages/types";

let kicks: number = 0;
const deletedMessageIds: number[] = [];
let blockNextDelete: boolean = false;
let releaseBlockedDelete: (() => void) | undefined;
const reminderResults: (number | undefined)[] = [];
let reminderAttempts: number = 0;
const workerEvents: AntiRaidWorkerEvent[] = [];
Object.defineProperty(globalThis, "self", {
  configurable: true,
  value: { postMessage: (event: AntiRaidWorkerEvent): void => { workerEvents.push(event); } },
});

/** 两个删除入口共用一份实现：终态清理走三态版，其余路径只看成败。 */
async function recordDelete(messageId: number): Promise<string> {
  deletedMessageIds.push(messageId);
  if (blockNextDelete) {
    blockNextDelete = false;
    await new Promise<void>((resolve) => { releaseBlockedDelete = resolve; });
  }
  return messageId === 10 ? "failed" : "deleted";
}

mock.module("../../../packages/infra/logger", () => ({
  logger: { log(): void {}, info(): void {}, warn(): void {}, error(): void {} },
}));
mock.module("../../../packages/workers/antiRaid/verificationAttemptPermit", () => ({
  requestVerificationAttemptPermit: async () => ({ status: "granted", attempt: 1 }),
}));
mock.module("../../../packages/infra/telegram", () => ({
  joinVerificationApi: {
    getChat: async (): Promise<{ type: "supergroup" }> => ({ type: "supergroup" }),
  },
  sendMessage: async (): Promise<number | undefined> => {
    reminderAttempts++;
    // 队列为空按「发出去了」算。终态播报发不出去时不再算结算（见
    // verificationEffects/terminal.ts 的 removalConfirmed），默认返回 undefined
    // 会让每一个处置终态都停在等播报那一步；要模拟发送失败的用例自己往队列里
    // 放一个 undefined。
    return reminderResults.length > 0 ? reminderResults.shift() : 700;
  },
  deleteMessage: async (_chatId: number, messageId: number): Promise<boolean> =>
    (await recordDelete(messageId)) === "deleted",
  deleteMessageWithOutcome: async (_chatId: number, messageId: number): Promise<string> => recordDelete(messageId),
  deleteMessageAfter(): void {},
  kickChatMember: async (): Promise<boolean> => { kicks++; return true; },
  kickChatMemberWithOutcome: async (): Promise<"kicked"> => {
    kicks++;
    return "kicked";
  },
  probeChatMembership: async (): Promise<boolean> => true,
  answerCallbackQuery: async (): Promise<boolean> => true,
}));

const runtime = await import("../../../packages/workers/antiRaid/verificationRuntime");
const { verificationEntries } = await import("../../../packages/cache/workers/antiRaid/verification");

function record(
  userId: number,
  expiresAt: number
): PendingVerificationSnapshot {
  return {
    chatId: -1001,
    userId,
    generation: 9,
    revision: 1,
    phase: "pending",
    label: "待验证成员",
    isBot: false,
    trackedMessageTimes: [],
    reminderMessageId: 10,
    replyReminderRequested: false,
    reminderSuperseded: false,
    joinedAt: Date.now() - 1_000,
    expiresAt,
  };
}

function settleLatestTerminal(userId: number): void {
  const event = workerEvents.findLast((candidate): candidate is VerificationUpsertEvent =>
    candidate.type === "verificationUpsert" && candidate.record.userId === userId && candidate.record.phase !== "pending"
  );
  if (!event) throw new Error(`missing terminal upsert for ${userId}`);
  runtime.handleVerificationPersisted({
    type: "verificationPersisted",
    key: `${event.record.chatId}:${event.record.userId}`,
    generation: event.record.generation,
    revision: event.record.revision,
  });
}

beforeEach(() => {
  runtime.stopVerificationRuntime();
  kicks = 0;
  deletedMessageIds.length = 0;
  blockNextDelete = false;
  releaseBlockedDelete = undefined;
  reminderResults.length = 0;
  reminderAttempts = 0;
  workerEvents.length = 0;
});

afterEach(async () => {
  releaseBlockedDelete?.();
  await Bun.sleep(0);
  runtime.stopVerificationRuntime();
});

describe("Anti-Raid Worker verification recovery", () => {
  test("disableJoinGuardChat：删除已有提醒并终止其余处置", async () => {
    // 显式关闭时先删除仍带按钮的提醒，再作废超时踢出、终态处置和提醒补发。
    const pending: VerificationSnapshot = {
      ...record(42, Date.now() + 60_000),
      reminderMessageId: 11,
    };
    // 43 已经推进到终态（落盘完、就等踢人）：这一条最能说明「关掉之后不踢人」。
    const expiring: VerificationSnapshot = {
      ...record(43, Date.now() - 1),
      reminderMessageId: 12,
    };
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 1,
      verifications: [pending, expiring],
    });
    expect(verificationEntries.get("-1001:43")?.state.kind).toBe("expelling");
    deletedMessageIds.length = 0;
    workerEvents.length = 0;

    runtime.disableJoinGuardChat(-1001);
    await Bun.sleep(0);

    expect(verificationEntries.size).toBe(0);
    expect(deletedMessageIds).toEqual([11, 12]);
    expect(workerEvents.filter((event): boolean => event.type === "verificationDelete")).toHaveLength(2);
    expect(kicks).toBe(0);
    // 结算事件迟到时状态已经不在，不会再有后续动作。
    runtime.handleVerificationPersisted({
      type: "verificationPersisted",
      key: "-1001:43",
      generation: 1,
      revision: 2,
    });
    await Bun.sleep(0);
    expect(kicks).toBe(0);
  });

  test("deactivateVerificationChat：失去权限时只清状态，不调用 Telegram 删除 API", async () => {
    const pending: VerificationSnapshot = {
      ...record(46, Date.now() + 60_000),
      reminderMessageId: 13,
    };
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 1,
      verifications: [pending],
    });
    deletedMessageIds.length = 0;
    workerEvents.length = 0;

    runtime.deactivateVerificationChat(-1001);
    await Bun.sleep(0);

    expect(verificationEntries.size).toBe(0);
    expect(deletedMessageIds).toEqual([]);
    expect(workerEvents.filter((event): boolean => event.type === "verificationDelete")).toHaveLength(1);
  });

  test("别的群不受这次关闭影响", async () => {
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 1,
      verifications: [record(42, Date.now() + 60_000), { ...record(44, Date.now() + 60_000), chatId: -1002 }],
    });

    runtime.disableJoinGuardChat(-1001);
    await Bun.sleep(0);

    expect(verificationEntries.has("-1001:42")).toBeFalse();
    expect(verificationEntries.has("-1002:44")).toBeTrue();
  });

  test("adopt uses remaining expiry, replaces old timers, and handles expired records immediately", async () => {
    const active: VerificationSnapshot = record(42, Date.now() + 100);
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 1, verifications: [active] });
    const firstEntry = verificationEntries.get("-1001:42");
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 1, verifications: [active] });
    expect(verificationEntries.get("-1001:42")).toBe(firstEntry);

    runtime.adoptVerifications({ type: "adoptVerifications", generation: 2, verifications: [active] });
    await Bun.sleep(30);
    expect(kicks).toBe(0);
    await Bun.sleep(100);
    expect(kicks).toBe(0);
    settleLatestTerminal(42);
    await Bun.sleep(0);
    expect(kicks).toBe(1);
    // 踢完还要等那条成功播报：它先写进新 revision，收到那一版的落盘回执才结算
    // （见 verificationEffects/terminal.ts）。播报没发出去时终态不结算，人不会
    // 被静默地从群里抹掉而一句说明都没有。
    settleLatestTerminal(42);
    await Bun.sleep(0);

    const expired: VerificationSnapshot = record(43, Date.now() - 1);
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 3, verifications: [expired] });
    expect(verificationEntries.get("-1001:43")?.state.kind).toBe("expelling");
    settleLatestTerminal(43);
    await Bun.sleep(0);
    expect(kicks).toBe(2);
    settleLatestTerminal(43);
    await Bun.sleep(0);
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 3, verifications: [expired] });
    await Bun.sleep(0);

    const verified: VerificationSnapshot = record(44, Date.now() + 10_000);
    const left: VerificationSnapshot = record(45, Date.now() + 10_000);
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 4, verifications: [verified, left] });
    runtime.dispatchVerification(-1001, 44, {
      type: "callback",
      callbackQueryId: "callback-44",
      isSelf: true,
      fromIsPrivileged: false,
      fromLabel: "本人",
    });
    runtime.dispatchVerification(-1001, 45, { type: "left" });
    await Bun.sleep(0);

    expect(kicks).toBe(2);
    expect(verificationEntries.has("-1001:44") || verificationEntries.has("-1001:45")).toBeFalse();
    expect(workerEvents.filter((event) => event.type === "verificationDelete").map((event) => ({
      generation: event.generation,
      revision: event.revision,
      userId: event.userId,
    }))).toEqual([
      // revision 比 44/45 多一格：处置终态在踢完之后还要为「成功播报已发出」
      // 再写一版快照，收到那一版的回执才结算。
      { generation: 2, revision: 4, userId: 42 },
      { generation: 3, revision: 4, userId: 43 },
      { generation: 4, revision: 2, userId: 44 },
      { generation: 4, revision: 2, userId: 45 },
    ]);
  });

  test("恢复部分完成的 expelling，并在同 userId 新一代入群后停止旧踢人", async () => {
    const baselineKicks: number = kicks;
    deletedMessageIds.length = 0;
    const { phase: _phase, ...pending } = record(50, Date.now());
    const terminal: VerificationSnapshot = {
      ...pending,
      generation: 5,
      phase: "expelling",
      expelReason: "timeout",
      replyReminderMessageId: 11,
    };
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 5,
      verifications: [terminal],
      resumePersistedTerminals: true,
    });
    await Bun.sleep(0);
    // 10 代表崩溃前已经删除过、恢复时 API 返回“目标不存在”；仍会继续清理 11 并踢人。
    expect(deletedMessageIds).toEqual([10, 11]);
    expect(kicks).toBe(baselineKicks + 1);

    const nextTerminal: VerificationSnapshot = {
      ...terminal,
      userId: 51,
      generation: 6,
      revision: 1,
    };
    blockNextDelete = true;
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 6,
      verifications: [nextTerminal],
      resumePersistedTerminals: true,
    });
    await Bun.sleep(0);
    const beforeRejoinKicks: number = kicks;
    runtime.dispatchVerification(-1001, 51, {
      type: "join",
      memberId: 51,
      label: "重新入群",
      isBot: false,
      identityExempt: false,
      actorSyncExempt: false,
      adminCacheFresh: true,
      lockdownActive: false,
      now: Date.now() + 1,
    });
    expect(verificationEntries.get("-1001:51")?.state.kind).toBe("pending");
    releaseBlockedDelete!();
    await Bun.sleep(0);
    expect(kicks).toBe(beforeRejoinKicks);
  });

  test("同代更高 revision 覆盖时取消旧 timer，不按旧期限提前超时", async () => {
    const now: number = Date.now();
    const original: VerificationSnapshot = {
      ...record(60, now + 50),
      generation: 7,
      revision: 1,
    };
    const extended: VerificationSnapshot = {
      ...original,
      revision: 2,
      expiresAt: now + 10_000,
    };

    runtime.adoptVerifications({ type: "adoptVerifications", generation: 7, verifications: [original] });
    const originalEntry = verificationEntries.get("-1001:60");
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 7, verifications: [extended] });
    expect(verificationEntries.get("-1001:60")).not.toBe(originalEntry);

    await Bun.sleep(100);
    expect(verificationEntries.get("-1001:60")?.state.kind).toBe("pending");

    // 清理延长后的计时器，避免测试进程等待或影响后续用例。
    runtime.adoptVerifications({ type: "adoptVerifications", generation: 8, verifications: [] });
  });

  test("恢复时未有已落地提醒会重发，首次失败后自动重试并从真正落地时重置窗口", async () => {
    const baselineAttempts: number = reminderAttempts;
    reminderResults.push(undefined, 701);
    const before: number = Date.now();
    const pendingWithoutReminder: VerificationSnapshot = {
      ...record(70, before + 10_000),
      generation: 9,
      reminderMessageId: undefined,
    };

    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 9,
      verifications: [pendingWithoutReminder],
    });
    await Bun.sleep(20);
    expect(reminderAttempts).toBe(baselineAttempts + 1);
    expect(verificationEntries.get("-1001:70")?.state).toMatchObject({
      kind: "pending",
      reminderMessageId: undefined,
    });

    await Bun.sleep(1_050);
    const recovered = verificationEntries.get("-1001:70")?.state;
    expect(reminderAttempts).toBe(baselineAttempts + 2);
    expect(recovered).toMatchObject({ kind: "pending", reminderMessageId: 701 });
    expect(recovered?.kind === "pending" ? recovered.expiresAt : 0).toBeGreaterThanOrEqual(before + 90_000);

    runtime.adoptVerifications({ type: "adoptVerifications", generation: 10, verifications: [] });
  });

  test("私密模式删公告期间到达的管理员豁免会失效旧踢人动作", async () => {
    const baselineKicks: number = kicks;
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 10,
      verifications: [],
    });
    blockNextDelete = true;
    runtime.dispatchVerification(-2001, 80, {
      type: "join",
      memberId: 80,
      label: "管理员",
      isBot: false,
      announcementMessageId: 80,
      identityExempt: false,
      actorSyncExempt: false,
      adminCacheFresh: true,
      lockdownActive: true,
      now: 80_000,
    });
    settleLatestTerminal(80);
    await Bun.sleep(0);
    expect(verificationEntries.get("-2001:80")?.state.kind).toBe("kickPending");

    runtime.dispatchVerification(-2001, 80, {
      type: "join",
      memberId: 80,
      label: "管理员",
      isBot: false,
      identityExempt: true,
      actorSyncExempt: false,
      adminCacheFresh: true,
      lockdownActive: true,
      now: 80_001,
    });
    expect(verificationEntries.get("-2001:80")?.state.kind).toBe("exempt");

    releaseBlockedDelete!();
    await Bun.sleep(0);
    expect(kicks).toBe(baselineKicks);
    runtime.deactivateVerificationChat(-2001);
  });

  test("进程恢复会重放已落盘但尚未结算的私密模式踢人", async () => {
    const baselineKicks: number = kicks;
    const snapshot: VerificationSnapshot = {
      chatId: -2010,
      userId: 90,
      generation: 13,
      revision: 2,
      phase: "kickPending",
      label: "重启前待踢成员",
      isBot: false,
      trackedMessageTimes: [],
      replyReminderRequested: false,
      reminderSuperseded: true,
      joinedAt: 90_000,
      expiresAt: 90_000,
      requestedAt: 90_000,
      countedJoinAt: 90_000,
    };

    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 13,
      verifications: [snapshot],
      resumePersistedTerminals: true,
    });
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(kicks).toBe(baselineKicks + 1);
    expect(verificationEntries.get("-2010:90")?.state.kind).toBe("kicked");
    expect(workerEvents.some((event: AntiRaidWorkerEvent): boolean =>
      event.type === "verificationDelete" && event.chatId === -2010 && event.userId === 90
    )).toBeTrue();
  });

  test("停管会失效仍在删除公告的私密模式踢人动作", async () => {
    const baselineKicks: number = kicks;
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 11,
      verifications: [],
    });
    blockNextDelete = true;
    runtime.dispatchVerification(-2002, 81, {
      type: "join",
      memberId: 81,
      label: "待踢成员",
      isBot: false,
      announcementMessageId: 81,
      identityExempt: false,
      actorSyncExempt: false,
      adminCacheFresh: true,
      lockdownActive: true,
      now: 81_000,
    });
    settleLatestTerminal(81);
    await Bun.sleep(0);

    runtime.deactivateVerificationChat(-2002);
    releaseBlockedDelete!();
    await Bun.sleep(0);
    expect(kicks).toBe(baselineKicks);
    expect(verificationEntries.has("-2002:81")).toBeFalse();
  });

  test("同 userId 新一代记录会失效旧踢人动作，正常路径仍只踢一次", async () => {
    const baselineKicks: number = kicks;
    runtime.adoptVerifications({
      type: "adoptVerifications",
      generation: 12,
      verifications: [],
    });
    blockNextDelete = true;
    runtime.dispatchVerification(-2003, 82, {
      type: "join",
      memberId: 82,
      label: "旧一代",
      isBot: false,
      announcementMessageId: 82,
      identityExempt: false,
      actorSyncExempt: false,
      adminCacheFresh: true,
      lockdownActive: true,
      now: 82_000,
    });
    settleLatestTerminal(82);
    await Bun.sleep(0);

    runtime.dispatchVerification(-2003, 82, { type: "left" });
    runtime.dispatchVerification(-2003, 82, {
      type: "join",
      memberId: 82,
      label: "新一代",
      isBot: false,
      identityExempt: false,
      actorSyncExempt: false,
      adminCacheFresh: true,
      lockdownActive: false,
      // 这一路建的是 pending，解释器按 `expiresAt - Date.now()` 起验证计时器。
      // 合成的小时间戳会让 expiresAt 早已过期、计时器以 0 ms 触发，下面那句
      // 断言就得和它抢同一个宏任务——机器一慢（覆盖率插桩时尤其）状态就已经
      // 转成 expelling 了。用真实时钟起算，让记录在断言期间稳稳停在 pending。
      now: Date.now(),
    });
    releaseBlockedDelete!();
    await Bun.sleep(0);
    expect(kicks).toBe(baselineKicks);
    expect(verificationEntries.get("-2003:82")?.state.kind).toBe("pending");
    runtime.deactivateVerificationChat(-2003);

    runtime.dispatchVerification(-2004, 83, {
      type: "join",
      memberId: 83,
      label: "正常秒踢",
      isBot: false,
      identityExempt: false,
      actorSyncExempt: false,
      adminCacheFresh: true,
      lockdownActive: true,
      now: 83_000,
    });
    settleLatestTerminal(83);
    await Bun.sleep(0);
    expect(kicks).toBe(baselineKicks + 1);
    expect(verificationEntries.get("-2004:83")?.state.kind).toBe("kicked");
    runtime.deactivateVerificationChat(-2004);
  });
});
