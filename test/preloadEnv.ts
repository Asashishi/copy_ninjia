import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "../packages/consts/environment";

/**
 * 测试进程的路径注入，必须先于任何会求值 consts/paths 的生产模块完成。
 *
 * 单独成文件而不是写在 preload.ts 顶部：ESM 里 import 一律先于同文件的语句
 * 求值，preload.ts 只要静态 import 了任何生产模块，写在文件里的赋值就已经晚
 * 了一步——CONFIG_ROOT 会指向开发机上的真实部署目录。改用 `await import()`
 * 同样不行：Bun 的 preload 不等待顶层 await 的续体，测试文件会先跑起来。
 */

/** 进程原有的两个根目录设置；preload 的 afterAll 负责还原。 */
export const PREVIOUS_DATA_ROOT: string | undefined = process.env[RUNTIME_DATA_ROOT_ENV];
export const PREVIOUS_CONFIG_ROOT: string | undefined = process.env[CONFIG_ROOT_ENV];

/** 本次测试进程独占的运行时数据根；afterAll 整棵删掉。 */
export const TEST_DATA_ROOT: string = mkdtempSync(join(tmpdir(), "copy-ninjia-test-data-"));

/** 本次测试进程独占的部署配置根；示例占位凭据只在这份副本里替换。 */
export const TEST_CONFIG_ROOT: string = join(TEST_DATA_ROOT, "config");

const CONFIG_EXAMPLE_ROOT: string = join(import.meta.dir, "..", "config_example");
cpSync(CONFIG_EXAMPLE_ROOT, TEST_CONFIG_ROOT, { recursive: true });
const TEST_AGENT_CONFIG_PATH: string = join(TEST_CONFIG_ROOT, "agent.json");
const TEST_AGENT_CONFIG: string = readFileSync(TEST_AGENT_CONFIG_PATH, "utf8").replace(
  /replace-with-([a-z]+)-api-key/g,
  "test-only-$1-api-key"
);
writeFileSync(TEST_AGENT_CONFIG_PATH, TEST_AGENT_CONFIG, { mode: 0o600 });
const TEST_TELEGRAM_CONFIG_PATH: string = join(TEST_CONFIG_ROOT, "telegram.json");
const TEST_TELEGRAM_CONFIG: string = readFileSync(TEST_TELEGRAM_CONFIG_PATH, "utf8").replace(
  "replace-with-telegram-bot-token",
  "123456789:test-only-telegram-bot-token"
);
writeFileSync(TEST_TELEGRAM_CONFIG_PATH, TEST_TELEGRAM_CONFIG, { mode: 0o600 });

// 在任何生产模块 import 之前切断 state/lock/logs/memory 的默认生产路径。
// 测试仍做真实文件 I/O，只是所有漏注入的写入也只能落到本隔离目录。
process.env[RUNTIME_DATA_ROOT_ENV] = TEST_DATA_ROOT;
// 部署 config/ 不受版本控制；测试和测试 Worker 统一读取独占临时副本，既避免
// 占位凭据被严格解析器接受，也不会误读或改写开发机上的真实部署配置。
process.env[CONFIG_ROOT_ENV] = TEST_CONFIG_ROOT;
