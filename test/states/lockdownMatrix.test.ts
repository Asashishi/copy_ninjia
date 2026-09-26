import { describe, expect, test } from "bun:test";
import { transitionLockdown } from "../../packages/states/lockdown";
import type { LockdownPhase } from "../../packages/types/chatState";
import type { LockdownAnnouncement, LockdownEffect, LockdownMachineEvent, LockdownState, LockdownTransition } from "../../packages/types/states/lockdown";

const PERMS: Readonly<{ can_send_messages: boolean }> = { can_send_messages: true };
const ANNOUNCEMENT_MESSAGE_ID: number = 900;
const ANNOUNCED: LockdownAnnouncement = { announced: true, announcementPending: false, announcementMessageId: ANNOUNCEMENT_MESSAGE_ID };

/** 矩阵行：每个状态 kind 一行，APPLYING 按 stage 拆成两行。 */
type LockdownRowLabel =
  | "inactive"
  | "applying:preparing"
  | "applying:prepared"
  | "active"
  | "reconciling"
  | "restoring";
/** 转移后的 next：删除记录、原样返回同一对象，或新对象所在阶段。 */
type LockdownNextLabel = Exclude<LockdownRowLabel, "inactive"> | "inactive" | "same";
/** 矩阵列：每个事件类型一列，带 ok 的结果事件拆成成功与失败两列。 */
type LockdownColumnLabel =
  | Exclude<LockdownMachineEvent["type"], "applyResult" | "restoreResult" | "reapplyResult">
  | "applyResult:ok"
  | "applyResult:failed"
  | "restoreResult:ok"
  | "restoreResult:failed"
  | "reapplyResult:ok"
  | "reapplyResult:failed";
type LockdownCell = readonly [LockdownNextLabel, readonly LockdownEffect["kind"][]];

const MATRIX_INTENT_ID: number = 7;

/** 每格现造一份状态；除 preparing 外都带一条已落地的封锁公告。 */
const LOCKDOWN_ROWS: Readonly<Record<LockdownRowLabel, () => LockdownState | undefined>> = {
  inactive: (): LockdownState | undefined => undefined,
  "applying:preparing": (): LockdownState => ({
    kind: "applying",
    stage: "preparing",
    announced: false,
    announcementPending: true,
    announcementMessageId: undefined,
  }),
  "applying:prepared": (): LockdownState => ({
    kind: "applying",
    stage: "prepared",
    originalPermissions: PERMS,
    intentId: MATRIX_INTENT_ID,
    commitStarted: false,
    ...ANNOUNCED,
  }),
  active: (): LockdownState => ({
    kind: "active",
    originalPermissions: PERMS,
    intentId: MATRIX_INTENT_ID,
    ...ANNOUNCED,
  }),
  reconciling: (): LockdownState => ({
    kind: "reconciling",
    originalPermissions: PERMS,
    intentId: MATRIX_INTENT_ID,
    reapplyAfterPersist: true,
    ...ANNOUNCED,
  }),
  restoring: (): LockdownState => ({
    kind: "restoring",
    originalPermissions: PERMS,
    intentId: MATRIX_INTENT_ID,
    restoreAfterPersist: true,
    ...ANNOUNCED,
  }),
};

/** 落盘回执与落盘失败按当前阶段和 intent 投递；INACTIVE 投 active 阶段。 */
function persistedPhaseOf(state: LockdownState | undefined): LockdownPhase {
  return state?.kind ?? "active";
}

const LOCKDOWN_COLUMNS: Readonly<Record<
  LockdownColumnLabel,
  (state: LockdownState | undefined) => LockdownMachineEvent
