import { describe, expect, test } from "bun:test";
import {
  README_BLOCK_END,
  README_BLOCK_START,
} from "../../scripts/perf/fullSuite/constants";
import { renderBenchmarkBlock } from "../../scripts/perf/fullSuite/markdown";
import type { Language } from "../../scripts/perf/fullSuite/markdownCopy";
import type {
  BenchmarkSection,
  FullSuiteReport,
  MetricStats,
} from "../../scripts/perf/fullSuite/types";

function stats(metric: string, unit: MetricStats["unit"], mean: number): MetricStats {
  return {
    metric,
    unit,
    samples: 3,
    mean,
    min: mean,
    max: mean,
    coefficientOfVariationPercent: 1.25,
  };
}

const SECTIONS: readonly BenchmarkSection[] = [
  {
    id: "cold-start",
    entries: [
      { id: "module-graph", metrics: [stats("duration", "ms", 150)] },
      { id: "ready-total", metrics: [stats("duration", "ms", 420.5)] },
    ],
  },
  {
    id: "hot-path",
    entries: [
      {
        id: "incoming-message-spine",
        metrics: [
          stats("medianLatency", "ns/op", 1_926.9),
          stats("throughput", "ops/s", 518_958),
          stats("peakRss", "bytes", 2_097_152),
          stats("retainedHeap", "bytes", 1_024),
        ],
      },
    ],
  },
  {
    id: "chain",
    entries: [
      {
        id: "identity-policy-write",
        metrics: [
          stats("throughput", "ops/s", 5_626),
          stats("p50Latency", "ms", 25.4),
          stats("p95Latency", "ms", 40.8),
          stats("p99Latency", "ms", 49.9),
          stats("maxLatency", "ms", 53.6),
          stats("writtenBytes", "bytes", 20_971_520),
        ],
      },
    ],
  },
];

const REPORT: FullSuiteReport = {
  generatedAt: "2026-08-19T03:33:13Z",
  rounds: 3,
  wallClockMs: 330_000,
  mockDataRoot: "performance",
  environment: {
    bunVersion: "1.3.14",
    bunRevision: "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
    platform: "linux",
    arch: "x64",
    kernel: "6.8.0-31-generic",
    cpuCount: 4,
    totalMemoryBytes: 8_326_057_984,
  },
  sections: SECTIONS,
  coldStart: {
    recovered: {
      aiMemoryChats: 25,
      chatStates: 25,
      whitelistEntries: 8_192,
      blocklistEntries: 8_192,
      pendingRemovals: 512,
    },
    peakRssBytes: stats("peakRss", "bytes", 114_593_792),
  },
  totals: {
    measuredOperations: 385_240_415,
    rcharBytes: 93_473_965,
    wcharBytes: 177_836_326,
    readBytes: 0,
    writeBytes: 193_773_568,
    readSyscalls: 35_930,
    writeSyscalls: 79_028,
    mockRootBytes: 6_128_634,
    mockRootFiles: 61,
  },
};

const LANGUAGES: readonly Language[] = ["zh", "en", "ja"];

describe("基准区块渲染", () => {
  test("三种语言都产出带首尾标记的完整区块", () => {
    for (const language of LANGUAGES) {
      const block: string = renderBenchmarkBlock(REPORT, language);
      expect(block.startsWith(README_BLOCK_START)).toBe(true);
      expect(block.endsWith(README_BLOCK_END)).toBe(true);
      // 区块嵌进独立文档页，页标题由那一页手写；生成部分从二级标题起。
      expect(block).not.toContain("<details>");
      expect(block).not.toContain("\n# ");
      expect(block.split("\n").filter(
        (line: string): boolean => line.startsWith("## ")
      ).length).toBe(5);
      // 被测对象的 id 是标识符，任何语言里都必须原样出现。
      expect(block).toContain("`incoming-message-spine`");
      expect(block).toContain("`identity-policy-write`");
      expect(block).toContain("`ready-total`");
    }
  });

  test("数字格式与千分位不随运行环境 locale 变化", () => {
    const block: string = renderBenchmarkBlock(REPORT, "zh");
    expect(block).toContain("1,926.9 ns/op");
    expect(block).toContain("518,958 ops/s");
    expect(block).toContain("2.00 MiB");
    expect(block).toContain("420.5 ms");
    expect(block).toContain("±1.3%");
    expect(block).toContain("385,240,415");
  });

  test("摘要行给出三个关键读数，缺任何一个都拒绝渲染", () => {
    expect(renderBenchmarkBlock(REPORT, "zh")).toContain("3 轮取平均");
    expect((): string => renderBenchmarkBlock(
      { ...REPORT, sections: [SECTIONS[0]!] },
      "zh"
    )).toThrow("the README summary line cannot be rendered from a partial run");
  });

  test("运行环境只给核心数与内存，不写 CPU 型号", () => {
    for (const [language, cores, footer] of [
      ["zh", "| CPU 核心数 | 4 |", "> 复现：`bun run perf:full`。"],
      ["en", "| CPU cores | 4 |", "> Reproduce with `bun run perf:full`."],
      ["ja", "| CPU コア数 | 4 |", "> 再現方法：`bun run perf:full`。"],
    ] as const) {
      const block: string = renderBenchmarkBlock(REPORT, language);
      expect(block).toContain(cores);
      expect(block).toContain("7.75 GiB");
      // 型号是出数机器的具体硬件，任何语言的区块里都不该出现。
      expect(block).not.toContain("Xeon");
      // 页脚只留复现命令：运行时机与 mock 根的口径写在文档正文，不进生成块。
      expect(block).toContain(footer);
      expect(block).not.toContain("config_example");
    }
  });

  test("同一张表里混入不同指标集时拒绝渲染", () => {
    const mixed: BenchmarkSection = {
      id: "cold-start",
      entries: [
        { id: "module-graph", metrics: [stats("duration", "ms", 150)] },
        {
          id: "ready-total",
          metrics: [stats("duration", "ms", 420), stats("peakRss", "bytes", 1)],
        },
      ],
    };
    expect((): string => renderBenchmarkBlock(
      { ...REPORT, sections: [mixed, SECTIONS[1]!, SECTIONS[2]!] },
      "zh"
    )).toThrow("mixes different metric sets");
  });

  test("没有条目的分区不会渲染成一张空表", () => {
    // 摘要行先于分区渲染，因此必须保留它依赖的三个分区，才能验证空表这一条。
    expect((): string => renderBenchmarkBlock(
      { ...REPORT, sections: [...SECTIONS, { id: "storage", entries: [] }] },
      "zh"
    )).toThrow("has no entries to render");
  });
});
