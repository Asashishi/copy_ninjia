import { describe, expect, test } from "bun:test";
import { assertTemporaryAdBypassActivity } from "../../packages/database/codec/temporaryAdBypass";
import {
  TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD,
  TEMPORARY_AD_BYPASS_REQUIRED_DAYS,
} from "../../packages/consts/temporaryAdBypass";
import { getTokyoDayIndex } from "../../packages/libs/time";
import { InputValidationError } from "../../packages/libs/inputValidation";
import type { TemporaryAdBypassActivity } from "../../packages/types/temporaryAdBypass";

/**
 * 临时广告免检关系列的严格校验：**每一条拒绝分支**都要真的拒绝。
 *
 * 这是 AGENTS.md「不为用户行为兜底」在持久化侧的落点——被改坏的行必须在启动阶段
 * 致命退出，不得被默认值回填、静默修复或降级运行掩盖。校验器只有拒绝分支被逐条
 * 钉住才算数：写错一个比较方向不会让任何正例失败，只会让一整类坏行悄悄通过。
 *
 * 另一半契约是**错误信息只写来源、字段路径与期望形态**，不得回显实际值，因此
 * 每条断言同时核对抛出的是 InputValidationError 且消息命中对应字段路径。
 */

const SOURCE: string = "temporary_ad_bypass_activity[42]";

/** 东京日内一个固定时刻，避免用例跨自然日边界抖动。 */
const NOW: number = Date.UTC(2026, 0, 15, 3, 0, 0);

/** 一条完全合法的「已获临时免检、当日已达标」记录；各用例只改一处。 */
function validActivity(): TemporaryAdBypassActivity {
  return {
    adBypass: true,
    adBypassGrantedAt: NOW - 1_000,
    qualifiedDays: 1,
    sendCount: TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD + 1,
    countedAt: NOW,
    qualifiedAt: NOW - 500,
  };
}

/** 一条尚未达标的记录：未获免检、当日计数未过阈值。 */
function unqualifiedActivity(): TemporaryAdBypassActivity {
  return {
    adBypass: false,
    adBypassGrantedAt: null,
    qualifiedDays: 0,
    sendCount: 1,
    countedAt: NOW,
    qualifiedAt: null,
  };
}

function expectRejected(
  activity: Readonly<TemporaryAdBypassActivity>,
  fieldPath: string
): void {
  let thrown: unknown;
  try {
    assertTemporaryAdBypassActivity(activity, SOURCE);
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(InputValidationError);
  const message: string = (thrown as InputValidationError).message;
  expect(message).toContain(SOURCE);
  expect(message).toContain(fieldPath);
}

describe("临时广告免检关系列的严格校验", () => {
  test("两种合法形态都通过", () => {
    expect((): void => assertTemporaryAdBypassActivity(validActivity(), SOURCE)).not.toThrow();
    expect((): void => assertTemporaryAdBypassActivity(unqualifiedActivity(), SOURCE)).not.toThrow();
  });

  test("ad_bypass 不是布尔一律拒绝", () => {
    expectRejected(
      { ...validActivity(), adBypass: 1 as unknown as boolean },
      "$.ad_bypass"
    );
  });

  test("qualified_days 越界或非整数一律拒绝", () => {
    expectRejected({ ...validActivity(), qualifiedDays: -1 }, "$.qualified_days");
    expectRejected({ ...validActivity(), qualifiedDays: 1.5 }, "$.qualified_days");
    expectRejected(
      { ...validActivity(), qualifiedDays: TEMPORARY_AD_BYPASS_REQUIRED_DAYS + 1 },
      "$.qualified_days"
    );
  });

  test("send_count 非正整数一律拒绝", () => {
    expectRejected({ ...validActivity(), sendCount: 0 }, "$.send_count");
    expectRejected({ ...validActivity(), sendCount: -3 }, "$.send_count");
    expectRejected({ ...validActivity(), sendCount: 2.5 }, "$.send_count");
  });

  test("三个时间列都必须是非负安全整数毫秒", () => {
    expectRejected({ ...validActivity(), countedAt: -1 }, "$.counted_at");
    expectRejected({ ...validActivity(), countedAt: 1.5 }, "$.counted_at");
    expectRejected({ ...validActivity(), adBypassGrantedAt: -1 }, "$.ad_bypass_granted_at");
    expectRejected(
      { ...validActivity(), qualifiedAt: Number.NaN },
      "$.qualified_at"
    );
  });

  test("ad_bypass 与 ad_bypass_granted_at 必须同真同假", () => {
    // 有免检时刻却没置位：读回来这个人会被当成没拿到豁免，广告链路照常送检。
    expectRejected(
      { ...validActivity(), adBypass: false, qualifiedDays: 0 },
      "$.ad_bypass"
    );
    // 置了位却没有免检时刻：豁免起点无从考据。
    expectRejected({ ...validActivity(), adBypassGrantedAt: null }, "$.ad_bypass");
  });

  test("未获免检时连续合格日必须为 0", () => {
    expectRejected(
      { ...unqualifiedActivity(), qualifiedDays: 3 },
      "$.ad_bypass"
    );
  });

  test("ad_bypass_granted_at 不得晚于 counted_at", () => {
    expectRejected(
      { ...validActivity(), adBypassGrantedAt: NOW + 1 },
      "$.ad_bypass_granted_at"
    );
  });

  test("当日计数已过阈值却没有 qualified_at 一律拒绝", () => {
    expectRejected(
      {
        ...unqualifiedActivity(),
        sendCount: TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD + 1,
      },
      "$.qualified_at"
    );
  });

  test("有 qualified_at 但当日计数不足、连续日为 0 或跨日一律拒绝", () => {
    expectRejected(
      {
        ...validActivity(),
        sendCount: TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD,
      },
      "$.qualified_at"
    );
    // 连续日为 0 却带着达标时刻：由 qualified_at 那一组一致性判定认领。
    expectRejected({ ...validActivity(), qualifiedDays: 0 }, "$.qualified_at");
    expectRejected({ ...validActivity(), qualifiedAt: NOW + 1 }, "$.qualified_at");

    // 达标时刻必须落在 counted_at 所属的那个东京日里：跨日就说明这一行的
    // 「当日累计」和「当日达标」指的不是同一天，连续日计数不再可信。
    const previousDay: number = NOW - 48 * 60 * 60 * 1000;
    expect(getTokyoDayIndex(previousDay)).not.toBe(getTokyoDayIndex(NOW));
    expectRejected(
      { ...validActivity(), qualifiedAt: previousDay, adBypassGrantedAt: previousDay },
      "$.qualified_at"
    );
  });

  test("ad_bypass_granted_at 不得晚于 qualified_at", () => {
    expectRejected(
      { ...validActivity(), adBypassGrantedAt: NOW - 100, qualifiedAt: NOW - 200 },
      "$.ad_bypass_granted_at"
    );
  });

  test("错误信息只写来源、字段路径与期望形态，不回显实际值", () => {
    let thrown: unknown;
    try {
      assertTemporaryAdBypassActivity(
        { ...validActivity(), sendCount: -987_654 },
        SOURCE
      );
    } catch (error: unknown) {
      thrown = error;
    }
    const message: string = (thrown as InputValidationError).message;
    expect(message).toBe(`${SOURCE}: $.send_count must be a positive safe integer.`);
    expect(message).not.toContain("987");
  });
});
