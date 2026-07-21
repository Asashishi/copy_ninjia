import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AI_MEMORY_DIR,
  LOCK_FILE_PATH,
  LOGS_DIR,
  MEMORY_DIR,
  PROJECT_ROOT,
  RUNTIME_DATA_ROOT,
  STATE_FILE_PATH,
} from "../../src/consts/paths";

test("测试环境的真实运行时文件与生产数据根完全隔离", () => {
  expect(RUNTIME_DATA_ROOT).not.toBe(PROJECT_ROOT);
  for (const path of [STATE_FILE_PATH, LOCK_FILE_PATH, LOGS_DIR, MEMORY_DIR, AI_MEMORY_DIR]) {
    expect(path.startsWith(`${RUNTIME_DATA_ROOT}/`)).toBeTrue();
    expect(path.startsWith(`${PROJECT_ROOT}/`)).toBeFalse();
  }

  const markerName: string = `.test-isolation-${randomUUID()}`;
  const isolatedMarker: string = join(AI_MEMORY_DIR, markerName);
  const productionMarker: string = join(PROJECT_ROOT, "memory", "ai", markerName);
  mkdirSync(AI_MEMORY_DIR, { recursive: true });
  writeFileSync(isolatedMarker, "real test cache");

  expect(readFileSync(isolatedMarker, "utf8")).toBe("real test cache");
  expect(existsSync(productionMarker)).toBeFalse();
});
