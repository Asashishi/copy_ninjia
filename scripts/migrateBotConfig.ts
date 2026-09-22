import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseBotConfig } from "../packages/config/botInput";
import { parseCronConfig } from "../packages/config/cron";
import { parseGoogleServiceAccountKey } from "../packages/config/googleAuth";
import { atomicWriteText } from "../packages/libs/atomicFile";
import { isErrno } from "../packages/libs/errno";
import { InputValidationError, invalidInput, readJsonInput } from "../packages/libs/inputValidation";
import { decodeStateFile } from "../packages/libs/stateFileCodec";
import { migrateBotCron, migrateBotIdentity, migrateBotState } from "./migrations/botConfig/codec";
import { migrationPathContains, readBotMigrationFile } from "./migrations/botConfig/files";
import type { BotMigrationFile } from "./migrations/botConfig/files";

/** 暂存产物只允许当前账号访问，部署权限按清单手工恢复。 */
const STAGING_DIRECTORY_MODE: number = 0o700;
/** 配置凭据与状态产物在暂存阶段保持 0600。 */
const STAGING_FILE_MODE: number = 0o600;

export interface BotConfigMigrationOptions {
  readonly sourceConfigRoot: string;
  readonly sourceDataRoot: string;
  readonly outputRoot: string;
  /** 项目根旧凭据的显式备份文件；配置根、数据根与项目根可以互不相同。 */
  readonly sourceGoogleAuth?: string;
}

/** 每个产物必须按映射手工部署，不能把完成清单当部署配置。 */
export interface BotConfigMigrationMapping {
  readonly source: BotMigrationFile;
  readonly output: string;
}

export interface BotConfigMigrationResult {
  readonly sourceFormat: string;
  readonly targetFormat: string;
  readonly sourceConfigRoot: string;
  readonly sourceDataRoot: string;
  readonly outputRoot: string;
  readonly mappings: readonly BotConfigMigrationMapping[];
  readonly outputFiles: readonly BotMigrationFile[];
}

/** 新配置入口存在（含悬空链接）就拒绝，不能把混合版本当本次输入。 */
async function rejectCurrentConfig(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT")) return;
    return invalidInput(path, "$", "absent in the source backup");
  }
  return invalidInput(path, "$", "absent in the source backup");
}

/**
 * 从明确的停机备份生成当前 Bot/state/cron 格式；显式 Google 凭据原样复制到配置目录。
 * 源不变、产物不覆盖。
 * 配置与数据根分别指定；ready.json 发布前校验每份产物及全部源文件的哈希与拓扑。
 * 中断后保留现场，向全新目录重跑。手工部署边界见 docs/cn/04-invariants.md。
 */
export async function prepareBotConfigMigration({
  sourceConfigRoot, sourceDataRoot, outputRoot, sourceGoogleAuth,
}: BotConfigMigrationOptions): Promise<BotConfigMigrationResult> {
  const configRoot: string = await realpath(sourceConfigRoot);
  const dataRoot: string = await realpath(sourceDataRoot);
  const output: string = join(await realpath(dirname(resolve(outputRoot))), basename(resolve(outputRoot)));
  for (const source of [configRoot, dataRoot]) {
    if (!(await Bun.file(source).stat()).isDirectory() ||
      migrationPathContains(source, output) || migrationPathContains(output, source)) {
      return invalidInput(output, "$path", "a new directory outside both source directories");
    }
  }
  await rejectCurrentConfig(join(configRoot, "bot.json"));
  if (sourceGoogleAuth !== undefined) await rejectCurrentConfig(join(configRoot, "g-auth.json"));
  const inputs: readonly Readonly<{ source: string; output: string; required: boolean }>[] = [
    { source: join(configRoot, "telegram.json"), output: "config/bot.json", required: true },
    { source: join(configRoot, "cron.json"), output: "config/cron.json", required: false },
    { source: join(dataRoot, "state.json"), output: "data/state.json", required: false },
    { source: join(dataRoot, "state.json.bak"), output: "data/state.json.bak", required: false },
    ...(sourceGoogleAuth === undefined ? [] : [{ source: resolve(sourceGoogleAuth), output: "config/g-auth.json", required: true }]),
  ];
  const mappings: BotConfigMigrationMapping[] = [];
  for (const input of inputs) {
    const source: BotMigrationFile | null = await readBotMigrationFile(input.source);
    if (source === null) {
      if (input.required) return invalidInput(input.source, "$", "a readable source configuration");
      continue;
    }
    if (migrationPathContains(output, source.resolvedPath)) {
      return invalidInput(output, "$path", "outside every source file target");
    }
    mappings.push({ source, output: input.output });
  }
  await mkdir(output, { mode: STAGING_DIRECTORY_MODE });
  await atomicWriteText(join(output, "incomplete.json"), JSON.stringify({ mappings }, null, 2), STAGING_FILE_MODE);
  await mkdir(join(output, "config"), { mode: STAGING_DIRECTORY_MODE });
  await mkdir(join(output, "data"), { mode: STAGING_DIRECTORY_MODE });
  const outputFiles: BotMigrationFile[] = [];
  for (const mapping of mappings) {
    const value: unknown = await readJsonInput(mapping.source.path);
    const target: string = join(output, mapping.output);
    const converted: unknown = mapping.output === "config/bot.json"
      ? migrateBotIdentity(value, mapping.source.path)
      : mapping.output === "config/cron.json"
        ? migrateBotCron(value, mapping.source.path)
        : mapping.output === "config/g-auth.json"
          ? parseGoogleServiceAccountKey(value, mapping.source.path)
          : migrateBotState(value, mapping.source.path);
    const content: string = mapping.output === "config/g-auth.json"
      ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await Bun.file(mapping.source.path).bytes())
      : `${JSON.stringify(converted, null, 2)}\n`;
    await atomicWriteText(target, content, STAGING_FILE_MODE);
    const written: unknown = await readJsonInput(target);
    if (mapping.output === "config/bot.json") parseBotConfig(written, target);
    else if (mapping.output === "config/cron.json") parseCronConfig(written, target);
    else if (mapping.output === "config/g-auth.json") parseGoogleServiceAccountKey(written, target);
    else decodeStateFile(written);
    const writtenFile: BotMigrationFile = (await readBotMigrationFile(target))!;
    if (mapping.output === "config/g-auth.json" && writtenFile.sha256 !== mapping.source.sha256) {
      return invalidInput(target, "$sha256", "an exact copy of the source credentials");
    }
    outputFiles.push(writtenFile);
  }
  await rejectCurrentConfig(join(configRoot, "bot.json"));
  if (sourceGoogleAuth !== undefined) await rejectCurrentConfig(join(configRoot, "g-auth.json"));
  for (const input of inputs) {
    const expected: BotMigrationFile | null = mappings.find(
      (mapping: BotConfigMigrationMapping): boolean => mapping.source.path === input.source
    )?.source ?? null;
    if (JSON.stringify(await readBotMigrationFile(input.source)) !== JSON.stringify(expected)) {
      return invalidInput(input.source, "$snapshot", "an unchanged cold backup including file metadata and links");
    }
  }
  const result: BotConfigMigrationResult = {
    sourceFormat: "telegram identity / randomImageDir / scalar cron images / optional root Google credentials",
    targetFormat: "bot atmosphere / randomHImageDir / array cron images / config Google credentials",
    sourceConfigRoot: configRoot, sourceDataRoot: dataRoot, outputRoot: output, mappings, outputFiles,
  };
  await atomicWriteText(join(output, "ready.json"), `${JSON.stringify(result, null, 2)}\n`, STAGING_FILE_MODE);
  await Bun.file(join(output, "incomplete.json")).delete();
  return result;
}

