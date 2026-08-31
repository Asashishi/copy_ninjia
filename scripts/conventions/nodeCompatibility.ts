import { relative } from "node:path";
import ts from "typescript";

type NodeImportSymbols = "*" | readonly string[];

interface NodeImportAllowance {
  readonly symbols: NodeImportSymbols;
  readonly purpose: string;
}

/** 脚本可复用的 Node 兼容接口；生产模块必须再按精确文件登记。 */
const SCRIPT_NODE_IMPORTS: Readonly<Record<string, NodeImportAllowance>> = {
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

/** 生产模块中 Bun 原生能力未覆盖的精确 Node 兼容调用位置。 */
const PRODUCTION_NODE_IMPORTS: Readonly<
  Record<string, Readonly<Record<string, NodeImportAllowance>>>
> = {
  "packages/config/readiness.ts": {
    "node:crypto": {
      symbols: ["createPrivateKey"],
      purpose: "private-key syntax validation",
    },
    "node:fs/promises": {
      symbols: ["lstat"],
      purpose: "startup deployment-input metadata validation",
    },
  },
  "packages/database/interact/connection.ts": {
    "node:fs": {
      symbols: ["existsSync"],
      purpose: "rejecting a missing SQLite file before opening without create semantics",
    },
  },
  "packages/database/interact/migration.ts": {
    "node:fs": {
      symbols: ["existsSync"],
      purpose: "cold database creation precondition",
    },
  },
  "packages/infra/processStatus.ts": {
    "node:os": {
      symbols: ["availableParallelism", "totalmem"],
      purpose: "runtime capacity limits derived from host resources",
    },
  },
  "packages/infra/storage/cleanup.ts": {
    "node:fs/promises": {
      symbols: ["readdir"],
      purpose: "runtime data-root directory traversal",
    },
  },
  "packages/infra/storage/dataRoot.ts": {
    "node:fs/promises": {
      symbols: ["link", "lstat", "mkdir", "open", "rename"],
      purpose: "data-root metadata, exclusive create, hard-link, directory, and atomic rename operations",
    },
  },
  "packages/infra/storage/instanceLock.ts": {
    "node:fs/promises": {
      symbols: ["link", "open"],
      purpose: "single-instance exclusive create and hard-link publication",
    },
  },
  "packages/infra/updateContext.ts": {
    "node:async_hooks": {
      symbols: ["AsyncLocalStorage"],
      purpose: "per-update asynchronous log context",
    },
  },
  "packages/libs/atomicFile.ts": {
    "node:fs": {
      symbols: [
        "closeSync", "fchmodSync", "fsyncSync", "openSync", "renameSync",
        "statSync", "unlinkSync", "writeFileSync", "writeSync",
      ],
      purpose: "descriptor durability, permissions, exclusive writes, cleanup, and atomic publication",
    },
    "node:fs/promises": {
      symbols: ["open", "rename"],
      purpose: "asynchronous descriptor durability and atomic publication",
    },
  },
  "packages/libs/fileAccess.ts": {
    "node:fs": {
      symbols: ["accessSync", "constants", "lstatSync"],
      purpose: "startup file type and access-mode validation",
    },
  },
  "packages/libs/luckReceipt.ts": {
    "node:crypto": {
      symbols: ["timingSafeEqual"],
      purpose: "constant-time receipt authentication comparison",
    },
  },
  "packages/workers/diskIO/adSampleFile.ts": {
    "node:fs": {
      symbols: ["existsSync", "mkdirSync", "readdirSync", "renameSync", "unlinkSync"],
      purpose: "Disk I/O owner directory maintenance and atomic archive publication",
    },
  },
  "packages/workers/diskIO/appendOnlyDayFile.ts": {
    "node:fs": {
      symbols: ["closeSync", "existsSync", "fsyncSync", "openSync", "statSync", "writeSync"],
      purpose: "append-only descriptor metadata, writes, and fsync",
    },
  },
  "packages/workers/diskIO/joinLogFiles.ts": {
    "node:fs": {
      symbols: ["existsSync", "mkdirSync"],
      purpose: "join-log owner directory initialization",
    },
  },
  "packages/workers/diskIO/joinLogRecovery.ts": {
    "node:fs": {
      symbols: ["existsSync", "mkdirSync", "readdirSync", "unlinkSync"],
      purpose: "owner-local journal metadata and stale-file cleanup",
    },
  },
  "packages/workers/diskIO/logFiles.ts": {
    "node:fs": {
      symbols: ["existsSync", "mkdirSync", "readdirSync", "statSync", "unlinkSync"],
      purpose: "log metadata inspection and stale-file cleanup",
    },
  },
  "packages/workers/diskIO/luckSecretFile.ts": {
    "node:fs": {
      symbols: ["existsSync", "mkdirSync"],
      purpose: "luck-secret owner directory initialization",
    },
  },
  "packages/workers/diskIO/snapshotFiles.ts": {
    "node:fs": {
      symbols: ["existsSync", "mkdirSync", "readdirSync", "unlinkSync"],
      purpose: "snapshot directory traversal and stale-file cleanup",
    },
  },
  "packages/workers/diskIO/verificationRecovery.ts": {
    "node:fs": {
      symbols: ["existsSync", "mkdirSync", "readdirSync", "unlinkSync"],
      purpose: "verification journal metadata and retention cleanup",
    },
  },
  "packages/workers/diskIO/verificationWrites.ts": {
    "node:fs": {
      symbols: ["mkdirSync"],
      purpose: "verification journal owner directory initialization",
    },
  },
};

/** 生产文件中有实测或字节接口语义依据的 Node Buffer 全局调用位置。 */
const PRODUCTION_BUFFER_GLOBALS: Readonly<Record<string, string>> = {
  "packages/aiChat/ai/songCover.ts": "binary image payload conversion for Sharp",
  "packages/commands/luckChallenge/draw.ts": "binary receipt payload encoding",
  "packages/consts/diskIO/joinLog.ts": "UTF-8 byte-size capacity constants",
  "packages/infra/image.ts": "binary Telegram image payload conversion",
  "packages/libs/atomicFile.ts": "descriptor writes require a stable byte buffer",
  "packages/libs/jsonBytes.ts": "allocation-free UTF-8 byte length on the hot serialization boundary",
  "packages/workers/diskIO/appendOnlyDayFile.ts": "descriptor append and recovery byte buffers",
  "packages/workers/diskIO/joinLogFiles.ts": "join-log byte-capacity accounting",
  "packages/workers/diskIO/joinLogRecords.ts": "join-log serialized byte accounting",
  "packages/workers/diskIO/logFiles.ts": "log serialized byte accounting",
  "packages/workers/diskIO/verificationRecovery.ts": "verification journal byte accounting",
  "packages/workers/diskIO/verificationWrites.ts": "verification descriptor write buffers",
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
    const allowed: NodeImportAllowance | undefined = moduleName === "node:path"
      ? SCRIPT_NODE_IMPORTS[moduleName]
      : isScript
        ? SCRIPT_NODE_IMPORTS[moduleName]
        : PRODUCTION_NODE_IMPORTS[relativePath]?.[moduleName];
    const scriptAllowed: NodeImportAllowance | undefined = isScript
      ? SCRIPT_ONLY_NODE_IMPORTS[moduleName]
      : undefined;
    const line: number = source.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
    const location: string = `${relativePath}:${line}`;
    const clause: ts.ImportClause | undefined = statement.importClause;
    if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
    if (allowed === undefined && scriptAllowed === undefined) {
      problems.push(`${location} uses unreviewed Node compatibility module ${moduleName}`);
      continue;
    }
    if (
      clause === undefined ||
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
  let reportedBufferGlobal: boolean = false;
  const visitBufferGlobal = (node: ts.Node): void => {
    if (reportedBufferGlobal || PRODUCTION_BUFFER_GLOBALS[relativePath] !== undefined) return;
    const isBuffer: boolean = ts.isIdentifier(node) && node.text === "Buffer";
    if (isBuffer) {
      const parent: ts.Node = node.parent;
      const isPropertyName: boolean =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isMethodSignature(parent) && parent.name === node);
      const isGlobalUse: boolean = !isPropertyName;
      if (isGlobalUse) {
        const line: number = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        problems.push(
          `${relativePath}:${line} uses unreviewed Node compatibility global Buffer`
        );
        reportedBufferGlobal = true;
        return;
      }
    }
    ts.forEachChild(node, visitBufferGlobal);
  };
  if (!isScript) visitBufferGlobal(source);
  return problems;
}
