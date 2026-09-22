import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { TEST_DATA_ROOT } from "../preloadEnv";
import { prepareBotConfigMigration } from "../../scripts/migrateBotConfig";
import { readBotMigrationFile } from "../../scripts/migrations/botConfig/files";
import * as atomicFile from "../../packages/libs/atomicFile";
import type { BotConfigMigrationOptions, BotConfigMigrationResult } from "../../scripts/migrateBotConfig";
import type { BotMigrationFile } from "../../scripts/migrations/botConfig/files";
import { googleAuthFixture } from "../../scripts/fixtures/googleAuth";

let root: string;
let options: BotConfigMigrationOptions;
const identity: Readonly<Record<string, unknown>> = { bot_token: "123:secret-fixture", super_admin_user_id: 7 };
const state: Readonly<Record<string, unknown>> = {
  global: { copy: { copiedUser: null, lastCopyTime: 12 }, assets: { randomImageDir: "../old gallery", fortuneThumbnailUrl: "https://example.com/a" } },
  translate: { "-1001": [{ translatedUser: { id: 7, first_name: "user" }, language: "en" }] },
};

beforeEach(async () => {
  root = await mkdtemp(join(TEST_DATA_ROOT, "bot-migration-"));
  options = { sourceConfigRoot: join(root, "config backup"), sourceDataRoot: join(root, "data backup"), outputRoot: join(root, "output") };
  await mkdir(options.sourceConfigRoot);
  await mkdir(options.sourceDataRoot);
  await Bun.write(join(options.sourceConfigRoot, "telegram.json"), JSON.stringify(identity));
  await Bun.write(join(options.sourceDataRoot, "state.json"), JSON.stringify(state));
  await Bun.write(join(options.sourceDataRoot, "state.json.bak"), JSON.stringify({ global: { copy: { copiedUser: null }, assets: { randomImageDir: "/h_image" } } }));
});
afterEach(async () => {
  mock.restore();
  await rm(root, { recursive: true, force: true });
});

test("分离备份根、主备分别转换，其他状态、路径、源字节和权限不变", async () => {
  const config: string = join(options.sourceConfigRoot, "telegram.json");
  await chmod(config, 0o400);
  const before = await readBotMigrationFile(config);
  const result = await prepareBotConfigMigration(options);
  expect(await readBotMigrationFile(config)).toEqual(before);
  expect(await Bun.file(join(options.outputRoot, "config/bot.json")).json()).toEqual({ ...identity, atmosphere: "mesugaki" });
  expect(await Bun.file(join(options.outputRoot, "data/state.json")).json()).toEqual({
    global: { copy: { copiedUser: null, lastCopyTime: 12 }, assets: { randomHImageDir: "../old gallery", fortuneThumbnailUrl: "https://example.com/a" } },
    translate: state.translate,
  });
  expect((await Bun.file(join(options.outputRoot, "data/state.json.bak")).json()).global.assets.randomHImageDir).toBe("/h_image");
  expect(result.mappings).toHaveLength(3);
  expect(result.outputFiles.every((file) => file.mode === 0o600)).toBeTrue();
  expect(await Bun.file(join(options.outputRoot, "incomplete.json")).exists()).toBeFalse();
  const manifest: string = await Bun.file(join(options.outputRoot, "ready.json")).text();
  expect(manifest).not.toContain("123:secret-fixture");
  expect(manifest).not.toContain("../old gallery");
});

test("cron 固定图片标量转换，随机目录与 send_file 保持原样", async () => {
  const task = { name: "daily", chat_id: [7], cron: "@daily", actions: [
    { type: "send_image", payload: { url: "https://e.com/a.png", content: "one", is_blurred: true } },
    { type: "send_image", payload: { path: "./a.png", rand_image: false } },
    { type: "send_image", payload: { path: "./gallery", rand_image: true } },
    { type: "send_image", payload: { rand_image: true } },
    { type: "send_file", payload: { path: "./a.pdf" } },
  ] };
  await Bun.write(join(options.sourceConfigRoot, "cron.json"), JSON.stringify([task]));
  await prepareBotConfigMigration(options);
  const migrated = await Bun.file(join(options.outputRoot, "config/cron.json")).json();
  expect(migrated[0].actions[0].payload.url).toEqual(["https://e.com/a.png"]);
  expect(migrated[0].actions[1].payload.path).toEqual(["./a.png"]);
  expect(migrated[0].actions.slice(2)).toEqual(task.actions.slice(2));
});

