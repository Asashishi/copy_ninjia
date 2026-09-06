import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupFixtures,
  createFixture,
  readText,
  runInstaller,
  systemdPrompt,
  validTelegram,
  writeText,
} from "../../scripts/installIsolation/fixture";
import type { InstallerFixture, InstallerRunResult } from "../../scripts/installIsolation/fixture";

const INSTALL_SCRIPT: string = await Bun.file(join(import.meta.dir, "../../install.sh")).text();
const MANIFEST: { readonly packageManager: string } = await Bun.file(
  join(import.meta.dir, "../../package.json")
).json();
const REQUIRED_VERSION: string = MANIFEST.packageManager.slice("bun@".length);

/** 只执行安装器中指定的原始片段，外部能力由测试夹具替换。 */
function scriptRange(startMarker: string, endMarker: string): string {
  const start: number = INSTALL_SCRIPT.indexOf(startMarker);
  const end: number = INSTALL_SCRIPT.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return INSTALL_SCRIPT.slice(start, end);
}

function runFragment(
  fixture: InstallerFixture,
  source: string,
  environment: Readonly<Record<string, string>> = {}
): { readonly exitCode: number; readonly output: string } {
  const result: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync({
    cmd: ["/bin/bash", "-c", `set -Eeuo pipefail\n${source}`],
    cwd: fixture.worktree,
    env: { PATH: "/usr/bin:/bin", ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    output: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
  };
}

afterEach(cleanupFixtures);

async function installationCalls(fixture: InstallerFixture): Promise<string> {
  return (await readText(fixture.callLog)).replaceAll("systemctl-secret-env=absent\n", "");
}

async function expectReadOnlyServiceQueries(fixture: InstallerFixture): Promise<void> {
  const calls: string[] = (await readText(fixture.outboundLog)).trim().split("\n");
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(call).toStartWith("systemctl:guarded:show ");
}

describe("安装器精确运行时边界", () => {
  test.each(["1.4.0", "1.4.1", "1.5.0", "2.0.0", "1.4.2-canary.1", "invalid", ""])(
    "拒绝不匹配的 Bun %s，并在依赖安装和配置写入前退出",
    async (version: string): Promise<void> => {
      const fixture: InstallerFixture = await createFixture();
      const result: InstallerRunResult = runInstaller(fixture, [], { FAKE_BUN_VERSION: version });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain(`需要 Bun ${REQUIRED_VERSION}`);
      expect(await installationCalls(fixture)).toBe("");
      await expectReadOnlyServiceQueries(fixture);
      expect(await Bun.file(join(fixture.configRoot, "telegram.json")).exists()).toBe(false);
      expect(await Bun.file(join(fixture.runtimeRoot, "database/storage.sqlite")).exists()).toBe(false);
    }
  );

  test.each([
    '{"packageManager":"bun@1.4.0"}',
    '{"packageManager":"npm@1.4.1"}',
    "{}",
    "null",
    "{",
  ])("拒绝漂移或非法 manifest：%s", async (manifest: string): Promise<void> => {
    const fixture: InstallerFixture = await createFixture();
    await writeText(join(fixture.worktree, "package.json"), manifest);
    const result: InstallerRunResult = runInstaller(fixture, []);
    expect(result.exitCode).not.toBe(0);
    expect(await installationCalls(fixture)).toBe("manifest:check\n");
    await expectReadOnlyServiceQueries(fixture);
    expect(await Bun.file(join(fixture.configRoot, "telegram.json")).exists()).toBe(false);
  });

  test("匹配时先核对 manifest，再进入原有安装流程", async (): Promise<void> => {
    const fixture: InstallerFixture = await createFixture();
    await writeText(join(fixture.configRoot, "telegram.json"), validTelegram(), 0o600);
    const result: InstallerRunResult = runInstaller(fixture, [
      { prompt: "是否重新填写？", reply: "n" },
      { prompt: "现在配置 AI 能力", reply: "n" },
      systemdPrompt(),
    ]);
    expect(result.exitCode).toBe(0);
    expect(await installationCalls(fixture)).toStartWith("manifest:check\nbun:install\n");
  });

  test("缺少 Bun 时把精确发行 tag 传给官方安装脚本", async (): Promise<void> => {
    const fixture: InstallerFixture = await createFixture();
    const tagLog: string = join(fixture.root, "installed-tag");
    const runtimeStep: string = scriptRange(
      "if ! command -v bun >/dev/null 2>&1 && [ -x",
      'step "4/8 安装依赖"'
    );
    const result: InstallerRunResult = runFragment(fixture, [
      "info() { :; }",
      'die() { printf "%s\\n" "$1" >&2; exit 1; }',
      "require_command() { :; }",
      "command() {",
      '  if [ "$*" = "-v bun" ]; then [ -f "$INSTALL_TAG_LOG" ];',
      '  else builtin command "$@"; fi',
      "}",
      'curl() { printf \'printf "%%s\\\\n" "$1" > "$INSTALL_TAG_LOG"\\n\'; }',
      "bun() {",
      '  if [ "$1" = "--version" ]; then printf "%s\\n" "$REQUIRED_BUN_VERSION";',
      '  else "$REAL_BUN_PATH" "$@"; fi',
      "}",
      runtimeStep,
    ].join("\n"), {
      BUN_INSTALL: join(fixture.root, "bun-install"),
      INSTALL_TAG_LOG: tagLog,
      REQUIRED_BUN_VERSION: REQUIRED_VERSION,
      REAL_BUN_PATH: Bun.argv[0]!,
    });
    expect(result).toEqual({ exitCode: 0, output: "" });
    expect((await readText(tagLog)).trim()).toBe(`bun-v${REQUIRED_VERSION}`);
  });
});

describe("下载入口转交目标工作树", () => {
  const handoff: string = scriptRange(
    'if [ "$SCRIPT_DIRECTORY" != "$(pwd -P)" ]; then',
    '\nverify_service_target "$PWD"'
  );

  test.each([false, true])(
    "COPY_NINJIA_DIR 复用既有工作树，绝对路径：%s",
    async (absolute: boolean): Promise<void> => {
      const fixture: InstallerFixture = await createFixture();
      const locateWorktree: string = scriptRange('SCRIPT_DIRECTORY=""', "\n# 下载入口只负责定位工作树");
      const repositoryProbe: string = scriptRange("is_repository_root() {", "\n# 这棵工作树自己");
      const result: InstallerRunResult = runFragment(fixture, [
        "info() { :; }",
        'die() { printf "%s\\n" "$1" >&2; exit 1; }',
        "worktree_version_suffix() { :; }",
        "require_command() { exit 97; }",
        repositoryProbe,
        'cd -- "$LAUNCH_DIR"',
        locateWorktree,
        "pwd -P",
      ].join("\n"), {
        LAUNCH_DIR: fixture.root,
        CLONE_TARGET: absolute ? fixture.worktree : "repository",
      });
      expect(result).toEqual({ exitCode: 0, output: `${fixture.worktree}\n` });
    }
  );

  test.each(["", "/downloaded installer"])(
    "来源为 %s 时执行目标安装器并保留退出码",
    async (sourceDirectory: string): Promise<void> => {
      const fixture: InstallerFixture = await createFixture();
      await writeText(join(fixture.worktree, "install.sh"), 'printf "target-installer\\n"\nexit 23\n');
      const result: InstallerRunResult = runFragment(fixture, `${handoff}\nprintf "outer-installer\\n"`, {
        SCRIPT_DIRECTORY: sourceDirectory,
      });
      expect(result).toEqual({ exitCode: 23, output: "target-installer\n" });
    }
  );

  test("已在目标工作树运行时不递归重入", async (): Promise<void> => {
    const fixture: InstallerFixture = await createFixture();
    const result: InstallerRunResult = runFragment(fixture, `${handoff}\nprintf "continue\\n"`, {
      SCRIPT_DIRECTORY: fixture.worktree,
    });
    expect(result).toEqual({ exitCode: 0, output: "continue\n" });
  });

  test("目标缺失安装器时拒绝继续", async (): Promise<void> => {
    const fixture: InstallerFixture = await createFixture();
    await Bun.file(join(fixture.worktree, "install.sh")).unlink();
    const result: InstallerRunResult = runFragment(fixture, [
      'die() { printf "%s\\n" "$1" >&2; exit 1; }',
      handoff,
      'printf "unexpected\\n"',
    ].join("\n"), { SCRIPT_DIRECTORY: "" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("目标工作树缺少 install.sh");
    expect(result.output).not.toContain("unexpected");
  });
});
