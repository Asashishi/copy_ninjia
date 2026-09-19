import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { loadCronConfig, parseCronConfig } from "../../packages/config/cron";
import { CRON_CONFIG_PATH, PROJECT_ROOT } from "../../packages/consts/paths";
import type { CronConfig } from "../../packages/types/cron";
import { TEST_DATA_ROOT } from "../preloadEnv";

const PATH: string = "/virtual/cron.json";
/** 本地来源的测试目录；cron.json 的 path 可以是本机任意绝对路径或相对项目根的路径。 */
const FILES_ROOT: string = join(TEST_DATA_ROOT, "cron-files");

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
  rmSync(FILES_ROOT, { recursive: true, force: true });
  rmSync(CRON_CONFIG_PATH, { force: true });
});

describe("parseCronConfig", () => {
  test("空数组合法；可选字段缺省按从没设过填齐", () => {
    expect(parseCronConfig([], PATH)).toEqual([]);
    expect(parseCronConfig([task()], PATH)).toEqual([{
      name: "daily",
      chatId: -1001,
      cron: "0 9 * * *",
      timeZone: "Asia/Tokyo",
      randomInterval: undefined,
      justOnce: false,
      actions: [{ type: "send_message", content: "hi" }],
    }]);
  });

  test("完整任务：时区、区间与三种动作的来源", () => {
    const config: CronConfig = parseCronConfig([task({
      time_zone: "UTC",
      rand_cron: "6h-24h",
      actions: [
        { type: "send_image", payload: { content: "今日图", rand_image: true } },
        { type: "send_image", payload: { rand_image: true, path: "/srv/gallery/daily" } },
        { type: "send_image", payload: { rand_image: true, path: "/srv/gallery/../albums/" } },
        { type: "send_image", payload: { url: "https://example.com/a.png" } },
        { type: "send_file", payload: { content: "周报", path: "/srv/reports/w.pdf" } },
        { type: "send_file", payload: { url: "http://example.com/r.zip" } },
      ],
    })], PATH);
    expect(config[0]).toMatchObject({
      timeZone: "UTC",
      randomInterval: { minMs: 6 * 3_600_000, maxMs: 24 * 3_600_000 },
    });
    expect(config[0]!.actions).toEqual([
      { type: "send_image", content: "今日图", source: { kind: "random", directory: null } },
      { type: "send_image", content: undefined, source: { kind: "random", directory: "/srv/gallery/daily" } },
      { type: "send_image", content: undefined, source: { kind: "random", directory: "/srv/albums" } },
      { type: "send_image", content: undefined, source: { kind: "url", url: "https://example.com/a.png" } },
      { type: "send_file", content: "周报", source: { kind: "path", path: "/srv/reports/w.pdf" } },
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

  test("chat_id 可写 \"all\"，其它字符串一律拒绝", () => {
    expect(parseCronConfig([task({ chat_id: "all" })], PATH)[0]).toMatchObject({ chatId: "all" });
    for (const chatId of ["ALL", "all ", "-1001", null]) {
      rejects([task({ chat_id: chatId })], `${PATH}: $[0].chat_id must be a non-zero safe integer chat id or "all".`);
    }
  });

  test("just_once 与 rand_cron 互斥", () => {
    rejects([task({ just_once: true, rand_cron: "1h" })], `${PATH}: $[0].just_once must be false or absent when rand_cron is set.`);
    expect(parseCronConfig([task({ just_once: false, rand_cron: "1h" })], PATH)[0]!.justOnce).toBe(false);
  });

  test("cron 与 time_zone 由 Bun.cron.parse 判定，不可能的日期同样拒绝；缩写键 tz 不认", () => {
    rejects([task({ cron: "61 * * * *" })], "$[0].cron must be a 5-field cron expression");
    rejects([task({ cron: "0 0 30 2 *" })], "$[0].cron must be a 5-field cron expression");
    rejects([task({ time_zone: "Mars/Olympus" })], "$[0].time_zone must be an IANA time zone name");
    // 显式写出的 null 不是「缺省」，不能静默换成默认时区。
    rejects([task({ time_zone: null })], "$[0].time_zone must be an IANA time zone name");
    rejects([task({ tz: "UTC" })], "$[0] must be { name, chat_id, cron, time_zone?, rand_cron?, just_once?, actions }");
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
    // 不支持论坛话题：message_thread_id 是未知键，整份拒绝。
    rejects([task({ message_thread_id: 12 })], "$[0] must be { name, chat_id, cron, time_zone?, rand_cron?, just_once?, actions }");
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

  test("path 接受绝对路径与相对项目根的路径，不限定目录，按规范化结果保存", () => {
    const expected: string = "$[0].actions[0].payload.path must be an absolute local path or a path relative to the project root.";
    const image = (payload: Record<string, unknown>): unknown => [task({ actions: [{ type: "send_image", payload }] })];
    for (const path of ["", "/tmp/a\0.png", "a\0.png", 7, null]) rejects(image({ path }), expected);
    rejects(image({ rand_image: true, path: "" }), expected);
    const parsedPath = (payload: Record<string, unknown>): unknown => parseCronConfig([task({ actions: [{ type: "send_file", payload }] })], PATH)[0]!.actions[0];
    expect(parsedPath({ path: "/etc/../opt/./r.pdf" })).toEqual({ type: "send_file", content: undefined, source: { kind: "path", path: "/opt/r.pdf" } });
    for (const [path, resolved] of [
      ["a.png", join(PROJECT_ROOT, "a.png")],
      ["./config/cron_files/x.png", join(PROJECT_ROOT, "config", "cron_files", "x.png")],
      ["../shared/r.pdf", join(PROJECT_ROOT, "..", "shared", "r.pdf")],
    ] as const) {
      expect(parsedPath({ path })).toEqual({ type: "send_file", content: undefined, source: { kind: "path", path: resolved } });
    }
    const config: CronConfig = parseCronConfig([task({ actions: [{ type: "send_image", payload: { rand_image: true, path: "." } }] })], PATH);
    expect(config[0]!.actions[0]).toEqual({ type: "send_image", content: undefined, source: { kind: "random", directory: PROJECT_ROOT } });
  });
});

describe("loadCronConfig", () => {
  test("本地文件与目录必须真实存在且类型相符", async () => {
    const report: string = join(FILES_ROOT, "report.pdf");
    const daily: string = join(FILES_ROOT, "daily");
    mkdirSync(daily, { recursive: true });
    await Bun.write(report, "pdf");
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({
      actions: [
        { type: "send_file", payload: { path: report } },
        { type: "send_image", payload: { rand_image: true, path: daily } },
      ],
    })]));
    expect((await loadCronConfig())[0]!.actions).toHaveLength(2);

    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_file", payload: { path: daily } }] })]));
    await expect(loadCronConfig()).rejects.toThrow(
      `${CRON_CONFIG_PATH}: $[0].actions[0].payload.path must be an existing regular file.`
    );
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_image", payload: { rand_image: true, path: report } }] })]));
    await expect(loadCronConfig()).rejects.toThrow("$[0].actions[0].payload.path must be an existing directory.");
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_file", payload: { path: join(FILES_ROOT, "missing.pdf") } }] })]));
    await expect(loadCronConfig()).rejects.toThrow("$[0].actions[0].payload.path must be an existing regular file.");
  });

  test("相对路径按项目根解析后再核对存在与类型", async () => {
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({
      actions: [
        { type: "send_file", payload: { path: "config_example/cron.json" } },
        { type: "send_image", payload: { rand_image: true, path: "public" } },
      ],
    })]));
    expect((await loadCronConfig())[0]!.actions).toHaveLength(2);
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_file", payload: { path: "config_example/missing.pdf" } }] })]));
    await expect(loadCronConfig()).rejects.toThrow("$[0].actions[0].payload.path must be an existing regular file.");
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_image", payload: { rand_image: true, path: "config_example/cron.json" } }] })]));
    await expect(loadCronConfig()).rejects.toThrow("$[0].actions[0].payload.path must be an existing directory.");
  });

  test("符号链接按指向的对象判定；悬空链接按不存在拒绝", async () => {
    mkdirSync(FILES_ROOT, { recursive: true });
    const target: string = join(FILES_ROOT, "real.pdf");
    await Bun.write(target, "pdf");
    symlinkSync(target, join(FILES_ROOT, "linked.pdf"));
    symlinkSync(join(FILES_ROOT, "gone.pdf"), join(FILES_ROOT, "dangling.pdf"));
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_file", payload: { path: join(FILES_ROOT, "linked.pdf") } }] })]));
    expect(await loadCronConfig()).toHaveLength(1);
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_file", payload: { path: join(FILES_ROOT, "dangling.pdf") } }] })]));
    await expect(loadCronConfig()).rejects.toThrow("$[0].actions[0].payload.path must be an existing regular file.");
  });

  test("只用网址来源时不访问本地文件系统；非法 JSON 拒绝", async () => {
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_image", payload: { url: "https://e.com/a.png" } }] })]));
    expect(await loadCronConfig()).toHaveLength(1);
    await Bun.write(CRON_CONFIG_PATH, "[ // comment\n]");
    await expect(loadCronConfig()).rejects.toThrow(`${CRON_CONFIG_PATH}: $ must be a readable valid JSON document.`);
  });
});
