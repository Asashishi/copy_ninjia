import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { loadCronConfig, parseCronConfig } from "../../packages/config/cron";
import { CRON_CONFIG_PATH, CRON_FILES_ROOT } from "../../packages/consts/paths";
import type { CronConfig } from "../../packages/types/cron";

const PATH: string = "/virtual/cron.json";

/** 一个最小合法任务，按需覆盖字段。 */
function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "daily",
    chat_id: -1001,
    cron: "0 9 * * *",
    actions: [{ type: "send_message", payload: { content: "hi" } }],
    ...overrides,
  };
}

function rejects(value: unknown, message: string): void {
  expect(() => parseCronConfig(value, PATH)).toThrow(message);
}

afterEach(() => {
  rmSync(CRON_FILES_ROOT, { recursive: true, force: true });
  rmSync(CRON_CONFIG_PATH, { force: true });
});

describe("parseCronConfig", () => {
  test("空数组合法；可选字段缺省按从没设过填齐", () => {
    expect(parseCronConfig([], PATH)).toEqual([]);
    expect(parseCronConfig([task()], PATH)).toEqual([{
      name: "daily",
      chatId: -1001,
      messageThreadId: undefined,
      cron: "0 9 * * *",
      timeZone: "Asia/Tokyo",
      randomInterval: undefined,
      justOnce: false,
      actions: [{ type: "send_message", content: "hi" }],
    }]);
  });

  test("完整任务：话题、时区、区间与三种动作的来源", () => {
    const config: CronConfig = parseCronConfig([task({
      message_thread_id: 12,
      tz: "UTC",
      rand_cron: "6h-24h",
      actions: [
        { type: "send_image", payload: { content: "今日图", rand_image: true } },
        { type: "send_image", payload: { rand_image: true, path: "daily" } },
        { type: "send_image", payload: { rand_image: true, path: "." } },
        { type: "send_image", payload: { url: "https://example.com/a.png" } },
        { type: "send_file", payload: { content: "周报", path: "reports/w.pdf" } },
        { type: "send_file", payload: { url: "http://example.com/r.zip" } },
      ],
    })], PATH);
    expect(config[0]).toMatchObject({
      messageThreadId: 12,
      timeZone: "UTC",
      randomInterval: { minMs: 6 * 3_600_000, maxMs: 24 * 3_600_000 },
    });
    expect(config[0]!.actions).toEqual([
      { type: "send_image", content: "今日图", source: { kind: "random", directory: null } },
      { type: "send_image", content: undefined, source: { kind: "random", directory: join(CRON_FILES_ROOT, "daily") } },
      { type: "send_image", content: undefined, source: { kind: "random", directory: CRON_FILES_ROOT } },
      { type: "send_image", content: undefined, source: { kind: "url", url: "https://example.com/a.png" } },
      { type: "send_file", content: "周报", source: { kind: "path", path: join(CRON_FILES_ROOT, "reports", "w.pdf") } },
      { type: "send_file", content: undefined, source: { kind: "url", url: "http://example.com/r.zip" } },
    ]);
  });

  test("rand_cron 单值等于 1m-<值>，区间落在 1m-24d 且 min <= max", () => {
    expect(parseCronConfig([task({ rand_cron: "24h" })], PATH)[0]!.randomInterval)
      .toEqual({ minMs: 60_000, maxMs: 24 * 3_600_000 });
    expect(parseCronConfig([task({ rand_cron: "1m-24d" })], PATH)[0]!.randomInterval)
      .toEqual({ minMs: 60_000, maxMs: 24 * 86_400_000 });
    for (const value of ["25d", "30s", "0m", "2h-1h", "1h-2h-3h", "1.5h", 60, "01h"]) {
      rejects([task({ rand_cron: value })], `${PATH}: $[0].rand_cron must be`);
    }
  });

  test("just_once 与 rand_cron 互斥", () => {
    rejects([task({ just_once: true, rand_cron: "1h" })], `${PATH}: $[0].just_once must be false or absent when rand_cron is set.`);
    expect(parseCronConfig([task({ just_once: false, rand_cron: "1h" })], PATH)[0]!.justOnce).toBe(false);
  });

  test("cron 与 tz 由 Bun.cron.parse 判定，不可能的日期同样拒绝", () => {
    rejects([task({ cron: "61 * * * *" })], "$[0].cron must be a 5-field cron expression");
    rejects([task({ cron: "0 0 30 2 *" })], "$[0].cron must be a 5-field cron expression");
    rejects([task({ tz: "Mars/Olympus" })], "$[0].tz must be an IANA time zone name");
    // 显式写出的 null 不是「缺省」，不能静默换成默认时区。
    rejects([task({ tz: null })], "$[0].tz must be an IANA time zone name");
    expect(parseCronConfig([task({ cron: "@daily" })], PATH)[0]!.cron).toBe("@daily");
  });

  test("顶层、任务与动作的形态、上限和唯一名都严格判定", () => {
    rejects({}, "$ must be an array with at most 128 tasks");
    rejects(Array.from({ length: 129 }, (_: unknown, index: number) => task({ name: `t${index}` })), "$ must be an array");
    rejects([task({ extra: 1 })], "$[0] must be {");
    rejects([task({ name: " " })], "$[0].name must be a non-empty string of at most 64 characters");
    rejects([task({ name: "x".repeat(65) })], "$[0].name must be");
    rejects([task(), task()], "$[1].name must be unique across tasks");
    rejects([task({ chat_id: 0 })], "$[0].chat_id must be a non-zero safe integer chat id");
    rejects([task({ chat_id: "1" })], "$[0].chat_id must be");
    rejects([task({ message_thread_id: 0 })], "$[0].message_thread_id must be a positive safe integer");
    rejects([task({ actions: [] })], "$[0].actions must be a non-empty array with at most 16 actions");
    rejects([task({ actions: Array.from({ length: 17 }, () => ({ type: "send_message", payload: { content: "x" } })) })], "$[0].actions must be");
    rejects([task({ actions: [{ type: "send_video", payload: {} }] })], "$[0].actions[0].type must be send_message, send_image or send_file");
    rejects([task({ actions: [{ type: "send_message", payload: { content: "" } }] })], "$[0].actions[0].payload.content must be");
    rejects([task({ actions: [{ type: "send_message", payload: { content: "x".repeat(4097) } }] })], "$[0].actions[0].payload.content must be a non-empty string of at most 4096 characters");
    rejects([task({ actions: [{ type: "send_file", payload: { content: "x".repeat(1025), url: "https://e.com/f" } }] })], "$[0].actions[0].payload.content must be a non-empty string of at most 1024 characters");
  });

  test("来源组合：恰好一个 url 或 path；rand_image 只用于图片且不配 url", () => {
    const message = (payload: Record<string, unknown>, type: string = "send_image"): unknown => [task({ actions: [{ type, payload }] })];
    rejects(message({}), "$[0].actions[0].payload must be exactly one of url or path");
    rejects(message({ url: "https://e.com/a.png", path: "a.png" }), "$[0].actions[0].payload must be exactly one of url or path");
    rejects(message({ rand_image: true, url: "https://e.com/a.png" }), "$[0].actions[0].payload.url must be absent when rand_image is true");
    rejects(message({ rand_image: true, path: "a.png" }, "send_file"), "$[0].actions[0].payload must be { content?, url?, path? }");
    rejects(message({ rand_image: "yes", url: "https://e.com/a.png" }), "$[0].actions[0].payload.rand_image must be a boolean");
    rejects(message({ url: "ftp://e.com/a.png" }), "$[0].actions[0].payload.url must be an absolute http(s) URL");
    rejects(message({ url: "e.com/a.png" }), "$[0].actions[0].payload.url must be an absolute http(s) URL");
  });

  test("path 只接受 cron_files 下的相对路径；只有随机目录能写 \".\"", () => {
    const image = (payload: Record<string, unknown>): unknown => [task({ actions: [{ type: "send_image", payload }] })];
    for (const path of ["/etc/passwd", "../telegram.json", "a/../../x.png", "", "."]) {
      rejects(image({ path }), "$[0].actions[0].payload.path must be a relative path inside config/cron_files");
    }
    rejects(image({ rand_image: true, path: "../images" }), "$[0].actions[0].payload.path must be a relative path inside config/cron_files (\".\" for the directory itself)");
  });
});

