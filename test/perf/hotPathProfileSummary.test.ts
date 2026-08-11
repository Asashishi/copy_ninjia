import { describe, expect, test } from "bun:test";
import { summarizeHotPathSamplingProfile } from "../../scripts/perf/hotPaths/profileSummary";

describe("hot path JSC profile summary", () => {
  test("只统计稳态采样中的 GC，并读取 JIT tier 百分比", () => {
    expect(summarizeHotPathSamplingProfile({
      functions: `
Sampling rate: 1000.000000 microseconds. Total samples: 200
Top functions as <numSamples  'functionName#hash:sourceID'>
   150    'hot#abc:1'
    10    'gc#<nil>:4294967295'
`,
      bytecodes: `
Tier breakdown:
-----------------------------------
LLInt:                     0  (0.000000%)
Baseline:                  2  (1.000000%)
DFG:                      18  (9.000000%)
FTL:                     160  (80.000000%)
`,
    })).toEqual({
      totalSamples: 200,
      gcSamples: 10,
      gcPercent: 5,
      llintPercent: 0,
      baselinePercent: 1,
      dfgPercent: 9,
      ftlPercent: 80,
    });
  });

  test("采样格式缺字段时响亮失败，不把未知读数当零", () => {
    expect((): ReturnType<typeof summarizeHotPathSamplingProfile> =>
      summarizeHotPathSamplingProfile({ functions: "", bytecodes: "" })
    ).toThrow("total sample count");
  });
});
