import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_DATA_ROOT_ENV } from "../src/consts/environment";

const previousDataRoot: string | undefined = process.env[RUNTIME_DATA_ROOT_ENV];
const testDataRoot: string = mkdtempSync(join(tmpdir(), "copy-ninjia-test-data-"));

// 在任何生产模块 import 之前切断 state/lock/logs/memory 的默认生产路径。
// 测试仍做真实文件 I/O，只是所有漏注入的写入也只能落到本隔离目录。
process.env[RUNTIME_DATA_ROOT_ENV] = testDataRoot;

afterAll(() => {
  rmSync(testDataRoot, { recursive: true, force: true });
  if (previousDataRoot === undefined) delete process.env[RUNTIME_DATA_ROOT_ENV];
  else process.env[RUNTIME_DATA_ROOT_ENV] = previousDataRoot;
});
