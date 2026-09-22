/**
 * 一键安装脚本的自洽性门禁（scripts/conventions/installModules.ts）。
 * 真实仓库当前一致，因此这里在临时副本里逐条打散，确认每种分叉都能被拦下。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectInstallModuleProblems } from "../../scripts/conventions/installModules";

const REPO_ROOT: string = join(import.meta.dir, "..", "..");
let fixtureRoot: string | null = null;

/** 把入口与安装模块复制到临时目录；其余文件本门禁用不到。 */
function fixture(): string {
  fixtureRoot = mkdtempSync(join(tmpdir(), "copy-ninjia-install-gate-"));
  cpSync(join(REPO_ROOT, "install.sh"), join(fixtureRoot, "install.sh"));
  cpSync(join(REPO_ROOT, "scripts", "install"), join(fixtureRoot, "scripts", "install"), { recursive: true });
  return fixtureRoot;
}

async function rewrite(root: string, replace: (source: string) => string): Promise<void> {
  const path: string = join(root, "install.sh");
  await Bun.write(path, replace(await Bun.file(path).text()));
}

afterEach((): void => {
  if (fixtureRoot !== null) rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = null;
});

describe("安装脚本自洽性", () => {
  test("真实仓库当前一致", async () => {
    expect(await collectInstallModuleProblems(REPO_ROOT)).toEqual([]);
  });

  test("头注的步骤名与真实 step 调用必须逐字一致", async () => {
    const root: string = fixture();
    await rewrite(root, (source: string): string => source.replace("#   6/8 填写配置", "#   6/8 填写设置"));

    expect(await collectInstallModuleProblems(root))
      .toEqual([expect.stringContaining("header lists")]);
  });

  test("语法自检循环与 source 顺序不一致时报错", async () => {
    const root: string = fixture();
    await rewrite(root, (source: string): string => source.replace(
      "for install_module in repository service config runtime configure start; do",
      "for install_module in repository service config runtime start configure; do"
    ));

    expect(await collectInstallModuleProblems(root))
      .toEqual([expect.stringContaining("in a different order")]);
  });

  test("少 source 一个模块时同时报「与目录不符」和「顺序不一致」", async () => {
    const root: string = fixture();
    await rewrite(root, (source: string): string =>
      source.replace('source "./scripts/install/start.sh"', "# start module intentionally dropped"));
    const problems: readonly string[] = await collectInstallModuleProblems(root);

    expect(problems.some((problem: string): boolean => problem.includes("scripts/install/ holds"))).toBeTrue();
    expect(problems.some((problem: string): boolean => problem.includes("in a different order"))).toBeTrue();
  });

  test("步骤编号不连续时点名那一步", async () => {
    const root: string = fixture();
    await Bun.write(
      join(root, "scripts", "install", "configure.sh"),
      (await Bun.file(join(root, "scripts", "install", "configure.sh")).text())
        .replace('step "6/8 填写配置"', 'step "9/8 填写配置"')
    );

    expect(await collectInstallModuleProblems(root))
      .toEqual(expect.arrayContaining([expect.stringContaining("should be numbered 6/8")]));
  });
});
