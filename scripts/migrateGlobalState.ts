import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWriteText } from "../packages/libs/atomicFile";
import { InputValidationError, invalidInput, parseJsonInput } from "../packages/libs/inputValidation";
import { isPlainRecord } from "../packages/libs/record";
import { decodeGlobalStateFile } from "../packages/libs/stateFileCodec";
import { migrationPathContains, readMigrationFileRecords } from "./migrations/files";
import type { MigrationFileRecord } from "./migrations/files";

/** 本次直接迁移只处理上一版 memory/global/state.json 的总计数格式。 */
const STATE_PATH: string = "memory/global/state.json";
/** 源文件与产物共用的相对路径清单。 */
const STATE_FILES: readonly string[] = [STATE_PATH];
/** 全局状态主文件必须存在。 */
const OPTIONAL_SOURCE_FILES: ReadonlySet<string> = new Set();
/** 暂存目录仅当前账号可进入，部署权限由运维按清单手工恢复。 */
const STAGING_DIRECTORY_MODE: number = 0o700;
/** 产物与校验清单只允许当前账号读写。 */
const STAGING_FILE_MODE: number = 0o600;
/** 与 StateStore 落盘一致的 JSON 缩进。 */
const JSON_INDENT: number = 2;

export interface GlobalStateMigrationOptions {
  readonly sourceRoot: string;
  readonly outputRoot: string;
  /** 有 ttsUsage 时必须明确提供其中属于 AI 的次数，余数归预留；不根据总数猜测。 */
  readonly agentCount?: number;
}

export interface GlobalStateMigrationResult {
  readonly sourceRoot: string;
  readonly outputRoot: string;
  readonly sourceFiles: readonly MigrationFileRecord[];
  readonly outputFiles: readonly MigrationFileRecord[];
}

/** 严格识别上一版总计数格式；分配次数由运维明确输入，窗口起点与总次数保持不变。 */
function splitUsage(value: unknown, source: string, agentCount: number | undefined): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value) || !("copy" in value) ||
    Object.keys(value).some((key: string): boolean => key !== "copy" && key !== "ttsUsage")) {
    return invalidInput(source, "$", "a state document with copy and optional total-count ttsUsage");
  }
  decodeGlobalStateFile({ copy: value.copy }, source);
  if (!("ttsUsage" in value)) {
    if (agentCount !== undefined) return invalidInput("arguments", "--agent-count", "absent when ttsUsage is absent");
    return { copy: value.copy };
  }
  const usage: unknown = value.ttsUsage;
  if (!isPlainRecord(usage) ||
    Object.keys(usage).some((key: string): boolean => key !== "windowStartedAt" && key !== "count")) {
    return invalidInput(source, "$.ttsUsage", "a total-count object with only windowStartedAt and count");
  }
  const windowStartedAt: unknown = usage.windowStartedAt;
  if (typeof windowStartedAt !== "number" || !Number.isSafeInteger(windowStartedAt) || windowStartedAt < 0) {
    return invalidInput(source, "$.ttsUsage.windowStartedAt", "a non-negative safe integer timestamp");
  }
  const count: unknown = usage.count;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
    return invalidInput(source, "$.ttsUsage.count", "a positive safe integer");
  }
  if (agentCount === undefined || !Number.isSafeInteger(agentCount) || agentCount < 0 || agentCount > count) {
    return invalidInput("arguments", "--agent-count", "an explicit non-negative safe integer not greater than ttsUsage.count");
  }
  const state: Readonly<Record<string, unknown>> = {
    copy: value.copy,
    ttsUsage: { windowStartedAt, agentCount, reserveCount: count - agentCount },
  };
  decodeGlobalStateFile(state, source);
  return state;
}

/**
 * 从停机备份生成独立的双计数全局状态。不改源文件、不覆盖既有目录、不操作服务。
 * ready.json 只在产物严格解析与源哈希复核后产生；中断后保留目录，换新 outputRoot 重跑。
 * 部署方在停服期间按清单手工替换 memory/global/state.json，并恢复权限与属主。
 */
