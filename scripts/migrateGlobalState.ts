import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseAssetConfig } from "../packages/config/assets";
import {
  BOT_DEFAULT_AVATAR_URL,
  FORTUNE_THUMBNAIL_URL,
  GAG_THUMBNAIL_URL,
  PROBABILITY_THUMBNAIL_URL,
  RANDOM_H_IMAGE_DIR,
} from "../packages/consts/ui/assets";
import { atomicWriteText } from "../packages/libs/atomicFile";
import { InputValidationError, invalidInput, parseJsonInput } from "../packages/libs/inputValidation";
import type { InputFieldContext } from "../packages/libs/inputValidation";
import { isPlainRecord } from "../packages/libs/record";
import { decodeGlobalStateFile } from "../packages/libs/stateFileCodec";
import {
  migrationPathContains,
  readMigrationFileRecords,
} from "./migrations/files";
import type { MigrationFileRecord } from "./migrations/files";

/** 停机备份中参与本次迁移的文件：14.x 数据根下的全局状态与其备份副本。 */
const SOURCE_FILES: readonly string[] = ["state.json", "state.json.bak"];
/** 允许真正缺省的源文件。 */
const OPTIONAL_SOURCE_FILES: ReadonlySet<string> = new Set(["state.json.bak"]);
/** 产物里的全局状态文件，相对新数据根。 */
const OUTPUT_STATE_PATH: string = "memory/global/state.json";
/** 产物里的素材配置文件，相对新数据根旁的配置目录。 */
const OUTPUT_ASSETS_PATH: string = "config/dynamic/assets.json";
/** 暂存目录仅当前账号可进入，部署权限由运维按清单手工恢复。 */
const STAGING_DIRECTORY_MODE: number = 0o700;
/** 产物与校验清单只允许当前账号读写。 */
const STAGING_FILE_MODE: number = 0o600;
/** 与 StateStore 落盘一致的 JSON 缩进。 */
const JSON_INDENT: number = 2;

/** 一项 14.x 素材在 config/dynamic/assets.json 里的键、内置缺省，以及是否按 URL 归一化。 */
interface LegacyAssetMapping {
  readonly key: string;
  readonly fallback: string;
  readonly url: boolean;
}

/** 14.x `global.assets` 的键 → config/dynamic/assets.json 的键与内置缺省。 */
const LEGACY_ASSET_KEYS: ReadonlyMap<string, LegacyAssetMapping> = new Map([
  ["randomHImageDir", { key: "random_h_image_dir", fallback: RANDOM_H_IMAGE_DIR, url: false }],
  ["fortuneThumbnailUrl", { key: "fortune_thumbnail_url", fallback: FORTUNE_THUMBNAIL_URL, url: true }],
  ["probabilityThumbnailUrl", { key: "probability_thumbnail_url", fallback: PROBABILITY_THUMBNAIL_URL, url: true }],
  ["gagThumbnailUrl", { key: "gag_thumbnail_url", fallback: GAG_THUMBNAIL_URL, url: true }],
  ["botDefaultAvatarUrl", { key: "bot_default_avatar_url", fallback: BOT_DEFAULT_AVATAR_URL, url: true }],
]);

export interface GlobalStateMigrationOptions {
  readonly sourceRoot: string;
  readonly outputRoot: string;
}

export interface GlobalStateMigrationResult {
  readonly sourceRoot: string;
  readonly outputRoot: string;
  /** 写进 config/dynamic/assets.json 的键；与内置缺省相同的项不写，全部相同时不生成该文件。 */
  readonly assetKeys: readonly string[];
  readonly sourceFiles: readonly MigrationFileRecord[];
  readonly outputFiles: readonly MigrationFileRecord[];
}

/** 14.x state.json 拆成的两份产物内容。 */
interface SplitLegacyState {
  readonly state: Readonly<Record<string, unknown>>;
  readonly assets: Readonly<Record<string, string>>;
}

/**
 * 按 14.x 口径收下一项素材：字符串去掉首尾空白；直链取 URL 归一化后的 href。
 * 与内置缺省相同时返回 null。
 */
