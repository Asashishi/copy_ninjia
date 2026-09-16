import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checked, verifyReleaseReferences } from "./command";
import type { CommandResult, ReleaseCommand } from "./command";
import { fileSha256, RELEASE_VERSION_PATTERN } from "./assets";
import type { ReleaseAsset } from "./assets";

/** 发布仓库固定为安装器下载来源，显式主机避免 GH_REPO/GH_HOST 改变目标。 */
const REPOSITORY: string = "github.com/Asashishi/copy_ninjia";
interface RemoteAsset { readonly name: string; readonly size: number; readonly state: string; }
interface RemoteRelease {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly body: string;
  readonly assets: readonly Readonly<RemoteAsset>[];
  readonly html_url: string;
}

/** 远端返回值必须具有发布门禁消费的全部字段。 */
function parseRelease(value: unknown): RemoteRelease {
  if (value === null || typeof value !== "object" || !("tag_name" in value) || typeof value.tag_name !== "string" ||
    !("draft" in value) || typeof value.draft !== "boolean" || !("prerelease" in value) || typeof value.prerelease !== "boolean" ||
    !("body" in value) || typeof value.body !== "string" || !("html_url" in value) || typeof value.html_url !== "string" ||
    !("assets" in value) || !Array.isArray(value.assets)) throw new Error("Malformed GitHub Release state.");
  for (const asset of value.assets as unknown[]) {
    if (asset === null || typeof asset !== "object" || !("name" in asset) || typeof asset.name !== "string" ||
      !("size" in asset) || typeof asset.size !== "number" || !("state" in asset) || typeof asset.state !== "string") {
      throw new Error("Malformed GitHub Release asset.");
    }
  }
  return value as RemoteRelease;
}

/** 草稿通过完整分页列表读取；Latest 只有明确的 HTTP 404 才表示不存在。 */
function readRelease(command: ReleaseCommand, selector: string): RemoteRelease | null {
  if (selector.startsWith("tags/")) {
    const pages: unknown = JSON.parse(checked(command, ["gh", "api", "repos/Asashishi/copy_ninjia/releases?per_page=100", "--hostname", "github.com", "--paginate", "--slurp"])) as unknown;
    if (!Array.isArray(pages)) throw new Error("Malformed GitHub Release list.");
    let matched: RemoteRelease | null = null;
    for (const page of pages as unknown[]) {
      if (!Array.isArray(page)) throw new Error("Malformed GitHub Release page.");
      for (const value of page as unknown[]) {
        if (value !== null && typeof value === "object" && "tag_name" in value && value.tag_name === selector.slice(5)) {
          if (matched !== null) throw new Error("Multiple GitHub Releases use the selected tag.");
          matched = parseRelease(value);
        }
      }
    }
    return matched;
  }
  const result: CommandResult = command(["gh", "api", `repos/Asashishi/copy_ninjia/releases/${selector}`, "--hostname", "github.com", "--include"]);
  const header: RegExpExecArray | null = /^HTTP\/\S+\s+(\d+)[\s\S]*?\r?\n\r?\n/.exec(result.stdout);
  if (header?.[1] === "404") return null;
  if (result.exitCode !== 0 || header?.[1] !== "200") throw new Error("Cannot read GitHub Release state.");
  return parseRelease(JSON.parse(result.stdout.slice(header[0].length)) as unknown);
}

/** Latest 只允许前进；同版本仅用于恢复一次已公开但尚未完成确认的发布。 */
function assertVersionAdvances(version: string, latest: RemoteRelease | null): void {
  if (latest === null || latest.tag_name === version) return;
  if (!RELEASE_VERSION_PATTERN.test(latest.tag_name)) throw new Error("Latest Release must use MAJOR.MINOR.PATCH.");
  const target: readonly string[] = version.split(".");
  const previous: readonly string[] = latest.tag_name.split(".");
  for (let index: number = 0; index < 3; index++) {
    if (BigInt(target[index]!) > BigInt(previous[index]!)) return;
    if (BigInt(target[index]!) < BigInt(previous[index]!)) break;
  }
  throw new Error("Release version must be newer than GitHub Latest.");
}

