import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReleaseCommand, readBuildSourceTree } from "../../scripts/release/command";
import type { CommandResult, ReleaseCommand } from "../../scripts/release/command";
import { ACTIVE_COLD_MIGRATION_EDGES } from "../../scripts/migrations/active";
import { fileSha256, verifyReleaseAssets } from "../../scripts/release/assets";
import type { ReleaseAsset } from "../../scripts/release/assets";
import { publishRelease } from "../../scripts/release/github";

const TREE: string = "a".repeat(40);
const HEAD: string = "b".repeat(40);
const TAG_OBJECT: string = "c".repeat(40);
const VERSION: string = "12.1.0";
const NOTES: string = "## Highlights\nBinary releases.\n\n## Compatibility / Migration Notes\nCurrent storage format.\n\n## Validation\nMock verification.\n";
const roots: string[] = [];

async function fixture(
  overrides: Readonly<Record<string, unknown>> = {},
  migrationPaths: readonly string[] = ACTIVE_COLD_MIGRATION_EDGES.map((edge): string => edge.bundledPath)
): Promise<{ root: string; notes: string }> {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-release-test-"));
  roots.push(root);
  const content: string = join(root, "content/copy-ninjia");
  mkdirSync(content, { recursive: true });
  await Bun.write(join(content, "binary.json"), JSON.stringify({
    version: VERSION, platform: "linux-x64", bun: Bun.version, bunRevision: Bun.revision, sourceTree: TREE, ...overrides,
  }));
  for (const path of migrationPaths) await Bun.write(join(content, path), "export {};\n");
  const archive: string = join(root, "copy-ninjia-linux-x64.tar.gz");
  const result: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync({ cmd: ["tar", "-czf", archive, "copy-ninjia"], cwd: join(root, "content"), stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  await Bun.write(`${archive}.sha256`, `${await fileSha256(archive)}  copy-ninjia-linux-x64.tar.gz\n`);
  const notes: string = join(root, "release notes.md");
  await Bun.write(notes, NOTES);
  return { root, notes };
}

function verifiedAssets(root: string, platforms: readonly string[] = ["linux-x64"]): Promise<readonly ReleaseAsset[]> {
  return verifyReleaseAssets({ directory: root, version: VERSION, platforms, sourceTree: TREE, command: createReleaseCommand(root) });
}

interface FakeRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  body: string;
  html_url: string;
  assets: { name: string; size: number; state: string }[];
}

function github(assets: readonly ReleaseAsset[], options: {
  existing?: boolean; published?: boolean; corrupt?: boolean; failUpload?: boolean; failEdit?: boolean;
  movedMaster?: boolean; apiFailure?: boolean; newestVersion?: string; wrongNotes?: boolean; missingPublishedAssets?: boolean;
} = {}): { command: ReleaseCommand; calls: string[]; state: { release: FakeRelease | null } } {
  const calls: string[] = [];
  const state: { release: FakeRelease | null } = { release: options.existing ? {
    tag_name: VERSION, draft: !options.published, prerelease: false, body: options.wrongNotes ? "wrong" : NOTES,
    html_url: "https://github.com/Asashishi/copy_ninjia/releases/tag/12.1.0",
    assets: options.missingPublishedAssets ? [] : assets.map((asset: ReleaseAsset) => ({ name: asset.name, size: asset.size, state: "uploaded" })),
  } : null };
  const ok = (stdout: string = ""): CommandResult => ({ exitCode: 0, stdout });
  const command = (arguments_: readonly string[]): CommandResult => {
    const value: string = arguments_.join(" ");
    calls.push(value);
    if (arguments_[0] === "git") {
      if (arguments_[1] === "branch") return ok("master");
      if (arguments_[1] === "remote") return ok("https://github.com/Asashishi/copy_ninjia.git");
      if (arguments_[1] === "cat-file") return ok("tag");
      if (arguments_[1] === "rev-parse") return ok(arguments_[2] === `refs/tags/${VERSION}` ? TAG_OBJECT : HEAD);
      if (arguments_[1] === "ls-remote") return ok(`${options.movedMaster ? "d".repeat(40) : HEAD}\trefs/heads/master\n${TAG_OBJECT}\trefs/tags/${VERSION}\n${HEAD}\trefs/tags/${VERSION}^{}\n`);
      throw new Error(`Unexpected Git operation: ${value}`);
    }
    if (arguments_[0] !== "gh") throw new Error(`Unexpected command: ${value}`);
    if (arguments_[1] === "api") {
      if (options.apiFailure) return { exitCode: 1, stdout: "HTTP/2.0 403 Forbidden\r\n\r\n{}" };
      if (arguments_[2]?.includes("?per_page=")) return ok(JSON.stringify([[], state.release ? [state.release] : []]));
      if (arguments_[2]?.endsWith("/latest")) {
        return ok("HTTP/2.0 200 OK\r\n\r\n" + JSON.stringify({
          tag_name: state.release && !state.release.draft ? VERSION : options.newestVersion ?? "12.0.0",
          draft: false, prerelease: false, body: NOTES, html_url: "https://example.invalid/release", assets: [],
        }));
      }
    }
    if (arguments_[2] === "create") {
      expect(arguments_).toContain("--draft");
      expect(arguments_).toContain("--verify-tag");
      state.release = { tag_name: VERSION, draft: true, prerelease: false, body: NOTES, html_url: "https://example.invalid/release", assets: [] };
      return ok();
    }
    if (arguments_[2] === "upload") {
      expect(arguments_).not.toContain("--clobber");
      if (options.failUpload) return { exitCode: 1, stdout: "" };
      for (const asset of assets) {
        if (arguments_.includes(asset.path)) state.release!.assets.push({ name: asset.name, size: asset.size, state: "uploaded" });
      }
      return ok();
    }
    if (arguments_[2] === "download") {
      const directory: string = arguments_[arguments_.indexOf("--dir") + 1]!;
      for (const asset of assets) {
        if (!arguments_.includes(asset.name)) continue;
        if (!state.release?.assets.some((entry) => entry.name === asset.name)) return { exitCode: 1, stdout: "" };
        const result: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync({ cmd: ["cp", "--", options.corrupt ? assets[1]!.path : asset.path, join(directory, asset.name)], stdout: "pipe", stderr: "pipe" });
        expect(result.exitCode).toBe(0);
      }
      return ok();
    }
    if (arguments_[2] === "edit") {
      if (options.failEdit) return { exitCode: 1, stdout: "" };
      state.release!.draft = false;
      return ok();
    }
    throw new Error(`Unexpected GitHub operation: ${value}`);
  };
  return { command, calls, state };
}

afterEach((): void => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("发布资产与谱系", (): void => {
  test("校验压缩包内的版本、平台、Git tree、Bun build 及两份资产的内容", async (): Promise<void> => {
    const { root } = await fixture();
    const assets: readonly ReleaseAsset[] = await verifiedAssets(root);
    expect(assets).toHaveLength(2);
    expect(assets[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  test.each([{ version: "development" }, { platform: "linux-arm64" }, { sourceTree: null }, { sourceTree: "f".repeat(40) }, { bun: "1.0.0" }, { bunRevision: "different" }])(
    "拒绝错误构建元数据：%j", async (overrides): Promise<void> => {
      const { root } = await fixture(overrides);
      await expect(verifiedAssets(root)).rejects.toThrow("binary.json must match");
    }
  );
  test("拒绝损坏校验和和声明后缺失的平台", async (): Promise<void> => {
    const { root } = await fixture();
    await expect(verifiedAssets(root, ["linux-x64", "linux-arm64"])).rejects.toThrow();
    await Bun.write(join(root, "copy-ninjia-linux-x64.tar.gz.sha256"), "bad checksum\n");
    await expect(verifiedAssets(root)).rejects.toThrow("SHA-256 mismatch");
  });
  test.each(["missing", "obsolete", "source-map"])("拒绝迁移交付清单不完整或混入额外产物：%s", async (kind: string): Promise<void> => {
    const paths: string[] = ACTIVE_COLD_MIGRATION_EDGES.map((edge): string => edge.bundledPath);
    if (kind === "missing") paths.pop();
    else paths.push(kind === "obsolete" ? "scripts/migrations/migrateOldFormat.js" : "scripts/migrations/migrateBotConfig.js.map");
    const { root }: { root: string } = await fixture({}, paths);
    await expect(verifiedAssets(root)).rejects.toThrow("exactly the active migration bundles and no source maps");
  });
  test("本地未提交改动不能获得发布用 Git tree", (): void => {
    expect(readBuildSourceTree(() => ({ exitCode: 0, stdout: " M scripts/build.ts\n" }))).toBeNull();
    expect(readBuildSourceTree((args) => ({ exitCode: 0, stdout: args[1] === "status" ? "" : TREE }))).toBe(TREE);
  });
});

describe("Release 草稿发布事务", (): void => {
  test("先上传并回读，再公开，再核对 Latest 和公开资产", async (): Promise<void> => {
    const { root, notes } = await fixture();
    const assets: readonly ReleaseAsset[] = await verifiedAssets(root);
    const fake = github(assets);
    await publishRelease({ version: VERSION, notesPath: notes, assets, command: fake.command });
    const create: number = fake.calls.findIndex((call) => call.startsWith("gh release create"));
    const upload: number = fake.calls.findIndex((call) => call.startsWith("gh release upload"));
    const download: number = fake.calls.findIndex((call) => call.startsWith("gh release download"));
    const publish: number = fake.calls.findIndex((call) => call.startsWith("gh release edit"));
    expect(create).toBeLessThan(upload);
    expect(upload).toBeLessThan(download);
    expect(download).toBeLessThan(publish);
    expect(fake.calls.slice(publish + 1).some((call) => call.startsWith("gh release download"))).toBe(true);
    expect(fake.state.release?.draft).toBe(false);
    expect(fake.calls.some((call) => /git (reset|push|tag|merge)/.test(call))).toBe(false);
  });
  test.each([{ existing: true }, { existing: true, published: true }])("相同 tag 的续跑仅核验已上传资产：%j", async (options): Promise<void> => {
    const { root, notes } = await fixture();
    const assets: readonly ReleaseAsset[] = await verifiedAssets(root);
    const fake = github(assets, options);
    await publishRelease({ version: VERSION, notesPath: notes, assets, command: fake.command });
    expect(fake.calls.some((call) => /gh release (create|upload)/.test(call))).toBe(false);
  });
  test("草稿续传先验证现有包，只上传缺失校验文件", async (): Promise<void> => {
    const { root, notes } = await fixture();
    const assets: readonly ReleaseAsset[] = await verifiedAssets(root);
    const fake = github(assets, { existing: true });
    fake.state.release!.assets.pop();
    await publishRelease({ version: VERSION, notesPath: notes, assets, command: fake.command });
    const upload: string = fake.calls.find((call) => call.startsWith("gh release upload"))!;
    expect(upload.endsWith(assets[1]!.path)).toBe(true);
    expect(upload.split(" ")).not.toContain(assets[0]!.path);
    expect(fake.calls.findIndex((call) => call.startsWith("gh release download"))).toBeLessThan(fake.calls.indexOf(upload));
    expect(fake.state.release?.assets).toHaveLength(2);
    expect(fake.calls.some((call) => call.startsWith("gh release create"))).toBe(false);
  });
  test("轻量 tag 在创建草稿前被拒绝", async (): Promise<void> => {
    const { root, notes } = await fixture();
    const assets: readonly ReleaseAsset[] = await verifiedAssets(root);
    const fake = github(assets);
    const command = (args: readonly string[]): CommandResult => args[0] === "git" && args[1] === "cat-file"
      ? { exitCode: 0, stdout: "commit" } : fake.command(args);
    await expect(publishRelease({ version: VERSION, notesPath: notes, assets, command })).rejects.toThrow("annotated release tag");
    expect(fake.calls.some((call) => call.startsWith("gh "))).toBe(false);
  });
  test.each([
    { corrupt: true }, { failUpload: true }, { movedMaster: true }, { apiFailure: true },
    { newestVersion: "13.0.0" }, { existing: true, wrongNotes: true }, { existing: true, corrupt: true },
    { existing: true, published: true, missingPublishedAssets: true },
  ])("失败时不公开、不覆盖资产、不同步 dev：%j", async (options): Promise<void> => {
    const { root, notes } = await fixture();
    const assets: readonly ReleaseAsset[] = await verifiedAssets(root);
    const fake = github(assets, options);
    await expect(publishRelease({ version: VERSION, notesPath: notes, assets, command: fake.command })).rejects.toThrow();
    expect(fake.calls.some((call) => call.startsWith("gh release edit"))).toBe(false);
    expect(fake.calls.some((call) => call.includes("--clobber") || call.startsWith("git push") || call.startsWith("git reset"))).toBe(false);
  });
  test("公开步骤失败保留草稿和已上传资产", async (): Promise<void> => {
    const { root, notes } = await fixture();
    const assets: readonly ReleaseAsset[] = await verifiedAssets(root);
    const fake = github(assets, { failEdit: true });
    await expect(publishRelease({ version: VERSION, notesPath: notes, assets, command: fake.command })).rejects.toThrow();
    expect(fake.state.release?.draft).toBe(true);
    expect(fake.state.release?.assets).toHaveLength(2);
  });
});