function legacyAssetValue(value: unknown, mapping: LegacyAssetMapping, { source, path }: InputFieldContext): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return invalidInput(source, path, "a non-empty string");
  const text: string = value.trim();
  let normalized: string = text;
  if (mapping.url) {
    try {
      normalized = new URL(text).href;
    } catch {
      return invalidInput(source, path, "an absolute URL");
    }
  }
  return normalized === mapping.fallback ? null : normalized;
}

/**
 * 严格拆分 14.x 的 state.json：顶层只允许 global，global 只允许 copy（必填）与 assets，
 * 与 14.0.0 的状态解码器一致。copy 原样搬进新状态并用当前解码器复验；assets 换成
 * config/dynamic/assets.json 的键，只保留与内置缺省不同的项。其余形态（含 14.0.0 之后才有的
 * ttsUsage）一律视为未知谱系拒绝。
 */
function splitLegacyState(value: unknown, source: string): SplitLegacyState {
  if (!isPlainRecord(value) || Object.keys(value).some((key: string): boolean => key !== "global")) {
    return invalidInput(source, "$", "a 14.x state document with only the global block");
  }
  const global: unknown = value.global;
  if (!isPlainRecord(global) || !("copy" in global) ||
    Object.keys(global).some((key: string): boolean => key !== "copy" && key !== "assets")) {
    return invalidInput(source, "$.global", "a 14.x global block with copy and optional assets");
  }
  const state: Record<string, unknown> = { copy: global.copy };
  decodeGlobalStateFile(state, source);
  const assets: Record<string, string> = {};
  if (global.assets !== undefined) {
    if (!isPlainRecord(global.assets)) return invalidInput(source, "$.global.assets", "an object");
    for (const [legacyKey, raw] of Object.entries(global.assets)) {
      const mapping: LegacyAssetMapping | undefined = LEGACY_ASSET_KEYS.get(legacyKey);
      if (mapping === undefined) {
        return invalidInput(source, `$.global.assets.${legacyKey}`, "absent (not part of the 14.x state schema)");
      }
      const migrated: string | null =
        legacyAssetValue(raw, mapping, { source, path: `$.global.assets.${legacyKey}` });
      if (migrated !== null) assets[mapping.key] = migrated;
    }
  }
  parseAssetConfig(assets, source);
  return { state, assets };
}

/** 写出一份 JSON 产物并用 reverify 按当前解析器复验。 */
async function writeJsonOutput(
  target: string,
  value: unknown,
  reverify: (parsed: unknown, source: string) => unknown
): Promise<void> {
  await atomicWriteText(target, `${JSON.stringify(value, null, JSON_INDENT)}\n`, STAGING_FILE_MODE);
  reverify(parseJsonInput(await Bun.file(target).text(), target), target);
}

/**
 * 从 14.x 数据根的停机备份生成独立产物：`memory/global/state.json`（copy 原样）
 * 与 `config/dynamic/assets.json`（只含与内置缺省不同的素材项）。state.json.bak 存在时必须与
 * state.json 逐字节相同，否则拒绝并交由人工核对。不改源文件，不覆盖既有目录，不执行服务
 * 操作；ready.json 只在全部校验及源哈希复核后产生，中断后保留目录，换新 outputRoot 重跑。
 * 部署方按清单在停服期间手工放置产物，并把旧 state.json 与 state.json.bak 移出数据根。
 */
