import { afterAll } from "bun:test";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
// 必须排在下面那条生产 import 之前：它负责在 consts/paths 求值之前注入两个
// 根目录（见 test/preloadEnv.ts 的说明）。
import { PREVIOUS_CONFIG_ROOT, PREVIOUS_DATA_ROOT, TEST_DATA_ROOT } from "./preloadEnv";
import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "../packages/consts/environment";
import {
  adoptAdDetectAgentConfig,
  adoptAgentDeploymentConfig,
  loadAdDetectAgentConfig,
  loadAgentDeploymentConfig,
} from "../packages/config/agent";
import {
  IDENTITY_DATABASE_DIRECTORY_MODE,
  IDENTITY_DATABASE_FILE_MODE,
  IDENTITY_DATABASE_SCHEMA_DATA,
  IDENTITY_DATABASE_SCHEMA_KEY,
} from "../packages/consts/identityStorage";
import {
  DATABASE_DIR,
  IDENTITY_DATABASE_PATH,
} from "../packages/consts/paths";
import { seedStorageDatabase } from "../scripts/fixtures/storageDatabase";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../packages/database/interact/connection";
import { createStorageDatabase } from "../packages/database/interact/migration";
import type { StorageDatabase } from "../packages/types/storageDatabase";

// 每个测试进程用独立数据根创建空库；生产运行期仍只接受迁移脚本建好的数据库。
mkdirSync(DATABASE_DIR, {
  recursive: true,
  mode: IDENTITY_DATABASE_DIRECTORY_MODE,
});
chmodSync(DATABASE_DIR, IDENTITY_DATABASE_DIRECTORY_MODE);
createStorageDatabase(IDENTITY_DATABASE_PATH);
const identityDatabase: StorageDatabase = openStorageDatabase({
  path: IDENTITY_DATABASE_PATH,
});
seedStorageDatabase(identityDatabase, {
  metadata: [{
    key: IDENTITY_DATABASE_SCHEMA_KEY,
    data: IDENTITY_DATABASE_SCHEMA_DATA,
  }],
  whitelist: [],
  blocklist: [],
  removals: [],
});
closeStorageDatabase(identityDatabase);
chmodSync(IDENTITY_DATABASE_PATH, IDENTITY_DATABASE_FILE_MODE);

// agent.json 是唯一不由运行时读盘取得的部署配置：真实进程里主线程解析一次，
// 再经 AI Worker 的 init 与 Anti-Raid Worker 的 agentConfig 消息投递给两条业务
// 线程（见 packages/config/agent.ts 的边界说明）。测试 isolate 收不到那两条
// 消息，因此在这里把同一份 config_example/agent.json adopt 进本 isolate 的
// holder，等价于「快照已经送到」。临时副本里的凭据是测试专用值；需要验证
// 「没配」的用例自行把 holder 置空。
adoptAgentDeploymentConfig(loadAgentDeploymentConfig());
adoptAdDetectAgentConfig(loadAdDetectAgentConfig());

afterAll(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  if (PREVIOUS_DATA_ROOT === undefined) delete process.env[RUNTIME_DATA_ROOT_ENV];
  else process.env[RUNTIME_DATA_ROOT_ENV] = PREVIOUS_DATA_ROOT;
  if (PREVIOUS_CONFIG_ROOT === undefined) delete process.env[CONFIG_ROOT_ENV];
  else process.env[CONFIG_ROOT_ENV] = PREVIOUS_CONFIG_ROOT;
});