test.each(["identity", "state", "backup", "cron", "utf8", "json", "current", "mixed", "newCron"])("非法 %s 拒绝，源保持不变，未发布完成标记", async (kind) => {
  let path: string = join(options.sourceDataRoot, "state.json");
  let value: unknown = { globalCopy: {} };
  if (kind === "identity") { path = join(options.sourceConfigRoot, "telegram.json"); value = { ...identity, atmosphere: "normal" }; }
  if (kind === "backup") path = join(options.sourceDataRoot, "state.json.bak");
  if (kind === "cron" || kind === "newCron") {
    path = join(options.sourceConfigRoot, "cron.json");
    value = kind === "cron" ? [{}] : [{ name: "daily", chat_id: [7], cron: "@daily", actions: [{ type: "send_image", payload: { url: ["https://e.com/a.png"] } }] }];
  }
  if (kind === "current") { path = join(options.sourceConfigRoot, "bot.json"); value = identity; }
  if (kind === "mixed") value = { global: { copy: { copiedUser: null }, assets: { randomImageDir: "./images", randomHImageDir: "./h_image" } } };
  await Bun.write(path, kind === "utf8" ? new Uint8Array([0xff]) : kind === "json" ? "{broken secret" : JSON.stringify(value));
  const before = await readBotMigrationFile(path);
  await expect(prepareBotConfigMigration(options)).rejects.toThrow();
  expect(await readBotMigrationFile(path)).toEqual(before);
  expect(await Bun.file(join(options.outputRoot, "ready.json")).exists()).toBeFalse();
});

test("可选文件缺省不创建；已迁移或缺少身份文件不能当作源", async () => {
  for (const name of ["state.json", "state.json.bak"]) await Bun.file(join(options.sourceDataRoot, name)).delete();
  const result = await prepareBotConfigMigration(options);
  expect(result.mappings).toHaveLength(1);
  await Bun.file(join(options.sourceConfigRoot, "telegram.json")).delete();
  await expect(prepareBotConfigMigration({ ...options, outputRoot: join(root, "retry") })).rejects.toThrow("a readable source configuration");
});

test.each(["", "\uFEFF"])("显式迁移独立项目根的 Google 凭据，保留原文、源权限和链接拓扑（BOM=%j）", async (prefix: string): Promise<void> => {
  const target: string = join(root, "credentials.json");
  const sourceGoogleAuth: string = join(root, "g-auth.json");
  const content: string = prefix + await googleAuthFixture();
  await Bun.write(target, content);
  await chmod(target, 0o400);
  await symlink(target, sourceGoogleAuth);
  const before: BotMigrationFile | null = await readBotMigrationFile(sourceGoogleAuth);
  const result: BotConfigMigrationResult = await prepareBotConfigMigration({ ...options, sourceGoogleAuth });
  const output: BotMigrationFile | null = await readBotMigrationFile(join(options.outputRoot, "config/g-auth.json"));
  expect(output?.sha256).toBe(before?.sha256);
  expect(output?.mode).toBe(0o600);
  expect(await readBotMigrationFile(sourceGoogleAuth)).toEqual(before);
  expect(result.mappings.at(-1)?.source ?? null).toEqual(before);
  expect(await Bun.file(join(options.outputRoot, "ready.json")).text()).not.toContain("PRIVATE KEY");
});

