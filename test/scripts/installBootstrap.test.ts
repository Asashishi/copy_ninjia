import { afterEach, expect, test } from "bun:test";
import { rmSync, mkdirSync, statSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { createFixture, writeText, cleanupFixtures } from "../../scripts/installIsolation/fixture";
import type { InstallerFixture } from "../../scripts/installIsolation/fixture";

afterEach(cleanupFixtures);

test("空环境 bootstrap 安装并启动真实应用，系统操作与网络由 mock 接管", async (): Promise<void> => {
  const fixture: InstallerFixture = await createFixture(true);
  const seed: string = join(fixture.root, "seed");
  const bootstrap: string = join(fixture.root, "bootstrap");
  mkdirSync(bootstrap);
  await Bun.write(join(bootstrap, "install.sh"), Bun.file(join(fixture.worktree, "install.sh")));
  await rename(fixture.worktree, seed);
  rmSync(join(fixture.root, "systemd/copy-ninjia.service"));
  await rename(join(fixture.binRoot, "bun"), join(fixture.binRoot, "bun-template"));
  const bunTemplate: string = await Bun.file(join(fixture.binRoot, "bun-template")).text();
  await writeText(join(fixture.binRoot, "bun-template"), bunTemplate.replace("  install)\n", '  install)\n    [ "$*" = "install --frozen-lockfile" ] || exit 99\n'), 0o700);
  const bashEnvironment: string = join(fixture.root, "bash-env");
  // 宿主即使安装了 Bun/unzip，也由夹具控制依赖何时可见。
  await writeText(bashEnvironment, [
    "command() {",
    "  if [ \"${1:-}\" = -v ]; then",
    "    case \"${2:-}\" in bun|unzip) [ -e \"$FAKE_BIN_ROOT/$2\" ] || return 1 ;; esac",
    "  fi",
    "  builtin command \"$@\"",
    "}",
  ].join("\n") + "\n");
  const sudoSource: string = await Bun.file(join(fixture.binRoot, "sudo")).text();
  await writeText(join(fixture.binRoot, "sudo"), sudoSource.replace("systemctl|journalctl|tee)", "systemctl|journalctl|tee|apt-get)"), 0o700);
  await writeText(join(fixture.binRoot, "apt-get"), [
    "#!/usr/bin/env bash", "set -Eeuo pipefail",
    'printf "mock:apt-get:%s\\n" "$*" >> "$FAKE_CALL_LOG"',
    'case "$*" in',
    '"update -y") exit 0;;',
    '"install -y unzip") printf \'#!/usr/bin/env bash\\nexit 97\\n\' > "$FAKE_BIN_ROOT/unzip"; /bin/chmod 700 "$FAKE_BIN_ROOT/unzip"; exit 0;;',
    "*) exit 94;;",
    "esac",
  ].join("\n") + "\n", 0o700);
  await writeText(join(fixture.binRoot, "git"), [
    "#!/usr/bin/env bash", "set -Eeuo pipefail",
    'if [ "${1:-}" = "describe" ]; then printf "99.0.0\\n"; exit 0; fi',
    'if [ "${1:-}" = "-C" ] && [ "${3:-}" = "rev-parse" ]; then printf "%s\\n" "$FAKE_WORKTREE"; exit 0; fi',
    'if [ "$*" = "-c advice.detachedHead=false clone --branch 99.0.0 -- https://github.com/Asashishi/copy_ninjia.git $FAKE_WORKTREE" ]; then',
    '  printf "mock:clone\\n" >> "$FAKE_CALL_LOG"',
    '  exec /bin/mv -- "$FAKE_SEED" "$FAKE_WORKTREE"',
    "fi", 'printf "git:blocked\\n" >> "$FAKE_OUTBOUND_LOG"; exit 93',
  ].join("\n") + "\n", 0o700);
  await writeText(join(fixture.binRoot, "curl"), [
    "#!/usr/bin/env bash", "set -Eeuo pipefail",
    'case "${@: -1}" in',
    "https://api.github.com/repos/Asashishi/copy_ninjia/releases/latest)",
    '  printf "mock:latest\\n" >> "$FAKE_CALL_LOG"',
    '  printf \'{"tag_name":"99.0.0"}\\n\';;',
    "https://bun.sh/install)",
    '  printf "mock:bun-install\\n" >> "$FAKE_CALL_LOG"',
    "  cat <<'MOCK_INSTALL'",
    "set -Eeuo pipefail",
    '[ "$1" = "bun-v1.4.2" ] || exit 98',
    'mkdir -p -- "$HOME/.bun/bin"',
    'cp -- "$FAKE_BIN_ROOT/bun-template" "$HOME/.bun/bin/bun"',
    'cp -- "$FAKE_BIN_ROOT/bun-template" "$FAKE_BIN_ROOT/bun"',
    "MOCK_INSTALL",
    "  ;;",
    '*) printf "curl:blocked\\n" >> "$FAKE_OUTBOUND_LOG"; exit 94;;',
    "esac",
  ].join("\n") + "\n", 0o700);
  await writeText(join(fixture.binRoot, "tee"), [
    "#!/usr/bin/env bash", "set -Eeuo pipefail",
    '[ "$#" = 1 ] && [ "$1" = "${FAKE_WORKTREE%/*}/systemd/copy-ninjia.service" ] || exit 94',
    'cat > "$FAKE_RUNTIME_ROOT/unit-preview"',
  ].join("\n") + "\n", 0o700);
  const child: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync(["script", "-qefc", "umask 022; bash ./install.sh --source", "/dev/null"], {
    cwd: bootstrap,
    env: {
      PATH: `${fixture.binRoot}:/usr/bin:/bin`, HOME: join(fixture.root, "home"), LANG: "C.UTF-8", TERM: "xterm-256color",
      TMPDIR: fixture.backupRoot, COPY_NINJIA_DATA_ROOT: fixture.runtimeRoot, COPY_NINJIA_DIR: fixture.worktree,
      REAL_BUN_PATH: Bun.argv[0]!, FAKE_WORKTREE: fixture.worktree, FAKE_RUNTIME_ROOT: fixture.runtimeRoot,
      FAKE_BIN_ROOT: fixture.binRoot, FAKE_IDENTITY_DATABASE: join(fixture.runtimeRoot, "database/storage.sqlite"),
      FAKE_CALL_LOG: fixture.callLog, FAKE_REAL_RUNTIME: "1", FAKE_OUTBOUND_LOG: fixture.outboundLog,
      FAKE_PATHS_MODULE: join(import.meta.dir, "../../packages/consts/paths.ts"),
      FAKE_INSTALL_RUNTIME_MODULE: join(import.meta.dir, "../../scripts/install/runtime.ts"),
      FAKE_SERVICE_LOAD_STATE: "not-found", FAKE_SEED: seed,
      BASH_ENV: bashEnvironment,
    },
    stdin: new TextEncoder().encode("123456789:audit_mock_token\n123456789\nn\n"), stdout: "pipe", stderr: "pipe", timeout: 30_000,
  });
  const output: string = (new TextDecoder().decode(child.stdout) + new TextDecoder().decode(child.stderr)).replaceAll("123456789:audit_mock_token", "[mock-token]");
  expect(output).not.toContain("Unhandled error");
  expect(output).not.toContain("Shutdown drain/flush results:");
  const calls: string = await Bun.file(fixture.callLog).text();
  const outbound: string = await Bun.file(fixture.outboundLog).text();
  const checks: Readonly<Record<string, boolean | number | string | null | undefined>> = {
    exit: child.exitCode, fetchedLatest: calls.includes("mock:latest"), cloned: calls.includes("mock:clone"),
    installedBun: calls.includes("mock:bun-install"), dependencies: calls.includes("bun:install"),
    applicationStarted: output.includes("Bot started as @installation_test_bot"), polled: output.includes("INSTALL_API getUpdates"),
    workerGuards: output.match(/^INSTALL_WORKER_NETWORK_GUARD\r?$/gm)?.length,
    gracefullyStopped: output.includes("Received SIGTERM; beginning graceful shutdown."),
    database: await Bun.file(join(fixture.runtimeRoot, "database/storage.sqlite")).exists(),
    state: await Bun.file(join(fixture.runtimeRoot, "state.json")).exists(), lockReleased: !await Bun.file(join(fixture.runtimeRoot, "bot.lock")).exists(),
    noUnexpectedOutbound: !outbound.includes(":blocked") && !output.includes("INSTALL_NETWORK_BLOCKED"),
    observed12Seconds: outbound.includes("sleep:guarded:12"), unitGenerated: await Bun.file(join(fixture.runtimeRoot, "unit-preview")).exists(),
    databaseMode: await Bun.file(join(fixture.runtimeRoot, "database/storage.sqlite")).exists() ? (statSync(join(fixture.runtimeRoot, "database/storage.sqlite")).mode & 0o777).toString(8) : null,
    installedUnzip: calls.includes("mock:apt-get:install -y unzip"),
  };
  expect(checks.exit, output).toBe(0);
  expect(checks.workerGuards, output).toBe(2);
  expect(checks.databaseMode).toBe("660");
  for (const [name, value] of Object.entries(checks)) expect(value, name).not.toBe(false);
  const unit: string = await Bun.file(join(fixture.runtimeRoot, "unit-preview")).text();
  expect(unit).toContain(fixture.worktree);
  expect(unit).toContain(fixture.runtimeRoot);
}, 30_000);
