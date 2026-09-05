type NodeImportSymbols = "*" | readonly string[];

export interface NodeImportAllowance {
  readonly symbols: NodeImportSymbols;
  readonly purpose: string;
}

export interface BufferGlobalAllowance {
  readonly methods: readonly string[];
  readonly purpose: string;
}

/** 脚本可复用的 Node 兼容接口；生产模块必须再按精确文件登记。 */
export const SCRIPT_NODE_IMPORTS: Readonly<Record<string, NodeImportAllowance>> = {
  "node:async_hooks": {
    symbols: ["AsyncLocalStorage"],
    purpose: "per-update asynchronous log context",
  },
  "node:crypto": {
    symbols: ["createPrivateKey"],
    purpose: "private-key parsing",
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
export const PRODUCTION_NODE_IMPORTS: Readonly<
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
  "packages/workers/diskIO/joinLogWrites.ts": {
    "node:fs": {
      symbols: ["mkdirSync"],
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
      symbols: ["mkdirSync"],
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
export const PRODUCTION_BUFFER_GLOBALS: Readonly<Record<string, BufferGlobalAllowance>> = {
  "packages/libs/atomicFile.ts": {
    methods: ["byteLength"],
    purpose: "allocation-free UTF-8 byte accounting after descriptor writes",
  },
  "packages/libs/jsonBytes.ts": {
    methods: ["byteLength"],
    purpose: "allocation-free UTF-8 byte length on the hot serialization boundary",
  },
  "packages/workers/diskIO/appendOnlyDayFile.ts": {
    methods: ["byteLength"],
    purpose: "append-only physical byte accounting",
  },
  "packages/workers/diskIO/joinLogWrites.ts": {
    methods: ["byteLength"],
    purpose: "join-log byte-capacity accounting",
  },
  "packages/workers/diskIO/joinLogRecords.ts": {
    methods: ["byteLength"],
    purpose: "join-log serialized byte accounting",
  },
  "packages/workers/diskIO/logFiles.ts": {
    methods: ["byteLength"],
    purpose: "log serialized byte accounting",
  },
  "packages/workers/diskIO/verificationRecovery.ts": {
    methods: ["byteLength"],
    purpose: "verification journal byte accounting",
  },
  "packages/workers/diskIO/verificationWrites.ts": {
    methods: ["byteLength"],
    purpose: "verification journal byte accounting",
  },
};

/** 基准必须与生产的无分配 UTF-8 字节口径完全一致。 */
export const SCRIPT_BUFFER_GLOBALS: Readonly<Record<string, BufferGlobalAllowance>> = {
  "scripts/perf/joinLog.ts": {
    methods: ["byteLength"],
    purpose: "production-equivalent join-log byte accounting",
  },
};

/** 一次性脚本为同步编排、临时根和机器信息额外使用的 Node 兼容接口。 */
export const SCRIPT_ONLY_NODE_IMPORTS: Readonly<Record<string, NodeImportAllowance>> = {
  "node:module": {
    symbols: ["isBuiltin"],
    purpose: "runtime-authoritative builtin module identification without maintaining a duplicate module list",
  },
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
export const SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS: Readonly<
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
