import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "../packages/consts/environment";

const previousDataRoot: string | undefined = process.env[RUNTIME_DATA_ROOT_ENV];
const previousConfigRoot: string | undefined = process.env[CONFIG_ROOT_ENV];
const testDataRoot: string = mkdtempSync(join(tmpdir(), "copy-ninjia-test-data-"));
const testConfigRoot: string = join(import.meta.dir, "..", "config_example");
const testEnvironment: Readonly<Record<string, string>> = {
  TELEGRAM_BOT_TOKEN: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
  AI_CHAT_GEMINI_API_KEY: "test-gemini-key",
  AD_DETECT_DEEPSEEK_API_KEY: "test-deepseek-key",
  SUPER_ADMIN_USER_ID: "1",
};
const previousEnvironment = new Map<string, string | undefined>(
  Object.keys(testEnvironment).map((name: string): [string, string | undefined] => [name, process.env[name]])
);

// 在任何生产模块 import 之前切断 state/lock/logs/memory 的默认生产路径。
// 测试仍做真实文件 I/O，只是所有漏注入的写入也只能落到本隔离目录。
process.env[RUNTIME_DATA_ROOT_ENV] = testDataRoot;
// 部署 config/ 不受版本控制；测试和测试 Worker 统一读取只读示例，既保证干净
// 检出可运行，也避免误读或改写开发机上的真实部署配置。
process.env[CONFIG_ROOT_ENV] = testConfigRoot;
// 测试不得隐式读取开发机/部署环境的真实凭据；占位值只满足配置解析，测试
// 清单会另行保证 import 本身不会启动网络或后台任务。
for (const [name, value] of Object.entries(testEnvironment)) process.env[name] = value;

afterAll(() => {
  rmSync(testDataRoot, { recursive: true, force: true });
  if (previousDataRoot === undefined) delete process.env[RUNTIME_DATA_ROOT_ENV];
  else process.env[RUNTIME_DATA_ROOT_ENV] = previousDataRoot;
  if (previousConfigRoot === undefined) delete process.env[CONFIG_ROOT_ENV];
  else process.env[CONFIG_ROOT_ENV] = previousConfigRoot;
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
