import { describe, expect, test } from "bun:test";
import { ATMOSPHERE_TEXTS } from "../../../packages/consts/atmosphere";
import { VERIFICATION_TIMEOUT_MS } from "../../../packages/consts/antiRaid/verification";
import { formatMinSec } from "../../../packages/libs/time";
import { expelNoticeText } from "../../../packages/workers/antiRaid/verificationEffects/expelNotice";
import type { Atmosphere } from "../../../packages/types/atmosphere";
import type { AtmosphereNotices } from "../../../packages/types/atmosphereNotices";
import type { ExpelRemovalOutcome, VerificationCleanupResult } from "../../../packages/types/antiRaid/verification";

/**
 * 踢出终态播报文案的穷举表：两套文案 × 刷屏/超时 × 成员处置结果 × 清理结果 × 是否机器人，
 * 按「没踢走 → 原因」「踢走 + 清理欠账 → 清理结果」「踢走 + 清理干净 → 原因与身份」分组核对。
 */

const LABEL: string = "夹具成员";
const ATMOSPHERES: readonly Atmosphere[] = ["teasing", "plain"];
const REASONS: readonly ("timeout" | "flood")[] = ["timeout", "flood"];
const CLEAN: readonly VerificationCleanupResult[] = [
  { total: 0, missed: 0, permissionDenied: false },
  { total: 3, missed: 0, permissionDenied: false },
];
const FORBIDDEN: readonly VerificationCleanupResult[] = [
  { total: 3, missed: 3, permissionDenied: true },
  { total: 3, missed: 1, permissionDenied: true },
];
const TRANSIENT: readonly VerificationCleanupResult[] = [
  { total: 2, missed: 2, permissionDenied: false },
  { total: 3, missed: 1, permissionDenied: false },
];
const ALL_CLEANUPS: readonly VerificationCleanupResult[] = [...CLEAN, ...FORBIDDEN, ...TRANSIENT];

interface NoticeCase {
  readonly texts: AtmosphereNotices;
  readonly reason: "timeout" | "flood";
  readonly cleanup: VerificationCleanupResult;
  readonly isBot: boolean;
}

/** 给定清理结果集合，展开两套文案 × 两种原因 × 是否机器人。 */
function cases(cleanups: readonly VerificationCleanupResult[]): readonly NoticeCase[] {
  const result: NoticeCase[] = [];
  for (const atmosphere of ATMOSPHERES) {
    for (const reason of REASONS) {
      for (const cleanup of cleanups) {
        for (const isBot of [false, true]) {
          result.push({ texts: ATMOSPHERE_TEXTS[atmosphere].NOTICE_TEXTS, reason, cleanup, isBot });
        }
      }
    }
  }
  return result;
}

function notice(item: NoticeCase, removalOutcome: ExpelRemovalOutcome, kicked: boolean): string {
  return expelNoticeText({ ...item, removalOutcome, kicked, label: LABEL });
}

describe("踢出终态播报文案", () => {
  test("没踢走且成员或群类型未能确认时只说明未能确认，与原因、清理和身份无关", () => {
    for (const item of cases(ALL_CLEANUPS)) {
      expect(notice(item, "unconfirmed", false)).toBe(item.texts.verificationMembershipUnknown(LABEL));
      expect(notice(item, "kindUnknown", false)).toBe(item.texts.verificationChatKindUnknown(LABEL));
    }
  });

  test("没踢走的其余结果按刷屏或超时报踢人失败，与清理和身份无关", () => {
    for (const item of cases(ALL_CLEANUPS)) {
      const expected: string = item.reason === "flood"
        ? item.texts.verificationFloodKickFailed(LABEL)
        : item.texts.verificationTimeoutKickFailed(LABEL);
      for (const outcome of ["failed", "absent"] as const) {
        expect(notice(item, outcome, false)).toBe(expected);
      }
    }
  });

  test("踢走但清理被拒绝时报无删除权限，带消息总数与未删条数", () => {
    for (const item of cases(FORBIDDEN)) {
      for (const outcome of ["kicked", "absent"] as const) {
        expect(notice(item, outcome, true)).toBe(
          item.texts.verificationCleanupForbidden(LABEL, item.cleanup.total, item.cleanup.missed)
        );
      }
    }
  });

  test("踢走但清理瞬时失败时报未删条数", () => {
    for (const item of cases(TRANSIENT)) {
      for (const outcome of ["kicked", "absent"] as const) {
        expect(notice(item, outcome, true)).toBe(item.texts.verificationCleanupFailed(LABEL, item.cleanup.missed));
      }
    }
  });

  test("踢走且清理干净时按刷屏、机器人超时或成员超时播报", () => {
    const timeout: string = formatMinSec(VERIFICATION_TIMEOUT_MS);
    for (const item of cases(CLEAN)) {
      const expected: string = item.reason === "flood"
        ? item.texts.verificationFloodKicked(LABEL)
        : item.isBot
          ? item.texts.verificationBotTimeout(timeout, LABEL)
          : item.texts.verificationMemberTimeout(LABEL, timeout);
      for (const outcome of ["kicked", "absent"] as const) {
        expect(notice(item, outcome, true)).toBe(expected);
      }
    }
  });
});
