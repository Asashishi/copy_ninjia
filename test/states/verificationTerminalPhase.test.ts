import { describe, expect, test } from "bun:test";
import { isTerminalVerificationPhase } from "../../packages/states/verification/shared";

describe("验证终态执行段判定", () => {
  test("只有 kickPending / checkingInviter / expelling 属于终态执行段", () => {
    for (const phase of ["kickPending", "checkingInviter", "expelling"] as const) {
      expect(isTerminalVerificationPhase(phase)).toBeTrue();
    }
    for (const phase of ["pending", "exempt", "kicked", undefined] as const) {
      expect(isTerminalVerificationPhase(phase)).toBeFalse();
    }
  });
});