/** 下载到全新临时目录，逐文件核对实际内容；失败也清理验证副本，不改远端资产。 */
async function verifyRemoteAssets(command: ReleaseCommand, version: string, assets: readonly ReleaseAsset[]): Promise<void> {
  const directory: string = mkdtempSync(join(tmpdir(), "copy-ninjia-release-download-"));
  try {
    const arguments_: string[] = ["gh", "release", "download", version, "--repo", REPOSITORY, "--dir", directory];
    for (const asset of assets) arguments_.push("--pattern", asset.name);
    checked(command, arguments_);
    for (const asset of assets) {
      if (await fileSha256(join(directory, asset.name)) !== asset.sha256) throw new Error(`${asset.name}: downloaded Release asset differs from the validated local file.`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export interface PublishReleaseOptions {
  readonly version: string;
  readonly notesPath: string;
  readonly assets: readonly ReleaseAsset[];
  readonly command: ReleaseCommand;
}

/** 先在草稿上补齐并验证资产，再公开为 Latest；已上传同名资产只验证，绝不覆盖。 */
export async function publishRelease({ version, notesPath, assets, command }: PublishReleaseOptions): Promise<string> {
  if (!RELEASE_VERSION_PATTERN.test(version)) throw new Error("Release version must be MAJOR.MINOR.PATCH.");
  if (assets.length === 0) throw new Error("Release assets are required.");
  const notes: string = (await Bun.file(notesPath).text()).trim();
  for (const heading of ["Highlights", "Compatibility / Migration Notes", "Validation"]) {
    if (!notes.split("\n").some((line: string): boolean => line.replace(/^#{1,6}\s+/, "").trim() === heading)) {
      throw new Error(`Release notes must contain ${heading}.`);
    }
  }
  verifyReleaseReferences(command, version);
  assertVersionAdvances(version, readRelease(command, "latest"));
  let release: RemoteRelease | null = readRelease(command, `tags/${version}`);
  if (release === null) {
    checked(command, ["gh", "release", "create", version, "--repo", REPOSITORY, "--verify-tag", "--target", "master", "--draft", "--title", version, "--notes-file", notesPath]);
    release = readRelease(command, `tags/${version}`);
  }
  if (release?.tag_name !== version || release.prerelease || release.body.trim() !== notes) {
    throw new Error("Release must match the selected tag and notes and must not be a prerelease.");
  }
  const missing: ReleaseAsset[] = [];
  const existing: ReleaseAsset[] = [];
  for (const asset of assets) {
    const matches: readonly RemoteAsset[] = release.assets.filter((candidate: RemoteAsset): boolean => candidate.name === asset.name);
    if (matches.length === 0) missing.push(asset);
    else if (matches.length === 1 && matches[0]!.state === "uploaded" && matches[0]!.size === asset.size) existing.push(asset);
    else throw new Error(`${asset.name}: existing asset is incomplete or differs; refusing to overwrite it.`);
  }
  if (!release.draft && missing.length > 0) throw new Error("Published Release is missing required assets; refusing to modify it.");
  if (existing.length > 0) await verifyRemoteAssets(command, version, existing);
  if (missing.length > 0) checked(command, ["gh", "release", "upload", version, "--repo", REPOSITORY, ...missing.map((asset: ReleaseAsset): string => asset.path)]);
  await verifyRemoteAssets(command, version, assets);
  verifyReleaseReferences(command, version);
  assertVersionAdvances(version, readRelease(command, "latest"));
  if (release.draft) checked(command, ["gh", "release", "edit", version, "--repo", REPOSITORY, "--draft=false", "--latest", "--verify-tag"]);
  release = readRelease(command, `tags/${version}`);
  const latest: RemoteRelease | null = readRelease(command, "latest");
  if (release?.tag_name !== version || release.body.trim() !== notes || release.draft || release.prerelease || latest?.tag_name !== version) {
    throw new Error("Release publication or Latest status was not confirmed.");
  }
  await verifyRemoteAssets(command, version, assets);
  verifyReleaseReferences(command, version);
  return release.html_url;
}
