/**
 * 把报告渲染成写进三份 README 的 Markdown 区块。
 *
 * 数字格式全部自己算，不用 `toLocaleString`：那东西按运行环境的 locale 变化，
 * 同一份报告在两台机器上会渲染出不同的千分位和小数点，README 的 diff 就会
 * 无缘无故变脏。
 */

import {
  README_BLOCK_END,
  README_BLOCK_START,
} from "./constants";
import { benchmarkCopy } from "./markdownCopy";
import type { BenchmarkCopy, Language } from "./markdownCopy";
import type {
  BenchmarkEntry,
  BenchmarkSection,
  FullSuiteReport,
  MetricStats,
  SuiteTotals,
} from "./types";

const BYTE_UNITS: readonly string[] = ["B", "KiB", "MiB", "GiB"];

function group(text: string): string {
  const [whole, fraction]: string[] = text.split(".");
  const grouped: string = (whole ?? "0").replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ","
  );
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

function formatCount(value: number): string {
  return group(Math.round(value).toString());
}

function formatBytes(value: number): string {
  const sign: string = value < 0 ? "-" : "";
  let magnitude: number = Math.abs(value);
  let unit: number = 0;
  while (magnitude >= 1_024 && unit < BYTE_UNITS.length - 1) {
    magnitude /= 1_024;
    unit += 1;
  }
  const digits: number = unit === 0 ? 0 : 2;
  return `${sign}${group(magnitude.toFixed(digits))} ${BYTE_UNITS[unit]}`;
}

function formatMilliseconds(value: number): string {
  if (value < 1) return `${value.toFixed(3)} ms`;
  if (value < 100) return `${value.toFixed(2)} ms`;
  return `${group(value.toFixed(1))} ms`;
}

function formatMetric(metric: MetricStats): string {
  switch (metric.unit) {
    case "ns/op":
      return `${group(metric.mean.toFixed(1))} ns/op`;
    case "ops/s":
      return `${formatCount(metric.mean)} ops/s`;
    case "ms":
      return formatMilliseconds(metric.mean);
    case "bytes":
      return formatBytes(metric.mean);
    case "count":
      return formatCount(metric.mean);
    case "percent":
      return `${metric.mean.toFixed(2)}%`;
  }
}

