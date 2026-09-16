import { join } from "node:path";

/** 安装入口及其直接 source 的目标工作树模块，用于语法门禁和隔离夹具。 */
export interface InstallScriptSource {
  readonly path: string;
  readonly source: string;
}

/** 按入口声明顺序读取模块；缺文件直接失败，不从其它版本补取。 */
export async function readInstallScripts(projectRoot: string): Promise<readonly InstallScriptSource[]> {
  const entry: InstallScriptSource = { path: "install.sh", source: await Bun.file(join(projectRoot, "install.sh")).text() };
  const sources: InstallScriptSource[] = [entry];
  for (const match of entry.source.matchAll(/^source "\.\/(scripts\/install\/[a-z]+\.sh)"$/gm)) {
    const path: string = match[1]!;
    sources.push({ path, source: await Bun.file(join(projectRoot, path)).text() });
  }
  return sources;
}

/** 静态测试按 source 位置展开实际模块，保留原有步骤和函数的相对顺序。 */
export async function expandedInstallSource(projectRoot: string): Promise<string> {
  const sources: readonly InstallScriptSource[] = await readInstallScripts(projectRoot);
  let expanded: string = sources[0]!.source;
  for (const script of sources.slice(1)) expanded = expanded.replace(`source "./${script.path}"`, (): string => script.source);
  return expanded;
}
