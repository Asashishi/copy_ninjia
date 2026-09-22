import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expandedInstallSource, readInstallScripts } from "../installSources";
import type { InstallScriptSource } from "../installSources";

/**
 * 一键安装脚本的自洽性：模块清单与步骤清单各自写在好几处，任何一处漏改都只会在
 * 真实安装时才暴露，而那一刻脚本已经在部署机上跑了一半。
 *
 * 核对三组事实：
 * 1. `scripts/install/` 下的模块文件、入口的语法自检循环、入口的 `source` 顺序三者一致；
 * 2. `step "n/N …"` 的编号连续、分母一致，且覆盖 1..N；
 * 3. 入口头注列出的步骤名与真实 `step` 调用逐字一致——头注是部署方唯一会读的流程说明。
 */

/** 入口头注里声明流程的那一段；每行一个步骤，顺序即执行顺序。 */
const HEADER_STEP_PATTERN: RegExp = /^# {3}(\d+)\/(\d+) (.+)$/gm;
/** 真实步骤声明；入口与各模块共用同一个 `step` 函数。 */
const STEP_CALL_PATTERN: RegExp = /^step "(\d+)\/(\d+) ([^"]+)"$/gm;
/** 入口的模块语法自检循环。 */
const MODULE_LOOP_PATTERN: RegExp = /^for install_module in ([a-z ]+); do$/m;
/** 入口逐个 source 安装模块。 */
const MODULE_SOURCE_PATTERN: RegExp = /^source "\.\/scripts\/install\/([a-z]+)\.sh"$/gm;

interface InstallStep {
  readonly index: number;
  readonly total: number;
  readonly title: string;
}

function parseSteps(source: string, pattern: RegExp): readonly InstallStep[] {
  const steps: InstallStep[] = [];
  for (const match of source.matchAll(pattern)) {
    steps.push({
      index: Number(match[1]),
      total: Number(match[2]),
      title: (match[3] ?? "").trim(),
    });
  }
  return steps;
}

function describe(steps: readonly InstallStep[]): string {
  return steps.map((step: InstallStep): string => `${step.index}/${step.total} ${step.title}`).join(", ");
}

/** 核对安装脚本的模块清单与步骤清单；全部一致时返回空数组。 */
export async function collectInstallModuleProblems(projectRoot: string): Promise<readonly string[]> {
  const problems: string[] = [];
  const scripts: readonly InstallScriptSource[] = await readInstallScripts(projectRoot);
  const entry: string = scripts[0]!.source;

  const onDisk: readonly string[] = readdirSync(join(projectRoot, "scripts", "install"))
    .filter((name: string): boolean => name.endsWith(".sh"))
    .map((name: string): string => name.slice(0, -3))
    .sort();
  const sourced: readonly string[] = [...entry.matchAll(MODULE_SOURCE_PATTERN)]
    .map((match: RegExpExecArray): string => match[1]!);
  const loopMatch: RegExpExecArray | null = MODULE_LOOP_PATTERN.exec(entry);
  const looped: readonly string[] = loopMatch === null ? [] : loopMatch[1]!.trim().split(/\s+/);

  if (loopMatch === null) {
    problems.push("install.sh no longer declares the install module syntax-check loop");
  }
  if ([...sourced].sort().join(" ") !== onDisk.join(" ")) {
    problems.push(
      `install.sh sources [${sourced.join(", ")}] but scripts/install/ holds [${onDisk.join(", ")}]`
    );
  }
  if (looped.join(" ") !== sourced.join(" ")) {
    problems.push(
      `install.sh checks [${looped.join(", ")}] but sources [${sourced.join(", ")}] in a different order`
    );
  }

  const expanded: string = await expandedInstallSource(projectRoot);
  const steps: readonly InstallStep[] = parseSteps(expanded, STEP_CALL_PATTERN);
  if (steps.length === 0) {
    problems.push("install.sh declares no numbered steps");
    return problems;
  }
  const total: number = steps.length;
  for (const [position, step] of steps.entries()) {
    if (step.index === position + 1 && step.total === total) continue;
    problems.push(
      `install.sh step "${step.index}/${step.total} ${step.title}" should be numbered ${position + 1}/${total}`
    );
  }

  const headerSteps: readonly InstallStep[] = parseSteps(entry, HEADER_STEP_PATTERN);
  if (describe(headerSteps) !== describe(steps)) {
    problems.push(
      `install.sh header lists [${describe(headerSteps)}] but the script runs [${describe(steps)}]`
    );
  }
  return problems;
}
