import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFixtureTree } from "../fixtures/copyTree";

const PROJECT_ROOT: string = join(import.meta.dir, "..", "..");
const INSTALL_SCRIPT_PATH: string = join(PROJECT_ROOT, "install.sh");
const CONFIG_EXAMPLE_ROOT: string = join(PROJECT_ROOT, "config_example");
const REAL_BUN_PATH: string = Bun.argv[0]!;

export interface InstallerFixture {
  readonly realRuntime: boolean;
  readonly root: string;
  readonly worktree: string;
  readonly configRoot: string;
  readonly backupRoot: string;
  readonly runtimeRoot: string;
  readonly binRoot: string;
  readonly callLog: string;
  readonly outboundLog: string;
}

export interface PromptReply {
  readonly prompt: string;
  readonly reply?: string;
  readonly close?: boolean;
  readonly optional?: boolean;
  readonly secret?: boolean;
}

export interface InstallerRunResult {
  readonly exitCode: number;
  readonly output: string;
}

const fixtureRoots: string[] = [];

export async function writeText(path: string, content: string, mode?: number): Promise<void> {
  await Bun.write(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

export async function readText(path: string): Promise<string> {
  return Bun.file(path).text();
}

async function executable(path: string, lines: readonly string[]): Promise<void> {
  await writeText(path, lines.join("\n") + "\n", 0o700);
}

async function installBunGuard(fixture: InstallerFixture): Promise<void> {
  await executable(join(fixture.binRoot, "bun"), [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "command_name=\"${1:-}\"",
    "inline_source=\"${2:-}\"",
    "secret_env_state() {",
    "  local label=\"$1\"",
    "  if env | grep -Eq '^CN_.*_API_KEY='; then",
    "    printf '%s-secret-env=present\\n' \"$label\" >> \"$FAKE_CALL_LOG\"",
    "  else",
    "    printf '%s-secret-env=absent\\n' \"$label\" >> \"$FAKE_CALL_LOG\"",
    "  fi",
    "}",
    "case \"$command_name\" in",
    "  --version)",
    "    printf '%s\\n' \"${FAKE_BUN_VERSION-1.4.2}\"",
    "    exit 0",
    "    ;;",
    "  install)",
    "    printf 'bun:install\\n' >> \"$FAKE_CALL_LOG\"",
    "    exit 0",
    "    ;;",
    "  run)",
    "    if [ \"${2:-}\" = \"start\" ]; then",
    "      secret_env_state start",
    "      if [ \"$FAKE_REAL_RUNTIME\" = \"1\" ]; then",
    "        printf '%s\\n' 'preload = [\"./test/helpers/installedApplication.ts\"]' > bunfig.toml",
    "        runtime_status=0",
    "        \"$REAL_BUN_PATH\" run --no-orphans start || runtime_status=$?",
    "        rm -- bunfig.toml",
    "        exit \"$runtime_status\"",
    "      fi",
    "      exit 0",
    "    fi",
    "    ;;",
    "esac",
    "if [ \"$command_name\" != \"-e\" ]; then",
    "  printf 'bun:unexpected:%s\\n' \"$*\" >> \"$FAKE_CALL_LOG\"",
    "  exit 91",
    "fi",
    "if [ \"$FAKE_REAL_RUNTIME\" = \"1\" ]; then exec \"$REAL_BUN_PATH\" \"$@\"; fi",
    "if [[ \"$inline_source\" == *\"manifest?.packageManager\"* ]]; then",
    "  printf 'manifest:check\\n' >> \"$FAKE_CALL_LOG\"",
    "  exec \"$REAL_BUN_PATH\" \"$@\"",
    "fi",
    "if [[ \"$inline_source\" == *\"RestartUSec must\"* ]]; then exec \"$REAL_BUN_PATH\" \"$@\"; fi",
    "if [[ \"$inline_source\" == *\"invalid agent config field stream\"* ]]; then",
    "  secret_env_state generator",
    "  exec \"$REAL_BUN_PATH\" \"$@\"",
    "fi",
    "if [[ \"$inline_source\" == *\"loadTelegramConfig\"* ]]; then",
    "  printf 'validate:telegram\\n' >> \"$FAKE_CALL_LOG\"",
    "  [ \"${FAKE_TELEGRAM_VALIDATION_FAIL:-0}\" = \"1\" ] && exit 41",
    "  exec \"$REAL_BUN_PATH\" -e 'JSON.parse(await Bun.file(Bun.argv[1]).text())' \"${3:?}\"",
    "fi",
    "if [[ \"$inline_source\" == *\"validateAgentDeploymentConfig\"* ]]; then",
    "  printf 'validate:agent\\n' >> \"$FAKE_CALL_LOG\"",
    "  exec \"$REAL_BUN_PATH\" -e 'JSON.parse(await Bun.file(Bun.argv[1]).text())' \"${3:?}\"",
    "fi",
    "if [[ \"$inline_source\" == *\"createStorageDatabase\"* ]]; then",
    "  mkdir -p -- \"$(dirname -- \"$FAKE_IDENTITY_DATABASE\")\"",
    "  : > \"$FAKE_IDENTITY_DATABASE\"",
    "  printf 'database:create\\n' >> \"$FAKE_CALL_LOG\"",
    "  exit 0",
    "fi",
    "if [[ \"$inline_source\" == *\"IDENTITY_DATABASE_PATH\"* ]]; then",
    "  printf '%s' \"$FAKE_IDENTITY_DATABASE\"",
    "  exit 0",
    "fi",
    "if [[ \"$inline_source\" == *\"RUNTIME_DATA_ROOT\"* ]]; then",
    "  printf '%s' \"$FAKE_RUNTIME_ROOT\"",
    "  exit 0",
    "fi",
    "if [[ \"$inline_source\" == *\"validateExistingDeploymentInputs\"* ]]; then",
    "  secret_env_state validation",
    "  [ \"${FAKE_DEPLOYMENT_VALIDATION_FAIL:-0}\" = \"1\" ] && exit 42",
    "  exit 0",
    "fi",
    "printf 'bun:unexpected-inline\\n' >> \"$FAKE_CALL_LOG\"",
    "exit 92",
  ]);
}

async function installGitGuard(fixture: InstallerFixture): Promise<void> {
  await executable(join(fixture.binRoot, "git"), [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "if [ \"${1:-}\" = \"describe\" ]; then printf 'test-fixture\\n'; exit 0; fi",
    "if [ \"${1:-}\" = \"-C\" ] && [ \"${3:-}\" = \"rev-parse\" ]; then",
    "  printf '%s\\n' \"$FAKE_WORKTREE\"",
    "  exit 0",
    "fi",
    "printf 'git:blocked:%s\\n' \"$*\" >> \"$FAKE_OUTBOUND_LOG\"",
    "exit 93",
  ]);
}

async function installSystemGuards(fixture: InstallerFixture): Promise<void> {
  const blockedCommands: readonly string[] = [
    "curl", "apt-get", "dnf", "yum", "zypper", "pacman", "apk",
  ];
  for (const command of blockedCommands) {
    await executable(join(fixture.binRoot, command), [
      "#!/usr/bin/env bash",
      "printf '" + command + ":blocked\\n' >> \"$FAKE_OUTBOUND_LOG\"",
      "exit 94",
    ]);
  }
  await executable(join(fixture.binRoot, "sudo"), [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "case \"${1:-}\" in",
    "  systemctl|journalctl|tee)",
    "    guarded_command=\"$1\"",
    "    shift",
    "    exec \"$FAKE_BIN_ROOT/$guarded_command\" \"$@\"",
    "    ;;",
    "  chown)",
    "    target_path=\"${@: -1}\"",
    "    case \"$target_path\" in",
    "      \"$FAKE_WORKTREE\"/config/.telegram.json.install.*)",
    "        shift",
    "        exec /bin/chown \"$@\"",
    "        ;;",
    "    esac",
    "    ;;",
    "esac",
    "printf 'sudo:blocked:%s\\n' \"$*\" >> \"$FAKE_OUTBOUND_LOG\"",
    "exit 94",
  ]);
  await executable(join(fixture.binRoot, "id"), [
    "#!/usr/bin/env bash",
    "case \"${1:-}\" in",
    "  -u) printf '1000\\n' ;;",
    "  -un) printf 'fixture-user\\n' ;;",
    "  *) exit 95 ;;",
    "esac",
  ]);
  await executable(join(fixture.binRoot, "chmod"), [
    "#!/usr/bin/env bash",
    "if [ \"${FAKE_STAGING_CHMOD_FAIL:-0}\" = \"1\" ]; then",
    "  for argument in \"$@\"; do",
    "    case \"$argument\" in *.install.*) exit 44 ;; esac",
    "  done",
    "fi",
    "exec /bin/chmod \"$@\"",
  ]);
  await executable(join(fixture.binRoot, "cp"), [
    "#!/usr/bin/env bash",
    "if [ \"${FAKE_BACKUP_PRESERVE_FAIL:-0}\" = \"1\" ] && [ \"${1:-}\" = \"-p\" ]; then",
    "  printf 'cp-preserve=failure\\n' >> \"$FAKE_CALL_LOG\"",
    "  exit 45",
    "fi",
    "exec /bin/cp \"$@\"",
  ]);
  await executable(join(fixture.binRoot, "systemctl"), [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "printf 'systemctl:guarded:%s\\n' \"$*\" >> \"$FAKE_OUTBOUND_LOG\"",
    "[ \"${FAKE_SYSTEMCTL_FAIL:-0}\" = 1 ] && exit 46",
    "case \"${1:-}\" in start|restart) : > \"$FAKE_RUNTIME_ROOT/service-started\" ;; esac",
    "[ \"${1:-}\" != daemon-reload ] || : > \"$FAKE_BIN_ROOT/service-loaded\"",
    "if [ \"$FAKE_REAL_RUNTIME\" = \"1\" ]; then",
    "  case \"${1:-}\" in start|restart) exec \"$FAKE_BIN_ROOT/bun\" run start ;; esac",
    "fi",
    "if env | grep -Eq '^CN_.*_API_KEY='; then",
    "  printf 'systemctl-secret-env=present\\n' >> \"$FAKE_CALL_LOG\"",
    "else",
    "  printf 'systemctl-secret-env=absent\\n' >> \"$FAKE_CALL_LOG\"",
    "fi",
    "if [ \"${1:-}\" = \"show\" ]; then",
    "  case \"$*\" in",
    "    *LoadState*) if [ -e \"$FAKE_BIN_ROOT/service-loaded\" ]; then printf 'loaded\\n'; else printf '%s\\n' \"${FAKE_SERVICE_LOAD_STATE-loaded}\"; fi ;;",
    "    *ActiveState*) if [ -e \"$FAKE_RUNTIME_ROOT/service-started\" ]; then printf '%s\\n' \"${FAKE_STARTED_STATE-active}\"; else printf '%s\\n' \"${FAKE_SERVICE_STATE-inactive}\"; fi ;;",
    "    *SubState*) if [ -e \"$FAKE_RUNTIME_ROOT/service-started\" ]; then printf 'running\\n'; else printf 'dead\\n'; fi ;;",
    "    *NRestarts*)",
    "      if [ -e \"$FAKE_RUNTIME_ROOT/service-started\" ]; then printf '%s\\n' \"${FAKE_RESTARTS_AFTER-0}\";",
    "      elif [ \"${FAKE_SERVICE_LOAD_STATE-loaded}\" = not-found ] && [ ! -e \"$FAKE_BIN_ROOT/service-loaded\" ]; then printf '\\n';",
    "      else printf '%s\\n' \"${FAKE_RESTARTS_BEFORE-0}\"; fi ;;",
    "    *WorkingDirectory*) printf '%s\\n' \"${FAKE_SERVICE_WORKDIR-$FAKE_WORKTREE}\" ;;",
    "    *ExecStart*) printf '%s\\n' \"${FAKE_SERVICE_ENTRY-{ path=/guarded/bun ; argv[]=/guarded/bun start ; ignore_errors=no ; }}\" ;;",
    "    *RestartUSec*) printf '%s\\n' \"${FAKE_RESTART_INTERVAL-5s}\" ;;",
    "    *RestartSteps*) printf '%s\\n' \"${FAKE_RESTART_STEPS-0}\" ;;",
    "    *RestartMaxDelayUSec*) printf '%s\\n' \"${FAKE_RESTART_MAX-infinity}\" ;;",
    "    *RestartRandomizedDelayUSec*) printf '%s\\n' \"${FAKE_RESTART_RANDOMIZED-}\" ;;",
    "  esac",
    "fi",
    "exit 0",
  ]);
  await executable(join(fixture.binRoot, "journalctl"), [
    "#!/usr/bin/env bash",
    "[ \"${FAKE_JOURNAL_FAIL:-0}\" = \"1\" ] && exit 43",
    "printf 'journalctl:guarded\\n' >> \"$FAKE_OUTBOUND_LOG\"",
    "case \"$*\" in *--show-cursor*) printf -- '-- cursor: fixture-cursor\\n' ;; esac",
    "printf '%s\\n' \"${FAKE_JOURNAL_BODY-}\"",
  ]);
  await executable(join(fixture.binRoot, "tee"), [
    "#!/usr/bin/env bash",
    "printf 'tee:guarded\\n' >> \"$FAKE_OUTBOUND_LOG\"",
    "while IFS= read -r _; do :; done",
  ]);
  await executable(join(fixture.binRoot, "sleep"), [
    "#!/usr/bin/env bash",
    "printf 'sleep:guarded:%s\\n' \"$*\" >> \"$FAKE_OUTBOUND_LOG\"",
  ]);
}

function validateGuardScripts(fixture: InstallerFixture): void {
  const decoder: TextDecoder = new TextDecoder();
  for (const name of readdirSync(fixture.binRoot)) {
    const path: string = join(fixture.binRoot, name);
    const result: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync({
      cmd: ["/bin/bash", "-n", path],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`invalid guard ${name}: ${decoder.decode(result.stderr)}`);
    }
  }
}

export async function createFixture(realRuntime: boolean = false): Promise<InstallerFixture> {
  const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-install-test-"));
  fixtureRoots.push(root);
  const fixture: InstallerFixture = {
    realRuntime,
    root,
    worktree: join(root, "repository"),
    configRoot: join(root, "repository", "config"),
    backupRoot: join(root, "backups"),
    runtimeRoot: join(root, "runtime"),
    binRoot: join(root, "bin"),
    callLog: join(root, "calls.log"),
    outboundLog: join(root, "outbound.log"),
  };
  mkdirSync(fixture.worktree, { recursive: true });
  mkdirSync(fixture.backupRoot, { mode: 0o700 });
  mkdirSync(fixture.runtimeRoot, { mode: 0o700 });
  mkdirSync(fixture.binRoot, { mode: 0o700 });
  mkdirSync(join(root, "home"), { mode: 0o700 });
  // 只在夹具副本替换系统路径，所有宿主都执行同一条 systemd 分支。
  const systemdRoot: string = join(root, "systemd");
  mkdirSync(systemdRoot);
  await writeText(join(systemdRoot, "copy-ninjia.service"), "[Service]\n");
  const installer: string = (await readText(INSTALL_SCRIPT_PATH))
    .replaceAll("/run/systemd/system", systemdRoot)
    .replace("/etc/systemd/system/${SERVICE_NAME}.service", `${systemdRoot}/\u0024{SERVICE_NAME}.service`);
  await writeText(join(fixture.worktree, "install.sh"), installer);
  await copyFixtureTree(CONFIG_EXAMPLE_ROOT, join(fixture.worktree, "config_example"));
  await Bun.write(join(fixture.worktree, "package.json"), Bun.file(join(PROJECT_ROOT, "package.json")));
  await writeText(join(fixture.worktree, "index.ts"), "");
  if (realRuntime) {
    for (const relativePath of ["packages", "prompt", "index.ts", "tsconfig.json", "bun.lock"]) {
      await copyFixtureTree(join(PROJECT_ROOT, relativePath), join(fixture.worktree, relativePath));
    }
    symlinkSync(join(PROJECT_ROOT, "node_modules"), join(fixture.worktree, "node_modules"));
    const preload: string = "test/helpers/installedApplication.ts";
    await copyFixtureTree(join(PROJECT_ROOT, preload), join(fixture.worktree, preload));
  }
  await writeText(fixture.callLog, "");
  await writeText(fixture.outboundLog, "");
  await installBunGuard(fixture);
  await installGitGuard(fixture);
  await installSystemGuards(fixture);
  validateGuardScripts(fixture);
  return fixture;
}

function installerEnvironment(
  fixture: InstallerFixture,
  extra: Readonly<Record<string, string>> = {}
): Readonly<Record<string, string>> {
  return {
    PATH: [fixture.binRoot, "/usr/bin", "/bin"].join(":"),
    HOME: join(fixture.root, "home"),
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
    TMPDIR: fixture.backupRoot,
    COPY_NINJIA_DATA_ROOT: fixture.runtimeRoot,
    REAL_BUN_PATH,
    FAKE_WORKTREE: fixture.worktree,
    FAKE_RUNTIME_ROOT: fixture.runtimeRoot,
    FAKE_BIN_ROOT: fixture.binRoot,
    FAKE_IDENTITY_DATABASE: join(fixture.runtimeRoot, "database", "storage.sqlite"),
    FAKE_CALL_LOG: fixture.callLog,
    FAKE_REAL_RUNTIME: fixture.realRuntime ? "1" : "0",
    FAKE_OUTBOUND_LOG: fixture.outboundLog,
    ...extra,
  };
}

export function runInstaller(
  fixture: InstallerFixture,
  prompts: readonly PromptReply[],
  extraEnvironment: Readonly<Record<string, string>> = {}
): InstallerRunResult {
  const decoder: TextDecoder = new TextDecoder();
  const inputLines: string[] = [];
  for (const prompt of prompts) {
    if (prompt.close === true) break;
    inputLines.push(prompt.reply ?? "");
  }
  const result: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync({
    cmd: ["script", "-qefc", "umask 022; bash ./install.sh", "/dev/null"],
    cwd: fixture.worktree,
    env: installerEnvironment(fixture, extraEnvironment),
    stdin: new TextEncoder().encode(inputLines.join("\n") + "\n"),
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  const rawOutput: string = decoder.decode(result.stdout) + decoder.decode(result.stderr);
  // 真实应用夹具已自行完成 SIGTERM 排空，下次安装从已停止状态开始。
  if (fixture.realRuntime) rmSync(join(fixture.runtimeRoot, "service-started"), { force: true });
  let output: string = rawOutput;
  for (const prompt of prompts) {
    if (prompt.secret === true && prompt.reply !== undefined) {
      output = output.replaceAll(prompt.reply, "[secret]");
    }
  }
  for (const prompt of prompts) {
    if (prompt.optional === true || output.includes(prompt.prompt)) continue;
    let safeOutput: string = output;
    for (const secret of prompts) {
      if (secret.reply !== undefined && secret.reply.length > 0) {
        safeOutput = safeOutput.replaceAll(secret.reply, "[input]");
      }
    }
    throw new Error(`installer exited before prompt ${prompt.prompt}:\n${safeOutput}`);
  }
  return { exitCode: result.exitCode, output };
}

export function validTelegram(token: string = "123456789:existing_test_token"): string {
  return JSON.stringify({
    bot_token: token,
    super_admin_user_id: 123456789,
  }, null, 2) + "\n";
}

export function systemdPrompt(): PromptReply {
  return { prompt: "覆盖它？", reply: "n", optional: true };
}

export function cleanupFixtures(): void {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}