>> = {
  thresholdExceeded: (): LockdownMachineEvent => ({ type: "thresholdExceeded", joinCount: 46 }),
  applyPrepared: (): LockdownMachineEvent => ({
    type: "applyPrepared",
    originalPermissions: PERMS,
    intentId: MATRIX_INTENT_ID,
  }),
  applyPreparationFailed: (): LockdownMachineEvent => ({ type: "applyPreparationFailed" }),
  applyCommitPreparationFailed: (): LockdownMachineEvent => ({ type: "applyCommitPreparationFailed" }),
  statePersisted: (state: LockdownState | undefined): LockdownMachineEvent => ({
    type: "statePersisted",
    phase: persistedPhaseOf(state),
    intentId: MATRIX_INTENT_ID,
  }),
  persistFailed: (state: LockdownState | undefined): LockdownMachineEvent => ({
    type: "persistFailed",
    phase: persistedPhaseOf(state),
    intentId: MATRIX_INTENT_ID,
  }),
  "applyResult:ok": (): LockdownMachineEvent => ({ type: "applyResult", ok: true }),
  "applyResult:failed": (): LockdownMachineEvent => ({
    type: "applyResult",
    ok: false,
    restoreIntentId: MATRIX_INTENT_ID + 1,
  }),
  restoreTimerFired: (): LockdownMachineEvent => ({
    type: "restoreTimerFired",
    intentId: MATRIX_INTENT_ID + 1,
  }),
  restoreRetryFired: (): LockdownMachineEvent => ({ type: "restoreRetryFired" }),
  reapplyRetryFired: (): LockdownMachineEvent => ({ type: "reapplyRetryFired" }),
  deactivate: (): LockdownMachineEvent => ({ type: "deactivate", intentId: MATRIX_INTENT_ID + 1 }),
  "restoreResult:ok": (): LockdownMachineEvent => ({ type: "restoreResult", ok: true }),
  "restoreResult:failed": (): LockdownMachineEvent => ({ type: "restoreResult", ok: false }),
  "reapplyResult:ok": (): LockdownMachineEvent => ({ type: "reapplyResult", ok: true }),
  "reapplyResult:failed": (): LockdownMachineEvent => ({ type: "reapplyResult", ok: false }),
  announcementResult: (): LockdownMachineEvent => ({
    type: "announcementResult",
    ok: true,
    messageId: ANNOUNCEMENT_MESSAGE_ID + 1,
  }),
  adopt: (): LockdownMachineEvent => ({
    type: "adopt",
    phase: "active",
    originalPermissions: PERMS,
    intentId: MATRIX_INTENT_ID + 2,
    announced: true,
    announcementMessageId: ANNOUNCEMENT_MESSAGE_ID,
    remainingMs: 60_000,
    persisted: true,
  }),
};

/** 每个事件类型都至少落在一列上；新增事件类型时这里先编译失败。 */
const LOCKDOWN_COLUMNS_BY_EVENT_TYPE: Readonly<Record<
  LockdownMachineEvent["type"],
  readonly LockdownColumnLabel[]
>> = {
  thresholdExceeded: ["thresholdExceeded"],
  applyPrepared: ["applyPrepared"],
  applyPreparationFailed: ["applyPreparationFailed"],
  applyCommitPreparationFailed: ["applyCommitPreparationFailed"],
  statePersisted: ["statePersisted"],
  persistFailed: ["persistFailed"],
  applyResult: ["applyResult:ok", "applyResult:failed"],
  restoreTimerFired: ["restoreTimerFired"],
  restoreRetryFired: ["restoreRetryFired"],
  reapplyRetryFired: ["reapplyRetryFired"],
  deactivate: ["deactivate"],
  restoreResult: ["restoreResult:ok", "restoreResult:failed"],
  reapplyResult: ["reapplyResult:ok", "reapplyResult:failed"],
  announcementResult: ["announcementResult"],
  adopt: ["adopt"],
};

const SAME: LockdownCell = ["same", []];
const GONE: LockdownCell = ["inactive", []];

/** 已有状态的行里，除列出的格子外一律原样保留、不发效果。 */
function lockdownRow(cells: Partial<Record<LockdownColumnLabel, LockdownCell>>): Record<LockdownColumnLabel, LockdownCell> {
  const row: Partial<Record<LockdownColumnLabel, LockdownCell>> = {};
  for (const column of Object.keys(LOCKDOWN_COLUMNS) as LockdownColumnLabel[]) {
    row[column] = cells[column] ?? SAME;
  }
  return row as Record<LockdownColumnLabel, LockdownCell>;
}

