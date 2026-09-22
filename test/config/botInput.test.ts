import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { TEST_DATA_ROOT } from "../preloadEnv";
import { loadBotConfig } from "../../packages/config/botInput";
import { loadInstallerBotAtmosphere, validateStagedBotConfig } from "../../scripts/install/runtime";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../../packages/consts/telegram";

let root: string;
const identity = { bot_token: "123:secret", super_admin_user_id: 7 };
beforeEach(() => { root = mkdtempSync(join(TEST_DATA_ROOT, "bot-input-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test("当前配置异步加载，普通风格保留；缺少 bot 文件不能使用旧入口", async () => {
  const path: string = join(root, "bot.json");
  await Bun.write(path, JSON.stringify({ ...identity, atmosphere: "normal" }));
  expect((await loadBotConfig(path)).atmosphere).toBe("normal");
  expect(await loadInstallerBotAtmosphere(path)).toBe("normal");
  await Bun.file(path).delete();
  await expect(loadBotConfig(path)).rejects.toThrow(`${path}: $ must be a readable valid JSON document`);
});

test.each(["file", "dangling", "directory"])("旧入口为 %s 时，即便 bot.json 已存在也拒绝", async (kind) => {
  const legacy: string = join(root, "telegram.json");
  const path: string = join(root, "bot.json");
  await Bun.write(path, JSON.stringify(identity));
  if (kind === "file") await Bun.write(legacy, "secret not read");
  else if (kind === "directory") mkdirSync(legacy);
  else symlinkSync(join(root, "absent"), legacy);
  await expect(loadBotConfig(path)).rejects.toThrow(`${legacy}: $ must be absent after explicit cold migration`);
  await expect(loadInstallerBotAtmosphere(path)).rejects.toThrow("explicit cold migration");
});

test("安装问卷允许示例 token 待填写，同时严格保留或拒绝已有风格", async () => {
  const path: string = join(root, "bot.json");
  await Bun.write(path, JSON.stringify({ ...identity, bot_token: TELEGRAM_BOT_TOKEN_PLACEHOLDER, atmosphere: "normal" }));
  expect(await loadInstallerBotAtmosphere(path)).toBe("normal");
  await expect(loadBotConfig(path)).rejects.toThrow("non-placeholder");
  for (const value of [{ ...identity, atmosphere: null }, { ...identity, bot_token: "" }, null]) {
    await Bun.write(path, JSON.stringify(value));
    await expect(loadInstallerBotAtmosphere(path)).rejects.toThrow();
  }
});

test("候选文件只校验内容，不检查其目录的旧入口，非法内容仍拒绝且不覆盖原件", async (): Promise<void> => {
  const original: string = join(root, "telegram.json");
  const staged: string = join(root, ".telegram.json.install.test");
  const content: string = JSON.stringify({ ...identity, atmosphere: "normal" });
  await Bun.write(original, content);
  await Bun.write(staged, content);
  await expect(validateStagedBotConfig(staged)).resolves.toBeUndefined();
  for (const invalid of [
    "{broken secret", new Uint8Array([0xff]),
    JSON.stringify({ ...identity, atmosphere: null }),
    JSON.stringify({ ...identity, super_admin_user_id: 0 }),
    JSON.stringify({ ...identity, bot_token: TELEGRAM_BOT_TOKEN_PLACEHOLDER }),
  ]) {
    await Bun.write(staged, invalid);
    await expect(validateStagedBotConfig(staged)).rejects.toThrow(staged);
  }
  await Bun.file(staged).delete();
  await expect(validateStagedBotConfig(staged)).rejects.toThrow("readable valid JSON document");
  expect(await Bun.file(original).text()).toBe(content);
});
