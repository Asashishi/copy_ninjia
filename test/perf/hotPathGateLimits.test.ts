import { describe, expect, test } from "bun:test";
import {
  assertHotPathMedianPolicyCoverage,
  createHotPathMedianLatencyReport,
} from "../../scripts/perf/hotPaths/gateLimits";

describe("热路径纳秒软上报", () => {
  test("不超过阈值时没有报告，超过时返回完整超额内容但不抛错", () => {
    expect(createHotPathMedianLatencyReport({
      scenario: "steady",
      medianNsPerOp: 25,
      bunRevision: "revision-test",
      reportThresholdNsPerOp: 25,
    })).toBeNull();
    expect(createHotPathMedianLatencyReport({
      scenario: "steady",
      medianNsPerOp: 30,
      bunRevision: "revision-test",
      reportThresholdNsPerOp: 25,
    })).toEqual({
      scenario: "steady",
      medianNsPerOp: 30,
      reportThresholdNsPerOp: 25,
      overrunNsPerOp: 5,
      overrunPercent: 20,
      bunRevision: "revision-test",
    });
  });

  test("默认场景与阈值表必须精确覆盖", () => {
    expect((): unknown => assertHotPathMedianPolicyCoverage(
      ["one", "two"],
      { one: 1, two: 2 }
    )).not.toThrow();
    expect((): unknown => assertHotPathMedianPolicyCoverage(
      ["one", "two"],
      { one: 1 }
    )).toThrow("two has no positive median policy");
    expect((): unknown => assertHotPathMedianPolicyCoverage(
      ["one"],
      { one: 1, stale: 2 }
    )).toThrow("stale has no default scenario");
    expect((): unknown => assertHotPathMedianPolicyCoverage(
      ["one", "one"],
      { one: 1 }
    )).toThrow("one is duplicated");
    expect((): unknown => assertHotPathMedianPolicyCoverage(
      ["one"],
      { one: 0 }
    )).toThrow("one has no positive median policy");
  });

  test("校验通过后交回场景 -> 阈值表，门禁不必再回表查一次", () => {
    // 阈值契约只有这一个 owner：createHotPathMedianLatencyReport 直接吃这里给出的
    // 数，两处各判一次会让将来改阈值形状必须同步改两个地方才自洽。
    const policy: ReadonlyMap<string, number> = assertHotPathMedianPolicyCoverage(
      ["first", "second"],
      { first: 10, second: 20 }
    );

    expect([...policy]).toEqual([["first", 10], ["second", 20]]);
  });
});