const LOCKDOWN_MATRIX: Readonly<Record<LockdownRowLabel, Readonly<Record<LockdownColumnLabel, LockdownCell>>>> = {
  inactive: {
    thresholdExceeded: ["applying:preparing", ["prefetchAdmins", "beginLockdownAnnouncement", "prepareApply"]],
    applyPrepared: GONE,
    applyPreparationFailed: GONE,
    applyCommitPreparationFailed: GONE,
    statePersisted: GONE,
    persistFailed: GONE,
    "applyResult:ok": GONE,
    "applyResult:failed": GONE,
    restoreTimerFired: GONE,
    restoreRetryFired: GONE,
    reapplyRetryFired: GONE,
    deactivate: GONE,
    "restoreResult:ok": GONE,
    "restoreResult:failed": GONE,
    "reapplyResult:ok": GONE,
    "reapplyResult:failed": GONE,
    announcementResult: ["inactive", ["deleteLockdownAnnouncement"]],
    adopt: ["active", ["prefetchAdmins", "scheduleRestore"]],
  },
  "applying:preparing": lockdownRow({
    thresholdExceeded: ["same", ["prefetchAdmins"]],
    applyPrepared: ["applying:prepared", ["persistState"]],
    applyPreparationFailed: ["inactive", ["suppressRetrigger"]],
    deactivate: GONE,
    announcementResult: ["applying:preparing", []],
  }),
  "applying:prepared": lockdownRow({
    thresholdExceeded: ["same", ["prefetchAdmins"]],
    applyCommitPreparationFailed: ["inactive", ["reportUnlock", "deleteLockdownAnnouncement", "suppressRetrigger"]],
    statePersisted: ["applying:prepared", ["commitApply"]],
    persistFailed: ["inactive", ["reportUnlock", "deleteLockdownAnnouncement", "suppressRetrigger"]],
    "applyResult:ok": ["active", ["scheduleRestore", "persistState"]],
    "applyResult:failed": ["restoring", ["persistState"]],
    deactivate: ["restoring", ["persistState"]],
  }),
  active: lockdownRow({
    thresholdExceeded: ["same", ["prefetchAdmins"]],
    persistFailed: ["restoring", ["persistState", "beginRestore", "suppressRetrigger"]],
    restoreTimerFired: ["restoring", ["persistState"]],
    deactivate: ["restoring", ["persistState"]],
    "restoreResult:ok": ["reconciling", ["persistState"]],
  }),
  reconciling: lockdownRow({
    thresholdExceeded: ["same", ["prefetchAdmins"]],
    statePersisted: ["reconciling", ["beginReapply"]],
    persistFailed: ["restoring", ["persistState", "beginRestore", "suppressRetrigger"]],
    restoreTimerFired: ["restoring", ["persistState"]],
    reapplyRetryFired: ["same", ["beginReapply"]],
    deactivate: ["restoring", ["persistState"]],
    "reapplyResult:ok": ["active", ["persistState"]],
    "reapplyResult:failed": ["same", ["scheduleReapplyRetry"]],
  }),
  restoring: lockdownRow({
    thresholdExceeded: ["same", ["prefetchAdmins"]],
    statePersisted: ["restoring", ["beginRestore"]],
    persistFailed: ["restoring", ["beginRestore", "suppressRetrigger"]],
    restoreRetryFired: ["same", ["beginRestore"]],
    deactivate: ["restoring", ["persistState"]],
    "restoreResult:ok": ["inactive", ["reportUnlock", "deleteLockdownAnnouncement", "announceUnlock"]],
    "restoreResult:failed": ["same", ["scheduleRestoreRetry"]],
  }),
};

function lockdownNextLabel(
  before: LockdownState | undefined,
  next: LockdownState | undefined
): LockdownNextLabel {
  if (next === undefined) return "inactive";
  if (next === before) return "same";
  if (next.kind !== "applying") return next.kind;
  return next.stage === "preparing" ? "applying:preparing" : "applying:prepared";
}

describe("状态 × 事件矩阵", () => {
  test("矩阵列覆盖全部事件类型，每列投递的事件类型与所属类型一致", () => {
    const columns: LockdownColumnLabel[] = [];
    for (const [type, labels] of Object.entries(LOCKDOWN_COLUMNS_BY_EVENT_TYPE)) {
      for (const label of labels) {
        expect(LOCKDOWN_COLUMNS[label](undefined).type).toBe(type as LockdownMachineEvent["type"]);
        columns.push(label);
      }
    }
    expect(columns.sort()).toEqual(Object.keys(LOCKDOWN_COLUMNS).sort() as LockdownColumnLabel[]);
  });

  for (const row of Object.keys(LOCKDOWN_ROWS) as LockdownRowLabel[]) {
    test(`${row} 行：每个事件的 next 阶段与效果种类`, () => {
      const actual: Partial<Record<LockdownColumnLabel, LockdownCell>> = {};
      for (const column of Object.keys(LOCKDOWN_COLUMNS) as LockdownColumnLabel[]) {
        const before: LockdownState | undefined = LOCKDOWN_ROWS[row]();
        const transition: LockdownTransition =
          transitionLockdown(before, LOCKDOWN_COLUMNS[column](before));
        actual[column] = [
          lockdownNextLabel(before, transition.next),
          transition.effects.map((effect: LockdownEffect): LockdownEffect["kind"] => effect.kind),
        ];
      }
      expect(actual).toEqual(LOCKDOWN_MATRIX[row]);
    });
  }

  test("恢复重试计时器到点：只有 RESTORING 按原权限再发一次恢复，状态对象不变", () => {
    const restoring: LockdownState | undefined = LOCKDOWN_ROWS.restoring();
    const retried: LockdownTransition = transitionLockdown(restoring, { type: "restoreRetryFired" });
    expect(retried.next).toBe(restoring);
    expect(retried.effects).toEqual([{ kind: "beginRestore", originalPermissions: PERMS }]);

    const active: LockdownState | undefined = LOCKDOWN_ROWS.active();
    const ignored: LockdownTransition = transitionLockdown(active, { type: "restoreRetryFired" });
    expect(ignored.next).toBe(active);
    expect(ignored.effects).toEqual([]);
  });
});
