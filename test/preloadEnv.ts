import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DYNAMIC_CONFIG_DIR_NAME, STATIC_CONFIG_DIR_NAME } from "../packages/consts/configLayout";
import {
  CONFIG_ROOT_ENV,
  RUNTIME_DATA_ROOT_ENV,
} from "../packages/consts/environment";

/**
 * 测试进程的路径注入，先于任何会求值 consts/paths 的生产模块完成。
 *
 * 单独成文件，不写在 preload.ts 顶部：ESM 里 import 一律先于同文件的语句求值，
 * preload.ts 静态 import 任何生产模块都会让文件里的赋值晚一步，
 * CONFIG_ROOT 会指向开发机上的真实部署目录。
 *
 * 本文件整段同步完成：它是 preload.ts 的第一个静态 import，带顶层 await 的模块
 * 不会在同级后续 import 求值之前结束。preload.ts 自己的顶层 await 没有这个问题：
 * Bun 会等那一层续体跑完再开始跑测试文件。
 */

/** 进程原有的两个根目录设置；preload 的 afterAll 负责还原。 */
export const PREVIOUS_DATA_ROOT: string | undefined = process.env[RUNTIME_DATA_ROOT_ENV];
export const PREVIOUS_CONFIG_ROOT: string | undefined = process.env[CONFIG_ROOT_ENV];

/** 测试进程独占的数据根；模块加载时创建的临时目录放在其下，由 preload 的全局 afterAll 整棵删除。 */
export const TEST_DATA_ROOT: string = mkdtempSync(join(tmpdir(), "copy-ninjia-test-data-"));

/** 本次测试进程独占的部署配置根；示例占位凭据只在这份副本里替换。 */
export const TEST_CONFIG_ROOT: string = join(TEST_DATA_ROOT, "config");

const CONFIG_EXAMPLE_ROOT: string = join(import.meta.dir, "..", "config_example");
cpSync(CONFIG_EXAMPLE_ROOT, TEST_CONFIG_ROOT, { recursive: true });
const TEST_STATIC_CONFIG_DIR: string = join(TEST_CONFIG_ROOT, STATIC_CONFIG_DIR_NAME);
const TEST_DYNAMIC_CONFIG_DIR: string = join(TEST_CONFIG_ROOT, DYNAMIC_CONFIG_DIR_NAME);
// 翻译凭据示例的占位私钥必然被严格解析拒绝；副本与安装器一样不带它，翻译可用性
// 由 preload 与各用例自行设定。
rmSync(join(TEST_STATIC_CONFIG_DIR, "g-auth.json"));
// 定时任务示例只示意用法：会话 id、地址与本地路径都是假的。副本换成空任务表，
// 需要任务的用例自行写入。
writeFileSync(join(TEST_DYNAMIC_CONFIG_DIR, "cron.json"), "[]\n");
const TEST_AGENT_CONFIG_PATH: string = join(TEST_DYNAMIC_CONFIG_DIR, "agent.json");
const TEST_AGENT_CONFIG: string = readFileSync(TEST_AGENT_CONFIG_PATH, "utf8").replace(
  /replace-with-([a-z]+)-api-key/g,
  "test-only-$1-api-key"
);
writeFileSync(TEST_AGENT_CONFIG_PATH, TEST_AGENT_CONFIG, { mode: 0o600 });
const TEST_BOT_CONFIG_PATH: string = join(TEST_STATIC_CONFIG_DIR, "bot.json");
const TEST_BOT_CONFIG: string = readFileSync(TEST_BOT_CONFIG_PATH, "utf8").replace(
  "replace-with-telegram-bot-token",
  "123456789:test-only-telegram-bot-token"
);
writeFileSync(TEST_BOT_CONFIG_PATH, TEST_BOT_CONFIG, { mode: 0o600 });

// 在任何生产模块 import 之前切断 state/lock/logs/memory 的默认生产路径。
// 测试仍做真实文件 I/O，只是所有漏注入的写入也只能落到本隔离目录。
process.env[RUNTIME_DATA_ROOT_ENV] = TEST_DATA_ROOT;
// 部署 config/ 不受版本控制；测试和测试 Worker 统一读取独占临时副本，不读也不改开发机上的真实部署配置。
process.env[CONFIG_ROOT_ENV] = TEST_CONFIG_ROOT;
