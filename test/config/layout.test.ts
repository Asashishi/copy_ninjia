import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { rename } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { TEST_DATA_ROOT } from "../preloadEnv";
import { assertDeploymentConfigLayout, assertNoMisplacedConfigFiles } from "../../packages/config/layout";
import { LEGACY_BOT_CONFIG_NAME } from "../../packages/consts/bot";
import { DYNAMIC_CONFIG_DIR_NAME, STATIC_CONFIG_DIR_NAME } from "../../packages/consts/configLayout";
import {
  AD_SAMPLES_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  ASSETS_CONFIG_PATH,
  BOT_CONFIG_PATH,
  CONFIG_ROOT,
  CRON_CONFIG_PATH,
  DYNAMIC_CONFIG_DIR,
  GOOGLE_AUTH_FILE_PATH,
  MOOD_CONFIG_PATH,
  STATIC_CONFIG_DIR,
  STICKERS_CONFIG_PATH,
} from "../../packages/consts/paths";

let root: string;
beforeEach(() => { root = mkdtempSync(join(TEST_DATA_ROOT, "config-layout-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const STATIC_PATHS: readonly string[] = [BOT_CONFIG_PATH, GOOGLE_AUTH_FILE_PATH];
const DYNAMIC_PATHS: readonly string[] = [
  AGENT_CONFIG_PATH,
  ASSETS_CONFIG_PATH,
  AD_SAMPLES_CONFIG_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
  CRON_CONFIG_PATH,
];

test("部署路径常量按生效方式落在 static/ 与 dynamic/ 下", () => {
  expect(STATIC_CONFIG_DIR).toBe(join(CONFIG_ROOT, STATIC_CONFIG_DIR_NAME));
  expect(DYNAMIC_CONFIG_DIR).toBe(join(CONFIG_ROOT, DYNAMIC_CONFIG_DIR_NAME));
  for (const path of STATIC_PATHS) expect(join(STATIC_CONFIG_DIR, basename(path))).toBe(path);
  for (const path of DYNAMIC_PATHS) expect(join(DYNAMIC_CONFIG_DIR, basename(path))).toBe(path);
});

test("各就其位的布局通过；配置根或子目录不存在时视为没有放错", async () => {
  await expect(assertNoMisplacedConfigFiles(join(root, "absent"))).resolves.toBeUndefined();
  for (const path of [...STATIC_PATHS, ...DYNAMIC_PATHS]) {
    const target: string = join(root, relative(CONFIG_ROOT, path));
    mkdirSync(join(target, ".."), { recursive: true });
    await Bun.write(target, "{}");
  }
  await expect(assertNoMisplacedConfigFiles(root)).resolves.toBeUndefined();
});

test.each([...STATIC_PATHS, ...DYNAMIC_PATHS])("%s 平铺在配置根顶层即拒绝，报出归属子目录", async (path: string) => {
  const name: string = basename(path);
  const directory: string = STATIC_PATHS.includes(path) ? STATIC_CONFIG_DIR_NAME : DYNAMIC_CONFIG_DIR_NAME;
  const misplaced: string = join(root, name);
  await Bun.write(misplaced, "secret not read");
  await expect(assertNoMisplacedConfigFiles(root))
    .rejects.toThrow(`${misplaced}: $ must be absent; ${name} belongs in ${directory}/`);
});

test.each([...STATIC_PATHS, ...DYNAMIC_PATHS])("%s 放进另一子目录即拒绝", async (path: string) => {
  const name: string = basename(path);
  const isStatic: boolean = STATIC_PATHS.includes(path);
  const otherDirectory: string = isStatic ? DYNAMIC_CONFIG_DIR_NAME : STATIC_CONFIG_DIR_NAME;
  const misplaced: string = join(root, otherDirectory, name);
  mkdirSync(join(root, otherDirectory));
  await Bun.write(misplaced, "{}");
  await expect(assertNoMisplacedConfigFiles(root)).rejects.toThrow(`${misplaced}: $ must be absent`);
});

test.each(["file", "dangling", "directory"])("配置根顶层的旧 Bot 入口为 %s 时拒绝", async (kind: string) => {
  const legacy: string = join(root, LEGACY_BOT_CONFIG_NAME);
  if (kind === "file") await Bun.write(legacy, "secret not read");
  else if (kind === "directory") mkdirSync(legacy);
  else symlinkSync(join(root, "absent"), legacy);
  await expect(assertNoMisplacedConfigFiles(root))
    .rejects.toThrow(`${legacy}: $ must be absent after explicit cold migration`);
});

test("启动布局检查要求 dynamic/ 是已存在的目录", async () => {
  await expect(assertDeploymentConfigLayout()).resolves.toBeUndefined();
  const moved: string = `${DYNAMIC_CONFIG_DIR}.moved`;
  await rename(DYNAMIC_CONFIG_DIR, moved);
  try {
    await expect(assertDeploymentConfigLayout()).rejects.toThrow(`${DYNAMIC_CONFIG_DIR}: $ must be an existing directory`);
    await Bun.write(DYNAMIC_CONFIG_DIR, "not a directory");
    await expect(assertDeploymentConfigLayout()).rejects.toThrow(`${DYNAMIC_CONFIG_DIR}: $ must be an existing directory`);
  } finally {
    rmSync(DYNAMIC_CONFIG_DIR, { force: true });
    await rename(moved, DYNAMIC_CONFIG_DIR);
  }
});
