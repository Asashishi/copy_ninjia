import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Dirent, Stats } from "node:fs";
import {
  RANDOM_IMAGE_CONTENT_NAME_PATTERN,
  RANDOM_IMAGE_EXTENSIONS,
  RANDOM_IMAGE_SAVE_EXTENSIONS,
} from "../packages/consts/randomImage";
import { sniffImageFormat } from "../packages/infra/image";
import { atomicWriteText, syncDirectory } from "../packages/libs/atomicFile";
import { InputValidationError, invalidInput } from "../packages/libs/inputValidation";

/** 暂存目录仅当前账号可进入，部署权限由运维按清单手工恢复。 */
const STAGING_DIRECTORY_MODE: number = 0o700;
/** 校验清单只允许当前账号读写。 */
const STAGING_FILE_MODE: number = 0o600;
/** 嗅探格式只需文件头；webp 的魔数最长，12 字节足够（见 infra/image.ts）。 */
const FORMAT_SNIFF_BYTES: number = 12;

export interface RandomImageNameMigrationOptions {
  /** 停机备份里的图库目录。 */
  readonly sourceDirectory: string;
  /** 产物目录，必须是一个新目录，且与源目录互不包含。 */
  readonly outputDirectory: string;
}

/** 一张图在源目录里的事实；哈希同时是它在产物里的文件名主干。 */
export interface RandomImageRecord {
  readonly name: string;
  readonly sha256: string;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

/** 一次内容重名：多张源文件字节完全相同，产物里只保留一份。 */
export interface RandomImageDuplicate {
  /** 保留下来的那张源文件名。 */
  readonly kept: string;
  /** 因为与 kept 字节相同而没有写进产物的源文件名。 */
  readonly dropped: readonly string[];
  /** 这份内容在产物里的文件名。 */
  readonly fileName: string;
}

export interface RandomImageNameMigrationResult {
  readonly sourceDirectory: string;
  readonly outputDirectory: string;
  /** 源目录里参与迁移的图片，按名字排序。 */
  readonly sourceFiles: readonly RandomImageRecord[];
  /** 产物目录里的图片，名字就是内容 SHA-256 加保存扩展名。 */
  readonly outputFiles: readonly RandomImageRecord[];
  /** 已经是目标形态、只是原样复制过来的张数。 */
  readonly alreadyNamed: number;
  /** 改了名字的张数。 */
  readonly renamed: number;
  /** 因内容重复而合并掉的张数；明细见 duplicates。 */
  readonly deduplicated: number;
  readonly duplicates: readonly RandomImageDuplicate[];
}

/** 清单哈希按 Bun 文件流增量计算，不把整张图读进内存。 */
async function fileSha256(path: string): Promise<string> {
  const hasher: Bun.CryptoHasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/** 单张图的事实：内容哈希与部署权限元数据；符号链接与非普通文件一律拒绝。 */
async function readImageRecord(directory: string, name: string): Promise<RandomImageRecord> {
  const path: string = join(directory, name);
  const stats: Stats = await lstat(path);
  if (!stats.isFile()) return invalidInput(path, "$type", "a regular file without symbolic links");
  return { name, sha256: await fileSha256(path), mode: stats.mode & 0o7777, uid: stats.uid, gid: stats.gid };
}

/**
 * 列一遍源目录并拒绝任何不是图库候选的条目。
 *
 * 口径与生产抽图逐字一致（见 infra/randomImage.ts 的 randomImageNames）：非隐藏普通文件、
 * 扩展名命中 RANDOM_IMAGE_EXTENSIONS。其余条目——隐藏文件、子目录、符号链接、别的扩展名
 * ——一律点名后拒绝整次迁移，而不是悄悄跳过：图库目录是部署方的数据，迁移脚本无权替它
 * 判断哪些东西可以不要（见 AGENTS.md「不为用户行为兜底」）。
 */
async function sourceImageNames(directory: string): Promise<readonly string[]> {
  const entries: readonly Dirent[] = await readdir(directory, { withFileTypes: true });
  const names: string[] = [];
  const rejected: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && !entry.name.startsWith(".") &&
      RANDOM_IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      names.push(entry.name);
      continue;
    }
    rejected.push(entry.name);
  }
  if (rejected.length > 0) {
    return invalidInput(
      join(directory, rejected.sort()[0]!),
      "$entries",
      `only random image files; remove or move these first: ${rejected.sort().join(", ")}`
    );
  }
  return names.sort();
}

