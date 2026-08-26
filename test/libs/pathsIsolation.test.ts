import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AD_SAMPLES_CONFIG_PATH,
  AI_MEMORY_DIR,
  CONFIG_ROOT,
  DATABASE_DIR,
  IDENTITY_DATABASE_PATH,
  LOCK_FILE_PATH,
  LOGS_DIR,
  JOIN_LOG_MEMORY_DIR,
  MEMORY_DIR,
  MOOD_CONFIG_PATH,
  PROJECT_ROOT,
  REACTIONS_CONFIG_PATH,
  RUNTIME_DATA_ROOT,
  STATE_FILE_PATH,
  STICKERS_CONFIG_PATH,
} from "../../packages/consts/paths";

test("测试环境的真实运行时文件与生产数据根完全隔离", () => {
  expect(RUNTIME_DATA_ROOT).not.toBe(PROJECT_ROOT);
  for (const path of [
    STATE_FILE_PATH,
    LOCK_FILE_PATH,
    LOGS_DIR,
    MEMORY_DIR,
    DATABASE_DIR,
    IDENTITY_DATABASE_PATH,
    AI_MEMORY_DIR,
    JOIN_LOG_MEMORY_DIR,
  ]) {
    expect(path.startsWith(`${RUNTIME_DATA_ROOT}/`)).toBeTrue();
    expect(path.startsWith(`${PROJECT_ROOT}/`)).toBeFalse();
  }

  const markerName: string = `.test-isolation-${crypto.randomUUID()}`;
  const isolatedMarker: string = join(AI_MEMORY_DIR, markerName);
  const productionMarker: string = join(PROJECT_ROOT, "memory", "ai", markerName);
  mkdirSync(AI_MEMORY_DIR, { recursive: true });
  writeFileSync(isolatedMarker, "real test cache");

  expect(readFileSync(isolatedMarker, "utf8")).toBe("real test cache");
  expect(existsSync(productionMarker)).toBeFalse();
});

test("测试环境的默认部署配置只读取受版本控制的示例目录", () => {
  expect(CONFIG_ROOT).toBe(join(PROJECT_ROOT, "config_example"));
  for (const path of [
    AD_SAMPLES_CONFIG_PATH,
    MOOD_CONFIG_PATH,
    REACTIONS_CONFIG_PATH,
    STICKERS_CONFIG_PATH,
  ]) {
    expect(path.startsWith(`${CONFIG_ROOT}/`)).toBeTrue();
    expect(existsSync(path)).toBeTrue();
  }
});
