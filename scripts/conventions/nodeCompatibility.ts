import { relative } from "node:path";
import ts from "typescript";

type NodeImportSymbols = "*" | readonly string[];

interface NodeImportAllowance {
  readonly symbols: NodeImportSymbols;
  readonly purpose: string;
}

/** Bun 原生能力未覆盖、生产代码可以静态引入的 Node 兼容接口。 */
const ALLOWED_NODE_IMPORTS: Readonly<Record<string, NodeImportAllowance>> = {
  "node:async_hooks": {
    symbols: ["AsyncLocalStorage"],
    purpose: "per-update asynchronous log context",
  },
  "node:crypto": {
    symbols: ["createPrivateKey", "timingSafeEqual"],
    purpose: "private-key parsing and constant-time credential comparison",
  },
  "node:fs": {
    symbols: [
      "accessSync",
      "chmodSync",
      "closeSync",
      "constants",
      "existsSync",
      "fchmodSync",
      "fsyncSync",
      "lstatSync",
      "mkdirSync",
      "openSync",
      "readFileSync",
      "readdirSync",
      "renameSync",
      "statSync",
      "unlinkSync",
      "writeFileSync",
      "writeSync",
    ],
    purpose: "synchronous metadata, descriptor, durability, directory, and atomic-file operations",
  },
  "node:fs/promises": {
    symbols: ["link", "lstat", "mkdir", "open", "readdir", "rename"],
    purpose: "asynchronous metadata, descriptor, hard-link, directory, and atomic rename operations",
  },
  "node:os": {
    symbols: ["availableParallelism", "totalmem"],
    purpose: "runtime capacity limits derived from host resources",
  },
  "node:path": {
    symbols: "*",
    purpose: "portable lexical path construction and normalization",
  },
};

/** 一次性脚本为同步编排、临时根和机器信息额外使用的 Node 兼容接口。 */
const SCRIPT_ONLY_NODE_IMPORTS: Readonly<Record<string, NodeImportAllowance>> = {
  "node:fs": {
    symbols: ["mkdtempSync", "rmSync", "symlinkSync"],
    purpose: "isolated temporary-root lifecycle and fixture topology for one-shot scripts and benchmarks",
  },
  "node:os": {
    symbols: ["arch", "cpus", "platform", "release", "tmpdir"],
    purpose: "benchmark machine identity and temporary-root placement",
  },
};

/** 同步内容 I/O 仅保留 Bun 原生 API 无法覆盖的精确语义与调用位置。 */
const SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS: Readonly<
  Record<string, Readonly<Record<string, NodeImportAllowance>>>
> = {
  "scripts/migration/backup.ts": {
    "node:fs": {
      symbols: ["readFileSync", "writeFileSync"],
      purpose: "exclusive-create backup writes followed by same-boundary fsync and byte verification",
    },
  },
  "scripts/perf/fullSuite/processIo.ts": {
    "node:fs": {
      symbols: ["readFileSync"],
      purpose: "synchronous /proc I/O counter snapshots bracketing measured work",
    },
  },
};

function allowsImport(
  allowance: NodeImportAllowance | undefined,
  imported: string
): boolean {
  return allowance?.symbols === "*" || allowance?.symbols.includes(imported) === true;
}

/**
 * 核对一个生产模块的 Node 兼容 import。未登记模块、namespace/default import 与
 * 未登记符号都拒绝；第三方依赖和测试文件不进入本检查。
 */
export function collectNodeCompatibilityProblems(
  projectRoot: string,
  path: string,
  source: ts.SourceFile
): readonly string[] {
  const problems: string[] = [];
  const relativePath: string = relative(projectRoot, path);
  const isScript: boolean = relativePath.startsWith("scripts/");
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith("node:")
    ) continue;
    const moduleName: string = statement.moduleSpecifier.text;
    const allowed: NodeImportAllowance | undefined = ALLOWED_NODE_IMPORTS[moduleName];
    const scriptAllowed: NodeImportAllowance | undefined = isScript
      ? SCRIPT_ONLY_NODE_IMPORTS[moduleName]
      : undefined;
    const line: number = source.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
    const location: string = `${relativePath}:${line}`;
    if (allowed === undefined && scriptAllowed === undefined) {
      problems.push(`${location} uses unreviewed Node compatibility module ${moduleName}`);
      continue;
    }
    const clause: ts.ImportClause | undefined = statement.importClause;
    if (
      clause === undefined ||
      clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
      allowed?.symbols === "*"
    ) continue;
    if (clause.name !== undefined || clause.namedBindings === undefined) {
      problems.push(`${location} must use reviewed named imports from ${moduleName}`);
      continue;
    }
    if (ts.isNamespaceImport(clause.namedBindings)) {
      problems.push(`${location} must not namespace-import ${moduleName}`);
      continue;
    }
    for (const element of clause.namedBindings.elements) {
      if (element.isTypeOnly) continue;
      const imported: string = element.propertyName?.text ?? element.name.text;
      const contentIoAllowance: NodeImportAllowance | undefined = isScript
        ? SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS[relativePath]?.[moduleName]
        : undefined;
      const isSynchronousContentIo: boolean = moduleName === "node:fs" &&
        (imported === "readFileSync" || imported === "writeFileSync");
      const permitted: boolean = isSynchronousContentIo && isScript
        ? allowsImport(contentIoAllowance, imported)
        : allowsImport(allowed, imported) || allowsImport(scriptAllowed, imported);
      if (!permitted) {
        problems.push(`${location} uses unreviewed ${moduleName} export ${imported}`);
      }
    }
  }
  return problems;
}
