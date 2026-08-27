import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INSTALL_SCRIPT_PATH: string = join(import.meta.dir, "..", "..", "install.sh");
const INSTALL_SCRIPT: string = readFileSync(INSTALL_SCRIPT_PATH, "utf8");

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
