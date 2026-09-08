import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { withoutMarkdownCodeFences } from "./markdownSource";

/**
 * 文档里「目录清单」写法的存在性核对。
 *
 * `docs/<lang>/03-directory-map.md` 用「`<目录>/`（`a.ts`、`b.ts`）」列一个目录的代表文件。
 * 这些名字既不是 Markdown 链接（`checkMarkdownLocalLinks` 看不到），也不在源码注释里
 * （`collectCommentReferenceProblems` 看不到），于是文件删掉之后清单会静默留旧名——
 * `packages/database/interact/admin.ts` 就这样在 release 里被删掉后继续挂在三份
 * 文档里，一路走过了每一次 `bun run check`。
 *
 * 判据只做一件事：括号里点名的文件在那个目录下还在不在。**歧义一律放过**，
 * 本检查的价值在于零误报：
 * - 目录名在仓库里解析不到唯一一处 → 跳过整段。
 * - 括号里出现占位符（`<domain>` 之类）或非 `.ts` 条目 → 那一项跳过。
 * - 只认紧跟在 `` `<目录>/` `` 之后的那一对括号，不扫散落全文的文件名。
 */

/** 只认「反引号包起来、以 / 结尾的单段目录名」，紧跟一个左括号。 */
const DIRECTORY_LIST_PATTERN: RegExp = /`([A-Za-z][A-Za-z0-9_.-]*)\/`\s*[（(]/g;

/** 括号内的候选条目；占位符与非 .ts 名字不会命中。 */
const MEMBER_PATTERN: RegExp = /`([A-Za-z][A-Za-z0-9_.-]*\.ts)`/g;

/** 从左括号起截到配对的右括号；不配对时返回 undefined，整段跳过。 */
function balancedSegment(source: string, openIndex: number): string | undefined {
  const open: string | undefined = source[openIndex];
  if (open === undefined) return undefined;
  const close: string = open === "（" ? "）" : ")";
  let depth: number = 0;
  for (let index: number = openIndex; index < source.length; index += 1) {
    const character: string | undefined = source[index];
    if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return undefined;
}

/** 仓库里以 `/<name>` 结尾的目录；恰好一处时才参与核对。 */
function resolveDirectory(
  name: string,
  directories: readonly string[]
): string | undefined {
  const suffix: string = `/${name}`;
  const matches: readonly string[] = directories.filter(
    (directory: string): boolean => directory.endsWith(suffix)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * 收集参与解析的目录集合。
 *
 * **只走源码根**（调用方传 packages/ scripts/ test/），不扫仓库根：`database/`、
 * `logs/`、`memory/` 是部署方数据，其中两个是 2770，服务账号组外的用户跑门禁时
 * `readdirSync` 会直接抛，把整道 gate 拖垮；而文档里所有真正能解析出唯一目标的
 * 目录名（interact / schema / lockdown / verification / message）本来就都在
 * packages/ 下，收窄范围一条覆盖都不损失。
 */
export function collectSourceDirectories(
  roots: readonly string[]
): string[] {
  const directories: string[] = [];
  const visit = (root: string): void => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path: string = join(root, entry.name);
      directories.push(path);
      visit(path);
    }
  };
  for (const root of roots) visit(root);
  return directories;
}

/** 核对一份 Markdown 里全部目录清单点名的文件是否仍然存在。 */
export async function collectMarkdownModuleListProblems(
  projectRoot: string,
  path: string,
  directories: readonly string[]
): Promise<readonly string[]> {
  const problems: string[] = [];
  const source: string = withoutMarkdownCodeFences(await Bun.file(path).text());
  for (const match of source.matchAll(DIRECTORY_LIST_PATTERN)) {
    const directoryName: string | undefined = match[1];
    if (directoryName === undefined) continue;
    const directory: string | undefined = resolveDirectory(directoryName, directories);
    if (directory === undefined) continue;
    const segment: string | undefined = balancedSegment(
      source,
      match.index + match[0].length - 1
    );
    if (segment === undefined) continue;
    for (const member of segment.matchAll(MEMBER_PATTERN)) {
      const fileName: string | undefined = member[1];
      if (fileName === undefined) continue;
      if (existsSync(join(directory, fileName))) continue;
      const line: number = source.slice(0, match.index).split("\n").length;
      problems.push(
        `${relative(projectRoot, path)}:${line} lists ${fileName} under ${directoryName}/, ` +
        `but ${relative(projectRoot, join(directory, fileName))} does not exist`
      );
    }
  }
  return problems;
}
