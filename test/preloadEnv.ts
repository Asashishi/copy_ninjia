import { mkdtempSync } from "node:fs";
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

// 在任何生产模块 import 之前切断 state/lock/logs/memory 的默认生产路径。
// 测试仍做真实文件 I/O，只是所有漏注入的写入也只能落到本隔离目录。
process.env[RUNTIME_DATA_ROOT_ENV] = TEST_DATA_ROOT;
// 部署 config/ 不受版本控制；测试和测试 Worker 统一读取只读示例，既保证干净
// 检出可运行，也避免误读或改写开发机上的真实部署配置。
process.env[CONFIG_ROOT_ENV] = join(import.meta.dir, "..", "config_example");
