type NodeImportSymbols = "*" | readonly string[];

export interface NodeImportAllowance {
  readonly symbols: NodeImportSymbols;
  readonly purpose: string;
}

export interface BufferGlobalAllowance {
  readonly methods: readonly string[];
  readonly purpose: string;
}

/** 生产、脚本与测试都可直接使用的 Node 兼容接口。 */
export const PORTABLE_NODE_IMPORTS: Readonly<Record<string, NodeImportAllowance>> = {
  "node:path": {
    symbols: "*",
    purpose: "portable lexical path construction and normalization",
  },
};

export const PRODUCTION_NODE_IMPORTS: Readonly<
  Record<string, Readonly<Record<string, NodeImportAllowance>>>
> = {
  "packages/app/configReload.ts": {
    "node:fs": {
      symbols: ["watch"],
      purpose: "deployment config directory change notification (Bun documents node:fs watch as its file-watching API)",
    },
  },
  "packages/cache/perThread/updateContext.ts": {
    "node:async_hooks": {
      symbols: ["AsyncLocalStorage"],
      purpose: "per-thread update cancellation and clock scope storage",
    },
  },
  "packages/config/googleAuth.ts": {
    "node:crypto": {
      symbols: ["createPrivateKey"],
      purpose: "private-key syntax validation",
    },
  },
  "packages/config/botInput.ts": {
    "node:fs/promises": {
      symbols: ["lstat"],
      purpose: "rejecting legacy Bot configuration entries including dangling links without reading their contents",
    },
  },
  "packages/config/readiness.ts": {
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
  "packages/infra/randomImage.ts": {
    "node:fs": { symbols: ["constants"], purpose: "directory read, write and search access flags" },
    "node:fs/promises": {
      symbols: ["access", "lstat", "mkdir", "readdir", "rename"],
      purpose: "random image directory creation at startup, per-request directory traversal, and the atomic rename that publishes a collected picture",
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
  "packages/infra/storage/statePersistence.ts": {
    "node:fs/promises": {
      symbols: ["lstat"],
      purpose: "distinguishing a truly missing state copy from a dangling symbolic link",
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
      symbols: ["accessSync", "constants", "lstatSync", "statSync"],
      purpose: "startup file type and access-mode validation",
    },
  },
  "packages/workers/diskIO/adSampleFile.ts": {
    "node:fs": {
      symbols: ["existsSync", "mkdirSync", "readdirSync", "renameSync"],
      purpose: "Disk I/O owner directory maintenance and atomic archive publication",
    },
  },
  "packages/workers/diskIO/appendOnlyDayFile.ts": {
    "node:fs": {
      symbols: ["closeSync", "fsyncSync", "openSync", "statSync", "writeSync"],
      purpose: "append-only descriptor metadata, writes, and fsync",
    },
  },
  "packages/workers/diskIO/joinLogWrites.ts": {
    "node:fs": {
      symbols: ["mkdirSync", "statSync"],
      purpose: "join-log owner directory initialization and file identity checks around failed compaction",
    },
  },
  "packages/workers/diskIO/joinLogRecovery.ts": {
    "node:fs": {
      symbols: ["mkdirSync", "readdirSync"],
      purpose: "owner-local journal metadata and stale-file cleanup",
    },
  },
  "packages/workers/diskIO/logFiles.ts": {
    "node:fs": {
      symbols: ["mkdirSync", "readdirSync"],
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
      symbols: ["mkdirSync", "readdirSync"],
      purpose: "snapshot directory traversal and stale-file cleanup",
    },
  },
  "packages/workers/diskIO/wedMemberFiles.ts": {
    "node:fs": {
      symbols: ["mkdirSync", "readdirSync"],
      purpose: "wed member snapshot directory inspection and initialization",
    },
  },
  "packages/workers/diskIO/verificationRecovery.ts": {
    "node:fs": {
      symbols: ["mkdirSync", "readdirSync"],
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

/** 一次性脚本（约定自检、冷迁移、基准、发布）可用的 Node 兼容接口；只在 scripts/ 下生效。 */
export const SCRIPT_NODE_IMPORTS: Readonly<Record<string, NodeImportAllowance>> = {
  "node:module": {
    symbols: ["isBuiltin"],
    purpose: "runtime-authoritative builtin module identification without maintaining a duplicate module list",
  },
  "node:fs": {
    symbols: [
      "chmodSync",
      "existsSync",
      "lstatSync",
      "mkdirSync",
      "mkdtempSync",
      "readdirSync",
      "renameSync",
      "rmSync",
      "statSync",
      "symlinkSync",
    ],
    // 同步内容 I/O（readFileSync / writeFileSync）不走本表：只由
    // SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS 按调用点逐个放行（见 nodeCompatibility.ts 的 permitted 判定）。
    purpose: "synchronous metadata, permission, directory, atomic rename, and isolated temporary-root operations",
  },
  "node:fs/promises": {
    symbols: ["lstat", "mkdir", "readdir", "readlink", "realpath"],
    purpose: "asynchronous metadata, directory creation, directory enumeration with entry types, and canonical filesystem path resolution",
  },
  "node:os": {
    symbols: ["arch", "availableParallelism", "cpus", "platform", "release", "tmpdir", "totalmem"],
    purpose: "benchmark machine identity, host capacity limits, and temporary-root placement",
  },
};

/** 测试夹具、隔离临时根与密钥样本可用的 Node 兼容接口；只在 test/ 下生效。 */
export const TEST_SHARED_NODE_IMPORTS: Readonly<Record<string, NodeImportAllowance>> = {
  "node:crypto": {
    symbols: ["generateKeyPairSync"],
    purpose: "throwaway private-key fixtures for credential parsing",
  },
  "node:fs": {
    symbols: [
      "chmodSync",
      "cpSync",
      "existsSync",
      "lstatSync",
      "mkdirSync",
      "mkdtempSync",
      "readdirSync",
      "rmSync",
      "rmdirSync",
      "statSync",
      "symlinkSync",
      "writeSync",
    ],
    // 同步内容 I/O 只由 TEST_SYNC_CONTENT_IO_EXEMPTIONS 按调用点放行。
    purpose: "isolated temporary-root lifecycle, config fixture copies, metadata and permission fixtures, and filesystem topology fixtures",
  },
  "node:fs/promises": {
    symbols: ["lstat", "mkdir", "mkdtemp", "rename", "rm"],
    purpose: "asynchronous metadata, isolated temporary-root lifecycle, and moving fixture directories out of place",
  },
  "node:os": {
    symbols: ["tmpdir"],
    purpose: "temporary-root placement",
  },
};

/** 测试文件中需要整模块替身或透传包装的精确 Node 兼容 import 位置。 */
export const TEST_NODE_IMPORTS: Readonly<
  Record<string, Readonly<Record<string, NodeImportAllowance>>>
> = {
  "test/infra/storageLockDurability.test.ts": {
    "node:fs/promises": {
      symbols: "*",
      purpose: "real-module snapshot behind mock.module fault injection",
    },
  },
  "test/libs/atomicFile.test.ts": {
    "node:fs": {
      symbols: "*",
      purpose: "real-module snapshot behind mock.module fault injection",
    },
    "node:fs/promises": {
      symbols: "*",
      purpose: "real-module snapshot behind mock.module fault injection",
    },
  },
  "test/libs/fileAccess.test.ts": {
    "node:fs": {
      symbols: "*",
      purpose: "spyOn targets for metadata and access-mode failures",
    },
  },
  "test/productionModules.test.ts": {
    "node:fs": {
      symbols: "*",
      purpose: "pass-through write guard installed with mock.module during production imports",
    },
    "node:fs/promises": {
      symbols: "*",
      purpose: "pass-through write guard installed with mock.module during production imports",
    },
  },
  "test/workers/diskIO/joinLogCompaction.test.ts": {
    "node:fs": {
      symbols: "*",
      purpose: "spyOn target for directory fsync failures",
    },
  },
};

/** 测试文件中有字节接口语义依据的 Node Buffer 全局调用位置。 */
export const TEST_BUFFER_GLOBALS: Readonly<Record<string, BufferGlobalAllowance>> = {
  "test/config/googleAuth.test.ts": {
    methods: ["from"],
    purpose: "DER byte patching of generated private-key fixtures",
  },
  "test/infra/loggerSerializationBudget.test.ts": {
    methods: ["byteLength"],
    purpose: "production-equivalent UTF-8 byte budget assertions",
  },
  "test/libs/boundedResponse.test.ts": {
    methods: ["from"],
    purpose: "Buffer-typed stream chunk inputs",
  },
};

/** 同步内容 I/O 仅保留 Bun 原生 API 无法覆盖的精确语义与调用位置。 */
export const SCRIPT_SYNC_CONTENT_IO_EXEMPTIONS: Readonly<
  Record<string, Readonly<Record<string, NodeImportAllowance>>>
> = {
  "scripts/perf/fullSuite/processIo.ts": {
    "node:fs": {
      symbols: ["readFileSync"],
      purpose: "synchronous /proc I/O counter snapshots bracketing measured work",
    },
  },
};

/** 测试预加载在任何测试模块求值前同步准备隔离配置根，仅限这些位置使用同步内容 I/O。 */
export const TEST_SYNC_CONTENT_IO_EXEMPTIONS: Readonly<
  Record<string, Readonly<Record<string, NodeImportAllowance>>>
> = {
  "test/preloadEnv.ts": {
    "node:fs": {
      symbols: ["readFileSync", "writeFileSync"],
      purpose: "synchronous isolated config-root rewrite before environment-derived constants load",
    },
  },
};
