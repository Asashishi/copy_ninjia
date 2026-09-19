import { expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  AD_SAMPLES_CONFIG_PATH,
  CONFIG_ROOT,
  DATABASE_DIR,
  GOOGLE_AUTH_FILE_PATH,
  IDENTITY_DATABASE_PATH,
  LOCK_FILE_PATH,
  LOGS_DIR,
  JOIN_LOG_MEMORY_DIR,
  MEMORY_DIR,
  MOOD_CONFIG_PATH,
  PROJECT_ROOT,
  RUNTIME_DATA_ROOT,
  STATE_FILE_PATH,
  STICKERS_CONFIG_PATH,
} from "../../packages/consts/paths";
import { TEST_CONFIG_ROOT } from "../preloadEnv";

test("测试环境的真实运行时文件与生产数据根完全隔离", async () => {
  expect(RUNTIME_DATA_ROOT).not.toBe(PROJECT_ROOT);
  for (const path of [
    STATE_FILE_PATH,
    LOCK_FILE_PATH,
    LOGS_DIR,
    MEMORY_DIR,
    DATABASE_DIR,
    IDENTITY_DATABASE_PATH,
    JOIN_LOG_MEMORY_DIR,
  ]) {
    expect(path.startsWith(`${RUNTIME_DATA_ROOT}/`)).toBeTrue();
    expect(path.startsWith(`${PROJECT_ROOT}/`)).toBeFalse();
  }

  const markerName: string = `.test-isolation-${crypto.randomUUID()}`;
  const isolatedMarker: string = join(MEMORY_DIR, markerName);
  const productionMarker: string = join(PROJECT_ROOT, "memory", markerName);
  mkdirSync(MEMORY_DIR, { recursive: true });
  await Bun.write(isolatedMarker, "real test cache");

  expect(await Bun.file(isolatedMarker).text()).toBe("real test cache");
  expect(existsSync(productionMarker)).toBeFalse();
});

test("测试环境的默认部署配置只读取独占临时副本", () => {
  expect(CONFIG_ROOT).toBe(TEST_CONFIG_ROOT);
  for (const path of [
    AD_SAMPLES_CONFIG_PATH,
    MOOD_CONFIG_PATH,
    STICKERS_CONFIG_PATH,
  ]) {
    expect(path.startsWith(`${CONFIG_ROOT}/`)).toBeTrue();
    expect(existsSync(path)).toBeTrue();
  }
  // 翻译凭据与其它部署配置同住 config/；示例目录不带它，副本里自然缺省。
  expect(GOOGLE_AUTH_FILE_PATH).toBe(join(CONFIG_ROOT, "g-auth.json"));
});