/** 按文件头判定保存扩展名；jpeg、png、webp 之外一律拒绝，绝不沿用原扩展名猜。 */
async function saveExtension(directory: string, name: string): Promise<string> {
  const head: Uint8Array = await Bun.file(join(directory, name)).slice(0, FORMAT_SNIFF_BYTES).bytes();
  const extension: string | undefined = RANDOM_IMAGE_SAVE_EXTENSIONS.get(sniffImageFormat(head));
  if (extension === undefined) {
    return invalidInput(join(directory, name), "$format", "jpeg, png or webp content");
  }
  return extension;
}

function isInside(parent: string, child: string): boolean {
  const path: string = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"));
}

/** 源文件名去掉扩展名之后是不是已经是内容哈希形态。 */
function alreadyContentNamed(name: string, fileName: string): boolean {
  return name === fileName && RANDOM_IMAGE_CONTENT_NAME_PATTERN.test(name.slice(0, name.length - extname(name).length));
}

/**
 * 把一个图库目录的旧文件名（`<uuidv7>[-<file_unique_id>]<扩展名>`）迁移成内容 SHA-256 命名。
 *
 * 不改源目录、不覆盖既有目录、不执行任何服务操作：整份产物写进一个新目录，`ready.json`
 * 是唯一的完成标记，中断后换一个新的产物目录重跑。字节完全相同的多张图在产物里合并成
 * 一份（文件名就是内容摘要，重名即重复），合并明细写进 `ready.json` 的 duplicates。
 * 扩展名按文件头重判，因此 `.jpeg` 会落成 `.jpg`、名实不符的扩展名会被纠正。
 *
 * 部署方按 docs/cn/04-invariants.md 的持久化边界，在服务停止期间手工替换图库目录，
 * 并按 sourceFiles 恢复属主与权限。
 */
export async function prepareRandomImageNameMigration(
  { sourceDirectory, outputDirectory }: RandomImageNameMigrationOptions
): Promise<RandomImageNameMigrationResult> {
  const source: string = await realpath(sourceDirectory);
  const output: string = join(await realpath(dirname(resolve(outputDirectory))), basename(resolve(outputDirectory)));
  if (isInside(source, output) || isInside(output, source)) {
    return invalidInput(output, "$path", "a new directory outside the source image library");
  }
  const names: readonly string[] = await sourceImageNames(source);
  const sourceFiles: RandomImageRecord[] = [];
  for (const name of names) sourceFiles.push(await readImageRecord(source, name));

  await mkdir(output, { mode: STAGING_DIRECTORY_MODE });
  await atomicWriteText(join(output, "incomplete.json"), JSON.stringify({ sourceDirectory: source, sourceFiles }, null, 2), STAGING_FILE_MODE);

  const keptBySha: Map<string, string> = new Map();
  const droppedBySha: Map<string, string[]> = new Map();
  const fileNameBySha: Map<string, string> = new Map();
  const written: string[] = [];
  let alreadyNamed: number = 0;
  let renamed: number = 0;
  for (const record of sourceFiles) {
    const fileName: string = `${record.sha256}${await saveExtension(source, record.name)}`;
    const kept: string | undefined = keptBySha.get(record.sha256);
    if (kept !== undefined) {
      droppedBySha.set(record.sha256, [...droppedBySha.get(record.sha256) ?? [], record.name]);
      continue;
    }
    keptBySha.set(record.sha256, record.name);
    fileNameBySha.set(record.sha256, fileName);
    const target: string = join(output, fileName);
    await Bun.write(target, Bun.file(join(source, record.name)));
    if (await fileSha256(target) !== record.sha256) {
      return invalidInput(target, "$sha256", "an exact copy of the source image");
    }
    written.push(fileName);
    if (alreadyContentNamed(record.name, fileName)) alreadyNamed++;
    else renamed++;
  }
  await syncDirectory(join(output, "incomplete.json"));

  const recheck: readonly string[] = await sourceImageNames(source);
  const rechecked: RandomImageRecord[] = [];
  for (const name of recheck) rechecked.push(await readImageRecord(source, name));
  if (JSON.stringify(rechecked) !== JSON.stringify(sourceFiles)) {
    return invalidInput(source, "$snapshot", "an unchanged cold backup including file metadata");
  }

  const duplicates: RandomImageDuplicate[] = [];
  for (const [sha, dropped] of [...droppedBySha].sort()) {
    duplicates.push({ kept: keptBySha.get(sha)!, dropped: [...dropped].sort(), fileName: fileNameBySha.get(sha)! });
  }
  // 产物只列本次写下的那些名字：`incomplete.json` 与 `ready.json` 是校验清单，不是图库候选。
  const outputFiles: RandomImageRecord[] = [];
  for (const name of [...written].sort()) outputFiles.push(await readImageRecord(output, name));
  const result: RandomImageNameMigrationResult = {
    sourceDirectory: source,
    outputDirectory: output,
    sourceFiles,
    outputFiles,
    alreadyNamed,
    renamed,
    deduplicated: sourceFiles.length - outputFiles.length,
    duplicates,
  };
  await atomicWriteText(join(output, "ready.json"), `${JSON.stringify(result, null, 2)}\n`, STAGING_FILE_MODE);
  await Bun.file(join(output, "incomplete.json")).delete();
  return result;
}

