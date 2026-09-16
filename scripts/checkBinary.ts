/** 在独立临时部署中核对编译产物的安装校验、sharp、三个 Worker 与正常排空。 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { copyFixtureTree } from "./fixtures/copyTree";
import { cleanupFixtures, createFixture, readText, runInstaller, writeText } from "./installIsolation/fixture";
import type { InstallerFixture, InstallerRunResult } from "./installIsolation/fixture";
import { readInstallScripts } from "./installSources";
import type { InstallScriptSource } from "./installSources";

const source: string = resolve(Bun.argv[2] ?? "dist/copy-ninjia-linux-x64");
const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-binary-check-"));
const executable: string = join(root, "copy-ninjia");
const environment: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  HOME: root,
  COPY_NINJIA_DATA_ROOT: root,
  COPY_NINJIA_CONFIG_ROOT: join(root, "config"),
};

/** 所有子进程仅使用测试数据根，环境不继承部署配置。 */
function run(arguments_: string[], extra: Readonly<Record<string, string>> = {}): string {
  const result: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync({
    cmd: [executable, ...arguments_], cwd: root, env: { ...environment, ...extra },
    stdout: "pipe", stderr: "pipe", timeout: 30_000, killSignal: "SIGKILL",
  });
  const output: string = new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr);
  if (result.exitCode !== 0) throw new Error(`Binary check failed (${result.exitCode}):\n${output}`);
  return output;
}

try {
  for await (const file of new Bun.Glob("**/*.map").scan({ cwd: source, dot: true })) {
    throw new Error(`Binary package must not contain source maps: ${file}`);
  }
  await copyFixtureTree(source, root);
  chmodSync(executable, 0o700);
  const manifest: { readonly version: string } = await Bun.file(join(root, "package.json")).json() as { readonly version: string };
  if (run(["--version"]).trim() !== manifest.version) throw new Error("Binary version must match package.json version.");
  await copyFixtureTree(join(root, "config_example"), join(root, "config"));
  await Bun.write(join(root, "config/telegram.json"), JSON.stringify({ bot_token: "123456789:binary_test_token", super_admin_user_id: 123456789 }));
  await Bun.write(join(root, "config/agent.json"), JSON.stringify({ agent: {
    text: { provider: "openai", api_key: "binary-test-key", model: "test" },
    summary: { provider: "openai", api_key: "binary-test-key", model: "test" },
    media: { provider: "openai", api_key: "binary-test-key", model: "test" },
  } }));
  mkdirSync(join(root, "database"), { mode: 0o770 });
  run(["-e", `
    import { createStorageDatabase, openStorageDatabase, initializeStorageDatabase,
      closeStorageDatabase, enableStorageDatabaseWal, IDENTITY_DATABASE_PATH,
      validateExistingDeploymentInputs } from "./scripts/install/runtime.js";
    createStorageDatabase(IDENTITY_DATABASE_PATH);
    const db = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
    try { initializeStorageDatabase(db); } finally { closeStorageDatabase(db); }
    enableStorageDatabaseWal(IDENTITY_DATABASE_PATH);
    await validateExistingDeploymentInputs();
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer();
    const metadata = await sharp(png).metadata();
    if (metadata.width !== 2 || metadata.height !== 2) throw new Error("sharp roundtrip failed");
  `], { BUN_BE_BUN: "1" });
  const output: string = run([], {
    BUN_OPTIONS: `--preload ${join(import.meta.dir, "../test/fixtures/binaryNetwork.ts")}`,
  });
  for (const marker of ["diskIOWorker.ts", "aiChatWorker.ts", "antiRaidWorker.ts", "BINARY_API getUpdates", "BINARY_WEATHER"]) {
    if (!output.includes(marker)) throw new Error(`Binary check missing ${marker}:\n${output}`);
  }
  if (output.includes("BINARY_NETWORK_BLOCKED") || existsSync(join(root, "bot.lock")) || !existsSync(join(root, "state.json"))) {
    throw new Error(`Binary check did not complete cleanly:\n${output}`);
  }
  const originalFixture: InstallerFixture = await createFixture();
  const worktree: string = join(originalFixture.root, "binary deployment");
  renameSync(originalFixture.worktree, worktree);
  const fixture: InstallerFixture = { ...originalFixture, worktree, configRoot: join(worktree, "config") };
  const guardedScripts: readonly InstallScriptSource[] = await readInstallScripts(fixture.worktree);
  await copyFixtureTree(source, fixture.worktree);
  chmodSync(join(fixture.worktree, "copy-ninjia"), 0o700);
  await Bun.file(join(fixture.worktree, "index.ts")).delete();
  for (const script of guardedScripts) await writeText(join(fixture.worktree, script.path), script.source);
  // 仅捕获夹具的 unit 内容；替身不写系统路径，也不启动真实服务。
  await writeText(join(fixture.binRoot, "tee"), [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    '[ "$#" -eq 1 ] && [ "$1" = "${FAKE_WORKTREE%/*}/systemd/copy-ninjia.service" ] || exit 94',
    'cat > "$FAKE_RUNTIME_ROOT/unit-preview"',
    "",
  ].join("\n"), 0o700);
  const installed: InstallerRunResult = runInstaller(fixture, [
    { prompt: "Telegram bot token", reply: "123456789:binary_test_token", secret: true },
    { prompt: "超级管理员用户 ID", reply: "123456789" },
    { prompt: "现在配置 AI 能力", reply: "n" },
    { prompt: "覆盖它？", reply: "y" },
  ]);
  if (installed.exitCode !== 0 || (await readText(fixture.callLog)).includes("bun:")) {
    throw new Error(`Binary installer failed or invoked system Bun:\n${installed.output}`);
  }
  if (!existsSync(join(fixture.runtimeRoot, "database/storage.sqlite"))) throw new Error("Binary installer did not initialize storage.");
  const unit: string = await readText(join(fixture.runtimeRoot, "unit-preview"));
  if (!unit.split("\n").includes(`ExecStart=":${join(worktree, "copy-ninjia")}"`)) {
    throw new Error("Binary installer must quote the executable path as one systemd argument.");
  }
  console.log("Binary check passed: installer without system Bun, sharp, three Workers and SIGTERM drain.");
} finally {
  cleanupFixtures();
  rmSync(root, { recursive: true, force: true });
}