test.each(["missing", "invalid", "conflict"])("凭据输入 %s 拒绝完成，源与冲突文件不变", async (kind: string): Promise<void> => {
  const sourceGoogleAuth: string = join(root, "g-auth.json");
  if (kind !== "missing") await Bun.write(sourceGoogleAuth, '{"private_key":"private_marker"}');
  const current: string = join(options.sourceConfigRoot, "g-auth.json");
  if (kind === "conflict") await Bun.write(current, "preserve existing config credentials");
  const before: BotMigrationFile | null = await readBotMigrationFile(sourceGoogleAuth);
  const conflict: BotMigrationFile | null = await readBotMigrationFile(current);
  await expect(prepareBotConfigMigration({ ...options, sourceGoogleAuth })).rejects.toThrow();
  expect(await readBotMigrationFile(sourceGoogleAuth)).toEqual(before);
  expect(await readBotMigrationFile(current)).toEqual(conflict);
  expect(await Bun.file(join(options.outputRoot, "ready.json")).exists()).toBeFalse();
});

test("有效文件链接和只读目标保持拓扑；悬空链接拒绝", async () => {
  const path: string = join(options.sourceConfigRoot, "telegram.json");
  const target: string = join(root, "identity target.json");
  await Bun.write(target, Bun.file(path));
  await Bun.file(path).delete();
  await symlink(target, path);
  const before = await readBotMigrationFile(path);
  const result = await prepareBotConfigMigration(options);
  expect(result.mappings[0]!.source.linkTarget).toBe(target);
  expect(await readBotMigrationFile(path)).toEqual(before);
  await Bun.file(target).delete();
  await expect(prepareBotConfigMigration({ ...options, outputRoot: join(root, "retry") })).rejects.toThrow("valid symbolic-link topology");
});

test("输出与任何源根互相包含时拒绝，已有输出不覆盖", async () => {
  for (const outputRoot of [options.sourceConfigRoot, join(options.sourceDataRoot, "output"), root]) {
    await expect(prepareBotConfigMigration({ ...options, outputRoot })).rejects.toThrow("outside both source directories");
  }
  await mkdir(options.outputRoot);
  await Bun.write(join(options.outputRoot, "incomplete.json"), "preserve");
  await expect(prepareBotConfigMigration(options)).rejects.toThrow();
  expect(await Bun.file(join(options.outputRoot, "incomplete.json")).text()).toBe("preserve");
  await expect(prepareBotConfigMigration({ ...options, outputRoot: join(root, "retry") })).resolves.toBeDefined();
});

test("写入中断保留 incomplete；源在转换期间改变则拒绝 ready", async () => {
  const original = atomicFile.atomicWriteText;
  const write = spyOn(atomicFile, "atomicWriteText").mockImplementation(async (path, text, mode) => {
    if (path.endsWith("bot.json")) throw new Error("injected write failure");
    return original(path, text, mode);
  });
  await expect(prepareBotConfigMigration(options)).rejects.toThrow("injected write failure");
  expect(await Bun.file(join(options.outputRoot, "incomplete.json")).exists()).toBeTrue();
  write.mockImplementation(async (path, text, mode) => {
    await original(path, text, mode);
    if (path.endsWith("bot.json")) await Bun.write(join(options.sourceConfigRoot, "telegram.json"), JSON.stringify({ ...identity, super_admin_user_id: 8 }));
  });
  const outputRoot: string = join(root, "retry");
  await expect(prepareBotConfigMigration({ ...options, outputRoot })).rejects.toThrow("unchanged cold backup");
  expect(await Bun.file(join(outputRoot, "ready.json")).exists()).toBeFalse();
});

test("CLI 帮助和参数拒绝不依赖 Bot 配置，也不泄露输入正文", () => {
  for (const args of [["--help"], [], ["--unknown", "secret"], ["--source-config-root", "a", "--source-config-root", "b"]]) {
    const result = Bun.spawnSync({ cmd: [Bun.argv[0]!, "scripts/migrateBotConfig.ts", ...args], env: { PATH: "/usr/bin:/bin", COPY_NINJIA_CONFIG_ROOT: join(root, "absent"), COPY_NINJIA_DATA_ROOT: root }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode === 0).toBe(args[0] === "--help");
    expect(new TextDecoder().decode(result.stderr)).not.toContain("secret");
  }
});
