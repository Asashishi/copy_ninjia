import { join } from "node:path";
import { checked } from "./command";
import type { ReleaseCommand } from "./command";

/** 安装器支持的平台名称；每次发布由 --platforms 明确选择，禁止静默缺项。 */
export const RELEASE_PLATFORMS: readonly string[] = ["linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl"];
/** Release tag 与发行包版本使用同一种无前缀版本号。 */
export const RELEASE_VERSION_PATTERN: RegExp = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface ReleaseAsset {
  readonly name: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface VerifyAssetsOptions {
  readonly directory: string;
  readonly version: string;
  readonly platforms: readonly string[];
  readonly sourceTree: string;
  readonly command: ReleaseCommand;
}

/** 流式计算压缩包 SHA-256，不把多平台发行包同时载入内存。 */
export async function fileSha256(path: string): Promise<string> {
  const hasher: Bun.CryptoHasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/** 同时核对文件对、内容哈希、包内版本、平台、Bun 构建和 squash 前后相同的 Git tree。 */
export async function verifyReleaseAssets({ directory, version, platforms, sourceTree, command }: VerifyAssetsOptions): Promise<readonly ReleaseAsset[]> {
  if (!RELEASE_VERSION_PATTERN.test(version) || !/^[a-f0-9]{40}$/.test(sourceTree)) throw new Error("Release version and source tree must be explicit.");
  if (platforms.length === 0 || new Set(platforms).size !== platforms.length || platforms.some((value: string): boolean => !RELEASE_PLATFORMS.includes(value))) {
    throw new Error("--platforms must contain unique supported Linux platforms.");
  }
  const assets: ReleaseAsset[] = [];
  for (const platform of platforms) {
    const name: string = `copy-ninjia-${platform}.tar.gz`;
    const path: string = join(directory, name);
    const checksumPath: string = `${path}.sha256`;
    const checksum: string = await fileSha256(path);
    if ((await Bun.file(checksumPath).text()).trimEnd() !== `${checksum}  ${name}`) throw new Error(`${name}: SHA-256 mismatch or malformed checksum file.`);
    const metadata: unknown = JSON.parse(checked(command, ["tar", "-xOf", path, "copy-ninjia/binary.json"])) as unknown;
    if (metadata === null || typeof metadata !== "object" || !("version" in metadata) || metadata.version !== version ||
      !("platform" in metadata) || metadata.platform !== platform || !("sourceTree" in metadata) || metadata.sourceTree !== sourceTree ||
      !("bun" in metadata) || metadata.bun !== Bun.version || !("bunRevision" in metadata) || metadata.bunRevision !== Bun.revision) {
      throw new Error(`${name}: binary.json must match the release version, platform, clean source tree and current Bun build.`);
    }
    assets.push({ name, path, sha256: checksum, size: Bun.file(path).size });
    assets.push({ name: `${name}.sha256`, path: checksumPath, sha256: await fileSha256(checksumPath), size: Bun.file(checksumPath).size });
  }
  return assets;
}