export async function prepareGlobalStateMigration({
  sourceRoot,
  outputRoot,
}: GlobalStateMigrationOptions): Promise<GlobalStateMigrationResult> {
  const source: string = await realpath(sourceRoot);
  const output: string = join(await realpath(dirname(resolve(outputRoot))), basename(resolve(outputRoot)));
  if (migrationPathContains(source, output) || migrationPathContains(output, source)) {
    return invalidInput(output, "$path", "a new directory outside the source backup");
  }
  const sourceFiles: readonly MigrationFileRecord[] = await readMigrationFileRecords(source, SOURCE_FILES, OPTIONAL_SOURCE_FILES);
  const primary: MigrationFileRecord | undefined = sourceFiles.find(
    (record: MigrationFileRecord): boolean => record.path === "state.json"
  );
  if (primary === undefined) return invalidInput(join(source, "state.json"), "$type", "a regular file");
  const backup: MigrationFileRecord | undefined = sourceFiles.find(
    (record: MigrationFileRecord): boolean => record.path === "state.json.bak"
  );
  if (backup !== undefined && backup.sha256 !== primary.sha256) {
    return invalidInput(join(source, "state.json.bak"), "$sha256", "identical to state.json; reconcile the two copies manually");
  }
  const primaryPath: string = join(source, "state.json");
  const split: SplitLegacyState = splitLegacyState(parseJsonInput(await Bun.file(primaryPath).text(), primaryPath), primaryPath);

  await mkdir(output, { mode: STAGING_DIRECTORY_MODE });
  await atomicWriteText(join(output, "incomplete.json"), JSON.stringify({ sourceFiles }, null, JSON_INDENT), STAGING_FILE_MODE);
  await mkdir(join(output, dirname(OUTPUT_STATE_PATH)), { recursive: true, mode: STAGING_DIRECTORY_MODE });
  await writeJsonOutput(join(output, OUTPUT_STATE_PATH), split.state, decodeGlobalStateFile);
  const assetKeys: readonly string[] = Object.keys(split.assets);
  const outputPaths: string[] = [OUTPUT_STATE_PATH];
  if (assetKeys.length > 0) {
    await mkdir(join(output, dirname(OUTPUT_ASSETS_PATH)), { recursive: true, mode: STAGING_DIRECTORY_MODE });
    await writeJsonOutput(join(output, OUTPUT_ASSETS_PATH), split.assets, parseAssetConfig);
    outputPaths.push(OUTPUT_ASSETS_PATH);
  }
  if (JSON.stringify(await readMigrationFileRecords(source, SOURCE_FILES, OPTIONAL_SOURCE_FILES)) !== JSON.stringify(sourceFiles)) {
    return invalidInput(source, "$snapshot", "an unchanged cold backup including metadata");
  }
  const outputFiles: readonly MigrationFileRecord[] = await readMigrationFileRecords(output, outputPaths, new Set());
  const result: GlobalStateMigrationResult = { sourceRoot: source, outputRoot: output, assetKeys, sourceFiles, outputFiles };
  await atomicWriteText(join(output, "ready.json"), `${JSON.stringify(result, null, JSON_INDENT)}\n`, STAGING_FILE_MODE);
  await Bun.file(join(output, "incomplete.json")).delete();
  return result;
}

/** CLI 不接受默认部署根；源备份与产物目录都必须明确提供。 */
function parseArguments(args: readonly string[]): GlobalStateMigrationOptions {
  const values: Map<string, string> = new Map();
  for (let index: number = 0; index < args.length; index += 2) {
    const key: string | undefined = args[index];
    const value: string | undefined = args[index + 1];
    if (key === undefined || !["--source-root", "--output-root"].includes(key) ||
      values.has(key) || value === undefined || value.trim().length === 0 || value.startsWith("--")) {
      return invalidInput("arguments", "$", "--source-root <cold-backup> --output-root <new-directory>");
    }
    values.set(key, value);
  }
  const sourceRoot: string | undefined = values.get("--source-root");
  const outputRoot: string | undefined = values.get("--output-root");
  if (sourceRoot === undefined || outputRoot === undefined) return invalidInput("arguments", "$", "both required options");
  return { sourceRoot, outputRoot };
}

if (import.meta.main) {
  if (Bun.argv.slice(2).length === 1 && Bun.argv[2] === "--help") {
    console.log("bun run migrate:global-state --source-root <cold-backup> --output-root <new-directory>\n" +
      "Stop the service and verify inactive before taking an external backup of state.json and state.json.bak from the data root.\n" +
      "The source remains unchanged; state.json.bak, when present, must be byte-identical to state.json.\n" +
      "Only ready.json marks validated output; after interruption rerun into a new output directory.\n" +
      "copy moves to memory/global/state.json; asset values that differ from the built-in defaults move to config/dynamic/assets.json.\n" +
      "Verify output hashes, then while stopped place memory/global/state.json under the data root and config/dynamic/assets.json into the config root's dynamic/ directory, and move state.json and state.json.bak out of the data root.\n" +
      "Ensure the service account can write memory/global/; config/ may stay read-only. Restore ownership/modes from sourceFiles.\n" +
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