export async function prepareGlobalStateMigration({
  sourceRoot,
  outputRoot,
  agentCount,
}: GlobalStateMigrationOptions): Promise<GlobalStateMigrationResult> {
  const source: string = await realpath(sourceRoot);
  const output: string = join(await realpath(dirname(resolve(outputRoot))), basename(resolve(outputRoot)));
  if (migrationPathContains(source, output) || migrationPathContains(output, source)) {
    return invalidInput(output, "$path", "a new directory outside the source backup");
  }
  const sourceFiles: readonly MigrationFileRecord[] = await readMigrationFileRecords(source, STATE_FILES, OPTIONAL_SOURCE_FILES);
  const primaryPath: string = join(source, STATE_PATH);
  const state: Readonly<Record<string, unknown>> =
    splitUsage(parseJsonInput(await Bun.file(primaryPath).text(), primaryPath), primaryPath, agentCount);
  await mkdir(output, { mode: STAGING_DIRECTORY_MODE });
  await atomicWriteText(join(output, "incomplete.json"), JSON.stringify({ sourceFiles }, null, JSON_INDENT), STAGING_FILE_MODE);
  const target: string = join(output, STATE_PATH);
  await mkdir(dirname(target), { recursive: true, mode: STAGING_DIRECTORY_MODE });
  await atomicWriteText(target, `${JSON.stringify(state, null, JSON_INDENT)}\n`, STAGING_FILE_MODE);
  decodeGlobalStateFile(parseJsonInput(await Bun.file(target).text(), target), target);
  if (JSON.stringify(await readMigrationFileRecords(source, STATE_FILES, OPTIONAL_SOURCE_FILES)) !== JSON.stringify(sourceFiles)) {
    return invalidInput(source, "$snapshot", "an unchanged cold backup including metadata");
  }
  const outputFiles: readonly MigrationFileRecord[] = await readMigrationFileRecords(output, STATE_FILES, OPTIONAL_SOURCE_FILES);
  const result: GlobalStateMigrationResult = { sourceRoot: source, outputRoot: output, sourceFiles, outputFiles };
  await atomicWriteText(join(output, "ready.json"), `${JSON.stringify(result, null, JSON_INDENT)}\n`, STAGING_FILE_MODE);
  await Bun.file(join(output, "incomplete.json")).delete();
  return result;
}

/** CLI 不接受默认部署根；计数只接受十进制非负安全整数。 */
function parseArguments(args: readonly string[]): GlobalStateMigrationOptions {
  const values: Map<string, string> = new Map();
  for (let index: number = 0; index < args.length; index += 2) {
    const key: string | undefined = args[index];
    const value: string | undefined = args[index + 1];
    if (key === undefined || !["--source-root", "--output-root", "--agent-count"].includes(key) ||
      values.has(key) || value === undefined || value.trim().length === 0 || value.startsWith("--")) {
      return invalidInput("arguments", "$", "--source-root <cold-backup> --output-root <new-directory> [--agent-count <count>]");
    }
    values.set(key, value.trim());
  }
  const sourceRoot: string | undefined = values.get("--source-root");
  const outputRoot: string | undefined = values.get("--output-root");
  if (sourceRoot === undefined || outputRoot === undefined) return invalidInput("arguments", "$", "both required path options");
  const count: string | undefined = values.get("--agent-count");
  if (count !== undefined && (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count)))) {
    return invalidInput("arguments", "--agent-count", "a non-negative safe integer in decimal notation");
  }
  return { sourceRoot, outputRoot, agentCount: count === undefined ? undefined : Number(count) };
}

if (import.meta.main) {
  if (Bun.argv.slice(2).length === 1 && Bun.argv[2] === "--help") {
    console.log("bun run migrate:global-state --source-root <cold-backup> --output-root <new-directory> [--agent-count <count>]\n" +
      "Stop the service and verify inactive, then take an external backup of memory/global/state.json including ownership, modes and SHA-256.\n" +
      "Only the previous total-count format is accepted. Older root-level state.json requires a staged upgrade with the preceding migration release.\n" +
      "When ttsUsage exists, --agent-count is required: manually determine the AI share; reserveCount is count minus agentCount. No usage is guessed or reset.\n" +
      "The source remains unchanged. Only ready.json marks validated output; after interruption rerun into a new output directory.\n" +
      "Verify output hashes, then while stopped replace memory/global/state.json under the data root.\n" +
      "Restore ownership/modes from sourceFiles and ensure the service account can write memory/global/.\n" +
      "Validate configuration and state before startup; retain the backup until service stability is confirmed.");
  } else {
    try {
      const result: GlobalStateMigrationResult = await prepareGlobalStateMigration(parseArguments(Bun.argv.slice(2)));
      console.log(`Global state migration prepared: ${result.outputRoot}/ready.json. Manual replacement while stopped is required.`);
    } catch (error: unknown) {
      console.error(error instanceof InputValidationError
        ? error.message
        : "Global state migration failed; source backup and incomplete output are retained. No deployment files were replaced.");
      process.exitCode = 1;
    }
  }
}