/** CLI 不接受默认图库目录；源目录与产物目录都必须明确提供。 */
function parseArguments(args: readonly string[]): RandomImageNameMigrationOptions {
  const values: Map<string, string> = new Map();
  for (let index: number = 0; index < args.length; index += 2) {
    const key: string | undefined = args[index];
    const value: string | undefined = args[index + 1];
    if (key === undefined || !["--source-directory", "--output-directory"].includes(key) ||
      values.has(key) || value === undefined || value.trim().length === 0 || value.startsWith("--")) {
      return invalidInput("arguments", "$", "--source-directory <image-library> --output-directory <new-directory>");
    }
    values.set(key, value);
  }
  const sourceDirectory: string | undefined = values.get("--source-directory");
  const outputDirectory: string | undefined = values.get("--output-directory");
  if (sourceDirectory === undefined || outputDirectory === undefined) {
    return invalidInput("arguments", "$", "both required options");
  }
  return { sourceDirectory, outputDirectory };
}

if (import.meta.main) {
  if (Bun.argv.slice(2).length === 1 && Bun.argv[2] === "--help") {
    console.log("bun run migrate:random-image-names --source-directory <image-library> --output-directory <new-directory>\n" +
      "Stop the service and verify inactive before taking an external backup of the image library.\n" +
      "The source stays unchanged. Only ready.json marks validated output; after interruption rerun into a new output directory.\n" +
      "Every entry that is not a drawable library image aborts the run; remove or move those first.\n" +
      "Byte-identical pictures collapse into one file; see duplicates in ready.json.\n" +
      "Verify output hashes, then manually replace the library directory while stopped and restore ownership/modes from sourceFiles.\n" +
      "Retain the backup until service stability is confirmed.");
  } else {
    try {
      const result: RandomImageNameMigrationResult =
        await prepareRandomImageNameMigration(parseArguments(Bun.argv.slice(2)));
      console.log(
        `Random image name migration prepared: ${result.outputDirectory}/ready.json ` +
        `(${result.renamed} renamed, ${result.alreadyNamed} already named, ${result.deduplicated} deduplicated). ` +
        "Manual replacement while stopped is required."
      );
    } catch (error: unknown) {
      console.error(error instanceof InputValidationError
        ? error.message
        : "Random image name migration failed; the source library and incomplete output are retained. No deployment files were replaced.");
      process.exitCode = 1;
    }
  }
}
