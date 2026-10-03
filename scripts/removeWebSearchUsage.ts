import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Stats } from "node:fs";
import {
  AI_CACHE_SUMMARY_KEY,
  AI_CACHE_USAGE_RELATIVE_PATH,
  AI_CACHE_USAGE_REMOVAL_DIRECTORY_MODE,
  AI_CACHE_USAGE_REMOVAL_FILE_MODE,
  AI_CACHE_USAGE_REMOVAL_SOURCE_FILES,
} from "../packages/consts/diskIO/aiCache";
import { DAY_FILE_JSON_INDENT } from "../packages/consts/diskIO/appendOnly";
import { atomicWriteText } from "../packages/libs/atomicFile";
import { InputValidationError, invalidInput, parseJsonInput, readJsonInput } from "../packages/libs/inputValidation";
import type { AiCacheDocument, AiCacheRow, AiCacheSummary, AiCacheTotals } from "../packages/types/aiCache";
import { buildAiCacheSummary, decodeAiCacheDocument } from "../packages/workers/diskIO/aiCacheDocument";
import { AppendOnlyFileFormatError } from "../packages/workers/diskIO/appendOnlyDayFile";
import { parseSourceOutputRoots } from "./migrations/cli";
import { migrationPathContains, readMigrationFileRecords } from "./migrations/files";
import type { MigrationFileRecord } from "./migrations/files";

export interface WebSearchUsageRemovalOptions {
  readonly sourceRoot: string;
  readonly outputRoot: string;
}

export interface WebSearchUsageRemovalResult {
  readonly sourceRoot: string;
  readonly outputRoot: string;
  readonly removedRows: number;
  readonly removedSummaryGroups: number;
  readonly keptRows: number;
  readonly summary: AiCacheSummary | null;
  readonly sourceFiles: readonly MigrationFileRecord[];
  readonly outputFiles: readonly MigrationFileRecord[];
}

/**
 * 从停机备份生成删除全部 web_search 用量后的独立产物：删除该能力的逐条记录和汇总分组，
 * 按其余分组重算请求数、token、费用、检索次数与命中率。其他能力的记录和分组保持不变。
 * 不改源文件、不操作服务、不覆盖既有目录。ready.json 只在产物重读和源清单复核后生成；
 * 中断后保留现场，使用新 outputRoot 重跑。部署方停机期间只手工替换 AI_CACHE_USAGE_RELATIVE_PATH。
 */