function formatVariation(metric: MetricStats): string {
  return `±${metric.coefficientOfVariationPercent.toFixed(1)}%`;
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function tableSeparator(columns: number): string {
  return `|${" --- |".repeat(columns)}`;
}

/** 表头只写指标名：单位跟着每个单元格走，写两遍只会让表更宽、更难扫。 */
function metricHeader(metric: MetricStats, copy: BenchmarkCopy): string {
  return copy.metricLabels[metric.metric] ?? metric.metric;
}

/**
 * 一个分区渲染成一张表。
 *
 * 列由**第一行**的指标表决定，其余行按名字对齐；对不上就抛错而不是留空格：
 * 同一张表里各行列含义不同的报告，读者没有办法正确解读。
 */
function renderSection(
  section: BenchmarkSection,
  copy: BenchmarkCopy
): readonly string[] {
  const first: BenchmarkEntry | undefined = section.entries[0];
  if (first === undefined) {
    throw new Error(`Benchmark section ${section.id} has no entries to render.`);
  }
  const header: string[] = [copy.sectionSubjects[section.id]];
  for (const metric of first.metrics) header.push(metricHeader(metric, copy));
  header.push(copy.variationColumn);
  const lines: string[] = [
    `## ${copy.sectionTitles[section.id]}`,
    "",
    `> ${copy.sectionNotes[section.id]}`,
    "",
    tableRow(header),
    tableSeparator(header.length),
  ];
  for (const entry of section.entries) {
    if (entry.metrics.length !== first.metrics.length) {
      throw new Error(
        `Benchmark section ${section.id} mixes different metric sets.`
      );
    }
    const cells: string[] = [`\`${entry.id}\``];
    for (let index: number = 0; index < entry.metrics.length; index += 1) {
      const metric: MetricStats = entry.metrics[index]!;
      if (metric.metric !== first.metrics[index]!.metric) {
        throw new Error(
          `Benchmark section ${section.id} mixes different metric sets.`
        );
      }
      cells.push(formatMetric(metric));
    }
    cells.push(formatVariation(entry.metrics[0]!));
    lines.push(tableRow(cells));
  }
  lines.push("");
  return lines;
}

function renderTotals(
  totals: SuiteTotals,
  copy: BenchmarkCopy
): readonly string[] {
  const rows: readonly (readonly [string, string])[] = [
    [copy.totalsLabels.measuredOperations, formatCount(totals.measuredOperations)],
    [copy.totalsLabels.rcharBytes, formatBytes(totals.rcharBytes)],
    [copy.totalsLabels.wcharBytes, formatBytes(totals.wcharBytes)],
    [copy.totalsLabels.readBytes, formatBytes(totals.readBytes)],
    [copy.totalsLabels.writeBytes, formatBytes(totals.writeBytes)],
    [copy.totalsLabels.readSyscalls, formatCount(totals.readSyscalls)],
    [copy.totalsLabels.writeSyscalls, formatCount(totals.writeSyscalls)],
    [copy.totalsLabels.mockRootBytes, formatBytes(totals.mockRootBytes)],
    [copy.totalsLabels.mockRootFiles, formatCount(totals.mockRootFiles)],
  ];
  const lines: string[] = [
    `## ${copy.totalsTitle}`,
    "",
    `> ${copy.totalsNote}`,
    "",
    tableRow([copy.metricColumn, copy.valueColumn]),
    tableSeparator(2),
  ];
  for (const [label, value] of rows) lines.push(tableRow([label, value]));
  lines.push("");
  return lines;
}

function renderEnvironment(
  report: FullSuiteReport,
  copy: BenchmarkCopy
): readonly string[] {
  const rows: readonly (readonly [string, string])[] = [
    [
      copy.environmentLabels.runtime,
      `Bun ${report.environment.bunVersion} (\`${report.environment.bunRevision}\`)`,
    ],
    [
      copy.environmentLabels.kernel,
      `${report.environment.platform} ${report.environment.kernel} · ${report.environment.arch}`,
    ],
    [copy.environmentLabels.cpuCores, formatCount(report.environment.cpuCount)],
    [copy.environmentLabels.memory, formatBytes(report.environment.totalMemoryBytes)],
    [copy.environmentLabels.rounds, formatCount(report.rounds)],
    [copy.environmentLabels.dataRoot, `\`${report.mockDataRoot}/\``],
    [copy.environmentLabels.generatedAt, report.generatedAt],
  ];
  const lines: string[] = [
    `## ${copy.environmentTitle}`,
    "",
    tableRow([copy.metricColumn, copy.valueColumn]),
    tableSeparator(2),
  ];
  for (const [label, value] of rows) lines.push(tableRow([label, value]));
  lines.push("");
  return lines;
}

/** 摘要行要取的那一格读数。 */
interface MetricLocator {
  readonly sectionId: BenchmarkSection["id"];
  readonly entryId: string;
  readonly metricName: string;
}

function findMetric(
  report: FullSuiteReport,
  { sectionId, entryId, metricName }: MetricLocator
): MetricStats {
  const section: BenchmarkSection | undefined = report.sections.find(
    (candidate: BenchmarkSection): boolean => candidate.id === sectionId
  );
  const entry: BenchmarkEntry | undefined = section?.entries.find(
    (candidate: BenchmarkEntry): boolean => candidate.id === entryId
  );
  const metric: MetricStats | undefined = entry?.metrics.find(
    (candidate: MetricStats): boolean => candidate.metric === metricName
  );
  if (metric === undefined) {
    throw new Error(
      `Benchmark report is missing ${sectionId}/${entryId}/${metricName}; ` +
      "the README summary line cannot be rendered from a partial run."
    );
  }
  return metric;
}

function renderSummaryLine(
  report: FullSuiteReport,
  copy: BenchmarkCopy
): string {
  const ready: MetricStats = findMetric(report, {
    sectionId: "cold-start",
    entryId: "ready-total",
    metricName: "duration",
  });
  const spine: MetricStats = findMetric(report, {
    sectionId: "hot-path",
    entryId: "incoming-message-spine",
    metricName: "medianLatency",
  });
  const identity: MetricStats = findMetric(report, {
    sectionId: "chain",
    entryId: "identity-policy-write",
    metricName: "throughput",
  });
  return `**${copy.summaryPrefix}** · Bun ${report.environment.bunVersion} · ` +
    `${copy.summaryRounds.replace("{n}", formatCount(report.rounds))} · ` +
    `${report.generatedAt} · ` +
    `\`ready-total\` ${formatMilliseconds(ready.mean)} · ` +
    `\`incoming-message-spine\` ${group(spine.mean.toFixed(1))} ns/op · ` +
    `\`identity-policy-write\` ${formatCount(identity.mean)} ops/s`;
}

function renderColdStartCaption(
  report: FullSuiteReport,
  copy: BenchmarkCopy
): string {
  return `> ${copy.coldStartCaption
    .replace("{whitelist}", formatCount(report.coldStart.recovered.whitelistEntries))
    .replace("{blocklist}", formatCount(report.coldStart.recovered.blocklistEntries))
    .replace("{chats}", formatCount(report.coldStart.recovered.chatStates))
    .replace("{memories}", formatCount(report.coldStart.recovered.aiMemoryChats))
    .replace("{rss}", formatBytes(report.coldStart.peakRssBytes.mean))}`;
}

/**
 * 渲染一份语言的完整区块，含首尾标记。
 *
 * 区块直接嵌进 `docs/<lang>/09-performance.md`：页标题、语言切换和上下页导航都
 * 是那一页手写的部分，生成块只负责标记之间的读数，重跑基准时按标记整块替换。
 */
export function renderBenchmarkBlock(
  report: FullSuiteReport,
  language: Language
): string {
  const copy: BenchmarkCopy = benchmarkCopy(language);
  const lines: string[] = [
    README_BLOCK_START,
    "",
    renderSummaryLine(report, copy),
    "",
    ...renderEnvironment(report, copy),
    ...renderTotals(report.totals, copy),
  ];
  for (const section of report.sections) {
    lines.push(...renderSection(section, copy));
    if (section.id === "cold-start") {
      lines.push(renderColdStartCaption(report, copy), "");
    }
  }
  lines.push(`> ${copy.footer}`, "", README_BLOCK_END);
  return lines.join("\n");
}