/** CLI 参数全部显式，不推测部署路径，不接受重复或未知选项。 */
function parseArguments(args: readonly string[]): BotConfigMigrationOptions {
  const values: Map<string, string> = new Map();
  for (let index: number = 0; index < args.length; index += 2) {
    const key: string | undefined = args[index];
    const value: string | undefined = args[index + 1];
    if (key === undefined || !["--source-config-root", "--source-data-root", "--output-root", "--source-google-auth"].includes(key) ||
      values.has(key) || value === undefined || value.trim().length === 0 || value.startsWith("--")) {
      return invalidInput("arguments", "$", "--source-config-root <backup-config> --source-data-root <backup-data> --output-root <new-directory> [--source-google-auth <backup-file>]");
    }
    values.set(key, value);
  }
  const sourceConfigRoot: string | undefined = values.get("--source-config-root");
  const sourceDataRoot: string | undefined = values.get("--source-data-root");
  const outputRoot: string | undefined = values.get("--output-root");
  if (sourceConfigRoot === undefined || sourceDataRoot === undefined || outputRoot === undefined) {
    return invalidInput("arguments", "$", "all three explicit directory options");
  }
  return { sourceConfigRoot, sourceDataRoot, outputRoot, sourceGoogleAuth: values.get("--source-google-auth") };
}

if (import.meta.main) {
  if (Bun.argv.length === 3 && Bun.argv[2] === "--help") {
    console.log("migrate:bot-config --source-config-root <backup-config> --source-data-root <backup-data> --output-root <new-directory> [--source-google-auth <backup-file>]\n" +
      "Binary: BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/migrateBotConfig.js <options>\n" +
      "Stop the service and verify inactive before taking external backups. Sources remain unchanged.\n" +
      "Only ready.json marks validated output. After interruption rerun into a new output directory.\n" +
      "Verify hashes; manually deploy only mapped config/ and data/ files and remove the old telegram.json after backup.\n" +
      "For root g-auth.json from 12.1.0, pass its external backup explicitly with --source-google-auth.\n" +
      "Validated credentials are copied byte-for-byte to config/g-auth.json; conflicting config credentials are rejected.\n" +
      "Restore original ownership, modes and symbolic links from mappings. No image directories are moved.\n" +
      "Use migrate:random-image-names for library names. Validate configuration and state before startup.\n" +
      "Retain backups until service stability is confirmed.");
  } else {
    try {
      const result: BotConfigMigrationResult = await prepareBotConfigMigration(parseArguments(Bun.argv.slice(2)));
      console.log(`Bot configuration migration prepared: ${result.outputRoot}/ready.json. Manual replacement while stopped is required.`);
    } catch (error: unknown) {
      console.error(error instanceof InputValidationError ? error.message
        : "Bot configuration migration failed; source backups and incomplete output are retained. No deployment files were replaced.");
      process.exitCode = 1;
    }
  }
}