export async function prepareWebSearchUsageRemoval({ sourceRoot, outputRoot }: WebSearchUsageRemovalOptions): Promise<WebSearchUsageRemovalResult> {
  const source: string = await realpath(sourceRoot);
  const output: string = join(await realpath(dirname(resolve(outputRoot))), basename(resolve(outputRoot)));
  if (migrationPathContains(source, output) || migrationPathContains(output, source)) {
    return invalidInput(output, "$path", "a new directory outside the source backup");
  }
  for (const relative of ["memory", "memory/ai-daily-usage"]) {
    const stats: Stats = await lstat(join(source, relative));
    if (!stats.isDirectory() || stats.isSymbolicLink()) return invalidInput(source, relative, "a directory without symbolic links");
  }
  const sourceFiles: readonly MigrationFileRecord[] = await readMigrationFileRecords(source, AI_CACHE_USAGE_REMOVAL_SOURCE_FILES);
  const sourcePath: string = join(source, AI_CACHE_USAGE_RELATIVE_PATH);
  const document: AiCacheDocument = decodeAiCacheDocument(sourcePath, await readJsonInput(sourcePath));
  const kept: Record<string, AiCacheRow> = {};
  let removedRows: number = 0;
  for (const [key, row] of document.rows) {
    if (row.capability === "web_search") removedRows++;
    else kept[key] = row;
  }
  let summary: AiCacheSummary | null = null;
  let removedSummaryGroups: number = 0;
  if (document.summary !== null) {
    const byModel: Record<string, AiCacheTotals> = {};
    for (const [group, totals] of Object.entries(document.summary.byModel)) {
      if (group.startsWith("web_search/")) removedSummaryGroups++;
      else byModel[group] = totals;
    }
    summary = buildAiCacheSummary(document.summary.day, [], { ...document.summary, byModel });
  }
  const cleaned: Readonly<Record<string, AiCacheSummary | AiCacheRow>> = summary === null
    ? kept : { [AI_CACHE_SUMMARY_KEY]: summary, ...kept };
  const content: string = `${JSON.stringify(cleaned, null, DAY_FILE_JSON_INDENT)}\n`;
  decodeAiCacheDocument(sourcePath, parseJsonInput(content, sourcePath));
  await mkdir(output, { mode: AI_CACHE_USAGE_REMOVAL_DIRECTORY_MODE });
  await atomicWriteText(join(output, "incomplete.json"), JSON.stringify({ sourceFiles }, null, DAY_FILE_JSON_INDENT), AI_CACHE_USAGE_REMOVAL_FILE_MODE);
  const target: string = join(output, AI_CACHE_USAGE_RELATIVE_PATH);
  await mkdir(dirname(target), { recursive: true, mode: AI_CACHE_USAGE_REMOVAL_DIRECTORY_MODE });
  await atomicWriteText(target, content, AI_CACHE_USAGE_REMOVAL_FILE_MODE);
  const verified: AiCacheDocument = decodeAiCacheDocument(target, await readJsonInput(target));
  if (JSON.stringify(verified.summary) !== JSON.stringify(summary) ||
    JSON.stringify([...verified.rows]) !== JSON.stringify(Object.entries(kept))) {
    return invalidInput(target, "$", "the exact recalculated summary and unchanged remaining records");
  }
  if (JSON.stringify(await readMigrationFileRecords(source, AI_CACHE_USAGE_REMOVAL_SOURCE_FILES)) !== JSON.stringify(sourceFiles)) {
    return invalidInput(source, "$snapshot", "an unchanged cold backup including ownership, mode and SHA-256");
  }
  const outputFiles: readonly MigrationFileRecord[] = await readMigrationFileRecords(output, AI_CACHE_USAGE_REMOVAL_SOURCE_FILES);
  const result: WebSearchUsageRemovalResult = {
    sourceRoot: source, outputRoot: output, removedRows, removedSummaryGroups, keptRows: verified.rows.size,
    summary, sourceFiles, outputFiles,
  };
  await atomicWriteText(join(output, "ready.json"), `${JSON.stringify(result, null, DAY_FILE_JSON_INDENT)}\n`, AI_CACHE_USAGE_REMOVAL_FILE_MODE);
  await Bun.file(join(output, "incomplete.json")).delete();
  return result;
}

if (import.meta.main) {
  if (Bun.argv.length === 3 && Bun.argv[2] === "--help") {
    console.log("bun run usage:remove-web-search --source-root <cold-backup> --output-root <new-directory>\n" +
      "Stop the service and verify inactive before backing up memory/ai-daily-usage/usage.json outside the worktree.\n" +
      "Remove every web_search capability record and summary group; recalculate totals from the remaining groups. Other capabilities remain unchanged.\n" +
      "The source backup is unchanged. Only ready.json marks verified output; after interruption use a new output directory.\n" +
      "Check the manifest hashes and totals. While stopped, manually replace only usage.json and restore its original ownership and mode.\n" +
      "Validate configuration and state, then start and confirm service stability before removing backups.");
  } else {
    try {
      const result: WebSearchUsageRemovalResult = await prepareWebSearchUsageRemoval(parseSourceOutputRoots(Bun.argv.slice(2)));
      console.log(`Web search usage removal prepared: ${result.outputRoot}/ready.json. Manual replacement while stopped is required.`);
    } catch (error: unknown) {
      console.error(error instanceof InputValidationError || error instanceof AppendOnlyFileFormatError
        ? error.message
        : "Web search usage removal failed; the source backup and incomplete output are retained. No deployment files were replaced.");
      process.exitCode = 1;
    }
  }
}
