import { fileSha256 } from "../fileSha256";
import { ACTIVE_COLD_MIGRATION_EDGES } from "../migrations/active";
import type { ColdMigrationEdge } from "../migrations/active";
import { join } from "node:path";
import { checked } from "./command";
import type { ReleaseCommand } from "./command";
import { RELEASE_PLATFORMS, RELEASE_REQUIRED_FILES, RELEASE_VERSION_PATTERN } from "../../packages/consts/release";

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

/** 核对哈希、两份清单版本、必需普通文件、主程序执行位、依赖隔离及构建谱系。 */
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
    const entries: readonly string[] = checked(command, ["tar", "-tzf", path]).split("\n");
    const migrations: readonly string[] = ACTIVE_COLD_MIGRATION_EDGES.map(
      (edge: ColdMigrationEdge): string => `copy-ninjia/${edge.bundledPath}`
    );
    if (migrations.some((entry: string): boolean => !entries.includes(entry)) ||
      entries.some((entry: string): boolean => entry.endsWith(".map") ||
        (/^copy-ninjia\/scripts\/(?:migrations\/)?migrate[^/]*\.js$/.test(entry) && !migrations.includes(entry)))) {
      throw new Error(`${name}: package must contain exactly the active migration bundles and no source maps.`);
    }
    if (entries.some((entry: string): boolean => entry.includes("/node_modules/") || entry.startsWith("node_modules/") || entry.endsWith("/node_modules") || entry === "node_modules")) {
      throw new Error(`${name}: package must not contain node_modules.`);
    }
    const details: readonly string[] = checked(command, ["tar", "-tvzf", path]).split("\n");
    if (details.length !== entries.length) throw new Error(`${name}: tar entry and mode listings must align.`);
    for (const required of [...RELEASE_REQUIRED_FILES, ...migrations]) {
      let occurrences: number = 0;
      for (const entry of entries) if (entry === required) occurrences++;
      const detail: string | undefined = details[entries.indexOf(required)];
      if (occurrences !== 1 || detail?.[0] !== "-" || !detail.endsWith(` ${required}`) ||
        (required === "copy-ninjia/copy-ninjia" && detail[3] !== "x")) {
        throw new Error(`${name}: ${required} must be a unique regular file; the executable must retain its owner execute bit.`);
      }
    }
    const manifest: unknown = JSON.parse(checked(command, ["tar", "-xOf", path, "copy-ninjia/package.json"])) as unknown;
    if (manifest === null || typeof manifest !== "object" || !("version" in manifest) || manifest.version !== version) {
      throw new Error(`${name}: package.json must match the release version.`);
    }
    assets.push({ name, path, sha256: checksum, size: Bun.file(path).size });
    assets.push({ name: `${name}.sha256`, path: checksumPath, sha256: await fileSha256(checksumPath), size: Bun.file(checksumPath).size });
  }
  return assets;
}