describe("loadCronConfig", () => {
  test("本地文件与目录必须真实存在且类型相符", async () => {
    mkdirSync(join(CRON_FILES_ROOT, "daily"), { recursive: true });
    await Bun.write(join(CRON_FILES_ROOT, "report.pdf"), "pdf");
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({
      actions: [
        { type: "send_file", payload: { path: "report.pdf" } },
        { type: "send_image", payload: { rand_image: true, path: "daily" } },
      ],
    })]));
    expect((await loadCronConfig())[0]!.actions).toHaveLength(2);

    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_file", payload: { path: "daily" } }] })]));
    await expect(loadCronConfig()).rejects.toThrow(
      `${CRON_CONFIG_PATH}: $[0].actions[0].payload.path must be an existing regular file inside config/cron_files.`
    );
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_image", payload: { rand_image: true, path: "report.pdf" } }] })]));
    await expect(loadCronConfig()).rejects.toThrow("$[0].actions[0].payload.path must be an existing directory inside config/cron_files.");
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_file", payload: { path: "missing.pdf" } }] })]));
    await expect(loadCronConfig()).rejects.toThrow("$[0].actions[0].payload.path must be an existing regular file");
  });

  test("经符号链接逃出 cron_files 的路径拒绝", async () => {
    mkdirSync(CRON_FILES_ROOT, { recursive: true });
    symlinkSync(CRON_CONFIG_PATH, join(CRON_FILES_ROOT, "escape.json"));
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_file", payload: { path: "escape.json" } }] })]));
    await expect(loadCronConfig()).rejects.toThrow("$[0].actions[0].payload.path must be an existing regular file inside config/cron_files.");
  });

  test("不用本地来源时 cron_files 目录可以不存在；非法 JSON 拒绝", async () => {
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_image", payload: { url: "https://e.com/a.png" } }] })]));
    expect(await loadCronConfig()).toHaveLength(1);
    await Bun.write(CRON_CONFIG_PATH, "[ // comment\n]");
    await expect(loadCronConfig()).rejects.toThrow(`${CRON_CONFIG_PATH}: $ must be a readable valid JSON document.`);
  });
});
