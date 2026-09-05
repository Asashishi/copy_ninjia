import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_AI_CHAT_REQUIRED_CAPABILITIES,
  AGENT_CAPABILITY_NAMES,
} from "../../packages/consts/agent";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../../packages/consts/telegram";

const INSTALL_SCRIPT_PATH: string = join(import.meta.dir, "..", "..", "install.sh");
const INSTALL_SCRIPT: string = readFileSync(INSTALL_SCRIPT_PATH, "utf8");

/** 从 install.sh 原文取一个 `readonly NAME=(a b c)` 数组的元素。 */
function extractShellArray(name: string): readonly string[] {
  const match: RegExpMatchArray | null = INSTALL_SCRIPT.match(
    new RegExp(`^readonly ${name}=\\(([^)]*)\\)$`, "m")
  );
  expect(match).not.toBeNull();
  return (match?.[1] ?? "").trim().split(/\s+/);
}

/** 从 install.sh 原文取一个 `readonly NAME=值` 标量。 */
function extractShellScalar(name: string): string {
  const match: RegExpMatchArray | null = INSTALL_SCRIPT.match(
    new RegExp(`^readonly ${name}=(\\S+)$`, "m")
  );
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("install.sh 静态 systemd 数据根边界", () => {
  test("脚本通过 bash 语法检查", () => {
    const result: Bun.SyncSubprocess<"ignore", "pipe"> = Bun.spawnSync({
      cmd: ["bash", "-n", INSTALL_SCRIPT_PATH],
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    expect(INSTALL_SCRIPT).toContain(
      '"./packages/database/interact/initialization";'
    );
    expect(INSTALL_SCRIPT).not.toContain("database/interact/admin");
  });

  test("显式数据根使用生产解析结果而非重新拼路径", () => {
    expect(INSTALL_SCRIPT).toContain(
      'if [ "${COPY_NINJIA_DATA_ROOT+x}" = "x" ]; then'
    );
    expect(INSTALL_SCRIPT).toContain(
      'import { RUNTIME_DATA_ROOT } from "./packages/consts/paths";'
    );
    expect(INSTALL_SCRIPT).toContain(
      "await Bun.write(Bun.stdout, RUNTIME_DATA_ROOT);"
    );
    expect(INSTALL_SCRIPT).toContain(
      "systemd_environment_assignment COPY_NINJIA_DATA_ROOT " +
      '"$RESOLVED_RUNTIME_DATA_ROOT"'
    );
  });

  test("unit 模板在 ExecStart 前传入同一个数据根环境项", () => {
    const environmentIndex: number = INSTALL_SCRIPT.indexOf(
      '"${SYSTEMD_DATA_ROOT_ENVIRONMENT}" \\\n'
    );
    const execStartIndex: number = INSTALL_SCRIPT.indexOf(
      '"ExecStart=${BUN_BINARY} start"'
    );
    expect(environmentIndex).toBeGreaterThan(-1);
    expect(execStartIndex).toBeGreaterThan(environmentIndex);
  });

  test("Environment 值静态转义反斜线、双引号、specifier 与控制字符", () => {
    expect(INSTALL_SCRIPT).toContain('[[ "$value" =~ [[:cntrl:]] ]]');
    expect(INSTALL_SCRIPT).toContain('escaped_value="${value//\\\\/\\\\\\\\}"');
    expect(INSTALL_SCRIPT).toContain('escaped_value="${escaped_value//\\"/\\\\\\"}"');
    expect(INSTALL_SCRIPT).toContain('escaped_value="${escaped_value//%/%%}"');
    expect(INSTALL_SCRIPT).toContain(
      "printf 'Environment=\"%s=%s\"' \"$variable_name\" \"$escaped_value\""
    );
  });

  test("缺省数据根不被伪装成显式配置", () => {
    expect(INSTALL_SCRIPT).toContain('SYSTEMD_DATA_ROOT_ENVIRONMENT=""');
    expect(INSTALL_SCRIPT).not.toContain(
      'Environment="COPY_NINJIA_DATA_ROOT=${SERVICE_WORKDIR}"'
    );
  });
});

/**
 * 从 install.sh 原文里抠出指定的 shell 函数定义。
 *
 * 断言跑的是**真正发出去的那份脚本**，函数改了这里就跟着变；install.sh 本身是
 * `curl | bash` 的一次性入口，不能 source（顶层会真的开始装），所以只取函数体。
 */
function extractShellFunctions(names: readonly string[]): string {
  const lines: readonly string[] = INSTALL_SCRIPT.split("\n");
  const chunks: string[] = [];
  for (const name of names) {
    const start: number = lines.findIndex((line: string): boolean => line === `${name}() {`);
    expect(start).toBeGreaterThan(-1);
    const end: number = lines.indexOf("}", start);
    expect(end).toBeGreaterThan(start);
    chunks.push(lines.slice(start, end + 1).join("\n"));
  }
  return chunks.join("\n");
}

const shellRoots: string[] = [];

/** 造一个假的 journalctl，让判定逻辑可以在没有 systemd 的机器上跑完整分支。 */
function fakeJournalDirectory(): string {
  const root: string = mkdtempSync(join(tmpdir(), "install-journal-"));
  shellRoots.push(root);
  const stub: string = join(root, "journalctl");
  writeFileSync(stub, [
    "#!/usr/bin/env bash",
    'if [ "${FAKE_JOURNAL_FAIL:-0}" = "1" ]; then exit 1; fi',
    'for arg in "$@"; do',
    '  if [ "$arg" = "--show-cursor" ]; then',
    "    printf -- '-- No entries --\\n'",
    '    printf -- "-- cursor: ${FAKE_JOURNAL_CURSOR:-s=deadbeef;i=1}\\n"',
    "    exit 0",
    "  fi",
    "done",
    'printf \'%s\\n\' "${FAKE_JOURNAL_BODY:-}"',
    "",
  ].join("\n"));
  chmodSync(stub, 0o755);
  return root;
}

/** 在 install.sh 同样的 `set -Eeuo pipefail` 下执行一段用到上述函数的脚本。 */
function runWithInstallFunctions(
  body: string,
  environment: Readonly<Record<string, string>> = {}
): { readonly stdout: string; readonly exitCode: number | null } {
  const functions: string = extractShellFunctions([
    "run_privileged",
    "service_journal_cursor",
    "service_journal_since",
    "journal_nonzero_exit_lines",
  ]);
  const result: Bun.SyncSubprocess<"pipe", "pipe"> = Bun.spawnSync({
    cmd: [
      "bash",
      "-c",
      `set -Eeuo pipefail\nreadonly SERVICE_NAME="copy-ninjia"\n${functions}\n${body}`,
    ],
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: new TextDecoder().decode(result.stdout),
    exitCode: result.exitCode,
  };
}

afterEach(() => {
  for (const root of shellRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * install.sh 里那几组硬编码必须跟着代码走。
 *
 * 安装器是 `curl | bash` 的一次性入口，装完就没了，没有任何运行时会去核对它
 * 抄下来的这些值。加一项 AI 能力却忘了改问卷，表现是新部署**静默**配不出那项
 * 能力——不报错、不缺文件，只是问卷少问一句。三组值各自与权威源对拍。
 */
describe("install.sh 与代码共享同一份事实", () => {
  test("问卷的能力全集与 AGENT_CAPABILITY_NAMES 逐项一致（含顺序）", () => {
    expect(extractShellArray("AGENT_CAPABILITIES")).toEqual([...AGENT_CAPABILITY_NAMES]);
  });

  test("问卷的必备能力与 AGENT_AI_CHAT_REQUIRED_CAPABILITIES 逐项一致", () => {
    expect(extractShellArray("AGENT_REQUIRED_CAPABILITIES"))
      .toEqual([...AGENT_AI_CHAT_REQUIRED_CAPABILITIES]);
  });

  test("Bun 精确版本与 packageManager 一致，类型声明覆盖同一主次版本", () => {
    const major: number = Number(extractShellScalar("REQUIRED_BUN_MAJOR"));
    const minor: number = Number(extractShellScalar("REQUIRED_BUN_MINOR"));
    const patch: number = Number(extractShellScalar("REQUIRED_BUN_PATCH"));
    expect(Number.isSafeInteger(major)).toBe(true);
    expect(Number.isSafeInteger(minor)).toBe(true);
    expect(Number.isSafeInteger(patch)).toBe(true);
    const manifest: {
      readonly packageManager?: string;
      readonly devDependencies: Readonly<Record<string, string>>;
    } = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")
    ) as {
      readonly packageManager?: string;
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    const runtimeVersion: string = manifest.packageManager?.replace(/^bun@/, "") ?? "";
    expect(runtimeVersion).toBe(`${major}.${minor}.${patch}`);
    const typesVersion: string = manifest.devDependencies["@types/bun"] ?? "";
    const parts: readonly string[] = typesVersion.replace(/^[^0-9]*/, "").split(".");
    const typesMajor: number = Number(parts[0]);
    const typesMinor: number = Number(parts[1]);
    expect(Number.isSafeInteger(typesMajor)).toBe(true);
    expect(Number.isSafeInteger(typesMinor)).toBe(true);
    expect([typesMajor, typesMinor]).toEqual([major, minor]);
  });

  test("重填问卷的判据用的就是 TELEGRAM_BOT_TOKEN_PLACEHOLDER", () => {
    // install.sh 靠 grep 这个串判断「telegram.json 还是示例值、需要问」。
    // 常量改了而这里没改，安装器会把已填好的配置当成没填，反复追问。
    expect(INSTALL_SCRIPT).toContain(`'${TELEGRAM_BOT_TOKEN_PLACEHOLDER}'`);
  });
});

describe("install.sh 启动后核对 journal 非零退出", () => {
  test("观察窗口的两条判据都接在同一个基线上", () => {
    const cursorIndex: number = INSTALL_SCRIPT.indexOf('JOURNAL_CURSOR="$(service_journal_cursor)"');
    const enableIndex: number = INSTALL_SCRIPT.indexOf('systemctl enable "${SERVICE_NAME}.service"');
    const verdictIndex: number = INSTALL_SCRIPT.indexOf('service_journal_since "$JOURNAL_CURSOR"');
    // 游标要在服务被拉起之前取，判定要在观察窗口之后做，否则窗口对不上。
    expect(cursorIndex).toBeGreaterThan(-1);
    expect(enableIndex).toBeGreaterThan(cursorIndex);
    expect(verdictIndex).toBeGreaterThan(enableIndex);
    expect(INSTALL_SCRIPT).toContain("在观察窗口内记录了非零退出");
  });

  test("非零退出与信号死亡都算，status=0 与普通日志不算", () => {
    const body: string = [
      "Started Copy Ninjia Telegram Bot.",
      "copy-ninjia.service: Main process exited, code=exited, status=0/SUCCESS",
      "copy-ninjia.service: Deactivated successfully.",
      "本天才上线啦♡",
    ].join("\n");
    expect(runWithInstallFunctions(
      `printf '%s\\n' "$BODY" | journal_nonzero_exit_lines`,
      { BODY: body }
    )).toEqual({ stdout: "", exitCode: 0 });

    for (const failing of [
      "copy-ninjia.service: Main process exited, code=exited, status=1/FAILURE",
      "copy-ninjia.service: Main process exited, code=exited, status=203/EXEC",
      "copy-ninjia.service: Main process exited, code=killed, status=9/KILL",
      "copy-ninjia.service: Main process exited, code=dumped, status=11/SEGV",
    ]) {
      const result = runWithInstallFunctions(
        `printf '%s\\n' "$BODY" | journal_nonzero_exit_lines`,
        { BODY: `Started Copy Ninjia.\n${failing}` }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(failing);
    }
  });

  test("空输入不命中，也不因为 grep 没匹配就把脚本判失败", () => {
    expect(runWithInstallFunctions(
      `printf '' | journal_nonzero_exit_lines; echo "survived"`
    )).toEqual({ stdout: "survived\n", exitCode: 0 });
  });

  test("取得游标后只读它之后的条目", () => {
    const path: string = `${fakeJournalDirectory()}:${process.env["PATH"] ?? ""}`;
    const result = runWithInstallFunctions(
      `CURSOR="$(service_journal_cursor)"; echo "cursor=$CURSOR"; service_journal_since "$CURSOR"`,
      { PATH: path, FAKE_JOURNAL_CURSOR: "s=abc;i=7", FAKE_JOURNAL_BODY: "after-cursor line" }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("cursor=s=abc;i=7\nafter-cursor line\n");
  });

  test("journalctl 失败时游标为空且脚本存活——不能被 set -e 打死", () => {
    const path: string = `${fakeJournalDirectory()}:${process.env["PATH"] ?? ""}`;
    const result = runWithInstallFunctions(
      `CURSOR="$(service_journal_cursor)"; echo "cursor=[$CURSOR]"; ` +
      `if service_journal_since "$CURSOR" >/dev/null; then echo read-ok; else echo degraded; fi`,
      { PATH: path, FAKE_JOURNAL_FAIL: "1" }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("cursor=[]\ndegraded\n");
  });

  test("机器上没有 journalctl 时降级成提示而不是失败", () => {
    const result = runWithInstallFunctions(
      `PATH=/nonexistent; if service_journal_since "" >/dev/null 2>&1; then echo read-ok; else echo degraded; fi`
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("degraded\n");
  });

  test("核对不成时收尾文案不得宣称 journal 无非零退出", () => {
    // 跳过了核对却写成「journal 无非零退出」，等于把没做过的检查报成通过。
    expect(INSTALL_SCRIPT).toContain('JOURNAL_VERDICT="、journal 无非零退出"');
    expect(INSTALL_SCRIPT).toContain('JOURNAL_VERDICT="、journal 未能核对"');
    expect(INSTALL_SCRIPT).toContain("观察窗口内未重启${JOURNAL_VERDICT}");
    expect(INSTALL_SCRIPT).not.toContain("观察窗口内未重启、journal 无非零退出");
  });

  test("journal 未核对时保留配置备份，只有成功分支允许清理", () => {
    const journalCheckIndex: number = INSTALL_SCRIPT.indexOf(
      'if JOURNAL_TAIL="$(service_journal_since "$JOURNAL_CURSOR")"; then'
    );
    const cleanupIndex: number = INSTALL_SCRIPT.indexOf("  finalize_config_backup", journalCheckIndex);
    const failureBranchIndex: number = INSTALL_SCRIPT.indexOf("\nelse\n", journalCheckIndex);
    expect(journalCheckIndex).toBeGreaterThan(-1);
    expect(cleanupIndex).toBeGreaterThan(journalCheckIndex);
    expect(cleanupIndex).toBeLessThan(failureBranchIndex);
    expect(INSTALL_SCRIPT.indexOf("\nfinalize_config_backup\n", failureBranchIndex)).toBe(-1);
  });

  test("读不到 journal 时脚本不 die，只 warn 并提示手动确认", () => {
    expect(INSTALL_SCRIPT).toContain("本次跳过非零退出核对");
    expect(INSTALL_SCRIPT).toContain("请手动确认：journalctl -u ${SERVICE_NAME} -n 50");
    // 降级分支必须是 warn，不能是 die：读不到 journal 不等于装失败。
    const degradedLine: string | undefined = INSTALL_SCRIPT.split("\n").find(
      (line: string): boolean => line.includes("本次跳过非零退出核对")
    );
    expect(degradedLine?.trimStart().startsWith("warn ")).toBe(true);
  });
});
