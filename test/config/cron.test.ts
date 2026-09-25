import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  assertCronVoiceSupported,
  cronConfigUsesVoice,
  ensureCronConfig,
  getCronConfig,
  adoptCronConfig,
  loadCronConfig,
  parseCronConfig,
} from "../../packages/config/cron";
import { adoptAgentDeploymentConfig } from "../../packages/config/agent";
import { VOICE_OPERATOR_TEXT_MAX_CHARS, VOICE_TONE_MAX_CHARS } from "../../packages/consts/aiChat/voiceMessage";
import type { AgentDeploymentConfig, AgentTtsCapabilityConfig } from "../../packages/types/config";
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
    chat_id: [-1001],
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
  adoptAgentDeploymentConfig(null);
  adoptCronConfig(null);
});

const TTS: AgentTtsCapabilityConfig = { provider: "google", apiKey: "k", model: "tts-model", baseUrl: undefined, voice: "Leda" };

/** 只关心 tts 段的 agent 快照；对话核心能力段在这些用例里不被读取。 */
function agentWith(tts: AgentTtsCapabilityConfig | undefined): AgentDeploymentConfig {
  return { tts } as unknown as AgentDeploymentConfig;
}

describe("send_voice", () => {
  test("content 必填、tone 可省；两者清洗成单行后保存", () => {
    const config: CronConfig = parseCronConfig([task({
      actions: [
        { type: "send_voice", payload: { content: " おやすみ\nまた明日 ", tone: " 眠そうに\n小声で " } },
        { type: "send_voice", payload: { content: "おはよう" } },
      ],
    })], PATH);
    expect(config[0]!.actions).toEqual([
      { type: "send_voice", content: "おやすみ また明日", tone: "眠そうに 小声で" },
      { type: "send_voice", content: "おはよう", tone: undefined },
    ]);
    expect(cronConfigUsesVoice(config)).toBe(true);
    expect(cronConfigUsesVoice(parseCronConfig([task()], PATH))).toBe(false);
  });

  test("键、类型与长度严格判定，诊断写明字段路径", () => {
    const voice = (payload: Record<string, unknown>): unknown => [task({ actions: [{ type: "send_voice", payload }] })];
    rejects(voice({ tone: "眠そうに" }), "$[0].actions[0].payload.content");
    rejects(voice({ content: "   " }), "$[0].actions[0].payload.content");
    rejects(voice({ content: "あ".repeat(VOICE_OPERATOR_TEXT_MAX_CHARS + 1) }), `at most ${VOICE_OPERATOR_TEXT_MAX_CHARS} characters`);
    rejects(voice({ content: "hi", tone: "" }), "$[0].actions[0].payload.tone");
    rejects(voice({ content: "hi", tone: null }), "$[0].actions[0].payload.tone");
    rejects(voice({ content: "hi", tone: "あ".repeat(VOICE_TONE_MAX_CHARS + 1) }), `at most ${VOICE_TONE_MAX_CHARS} characters`);
    rejects(voice({ content: "hi", text: "hi" }), "{ content, tone? }");
    expect(parseCronConfig(voice({ content: "あ".repeat(VOICE_OPERATOR_TEXT_MAX_CHARS) }), PATH)).toHaveLength(1);
  });

  test("用到 send_voice 而 agent.tts 缺省时按第一个 send_voice 的字段路径拒绝", () => {
    const config: CronConfig = parseCronConfig([
      task(),
      task({ name: "voice", actions: [
        { type: "send_message", payload: { content: "hi" } },
        { type: "send_voice", payload: { content: "おやすみ" } },
      ] }),
    ], PATH);
    expect(() => assertCronVoiceSupported(config, undefined, PATH)).toThrow(
      `${PATH}: $[1].actions[1].type must be send_message, send_image or send_file unless config/agent.json configures $.agent.tts alongside text, summary and media`
    );
    expect(() => assertCronVoiceSupported(config, TTS, PATH)).not.toThrow();
    expect(() => assertCronVoiceSupported(parseCronConfig([task()], PATH), undefined, PATH)).not.toThrow();
  });

  test("启动总闸按已校验的 agent 配置核对：没配 tts 拒绝启动，配了才接管", async () => {
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_voice", payload: { content: "hi" } }] })]));
    adoptAgentDeploymentConfig(null);
    await expect(ensureCronConfig()).rejects.toThrow("$[0].actions[0].type");
    adoptAgentDeploymentConfig(agentWith(undefined));
    await expect(ensureCronConfig()).rejects.toThrow("unless config/agent.json configures $.agent.tts");
    expect(getCronConfig()).toEqual([]);
    adoptAgentDeploymentConfig(agentWith(TTS));
    await ensureCronConfig();
    expect(getCronConfig()[0]!.actions).toEqual([{ type: "send_voice", content: "hi", tone: undefined }]);
  });
});

describe("parseCronConfig", () => {
  test("空数组合法；可选字段缺省按从没设过填齐", () => {
    expect(parseCronConfig([], PATH)).toEqual([]);
    expect(parseCronConfig([task()], PATH)).toEqual([{
      name: "daily",
      chatTargets: { kind: "list", chatIds: [-1001] },
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
        { type: "send_image", payload: { url: ["https://example.com/a.png"], is_blurred: true } },
        { type: "send_file", payload: { content: "周报", path: "/srv/reports/w.pdf" } },
        { type: "send_file", payload: { url: "http://example.com/r.zip" } },
      ],
    })], PATH);
    expect(config[0]).toMatchObject({
      timeZone: "UTC",
      randomInterval: { minMs: 6 * 3_600_000, maxMs: 24 * 3_600_000 },
    });
    expect(config[0]!.actions).toEqual([
      { type: "send_image", content: "今日图", source: { kind: "random", directory: null }, isBlurred: false },
      { type: "send_image", content: undefined, source: { kind: "random", directory: "/srv/gallery/daily" }, isBlurred: false },
      { type: "send_image", content: undefined, source: { kind: "random", directory: "/srv/albums" }, isBlurred: false },
      { type: "send_image", content: undefined, source: { kind: "urls", urls: ["https://example.com/a.png"] }, isBlurred: true },
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

  test("chat_id 是数组：逐个列出、[\"all\"] 与 [\"except\", ...] 三种写法", () => {
    expect(parseCronConfig([task({ chat_id: ["all"] })], PATH)[0]).toMatchObject({ chatTargets: { kind: "all" } });
    expect(parseCronConfig([task({ chat_id: [-1001, -1002, 7] })], PATH)[0]).toMatchObject({
      chatTargets: { kind: "list", chatIds: [-1001, -1002, 7] },
    });
    expect(parseCronConfig([task({ chat_id: ["except", -1001] })], PATH)[0]).toMatchObject({
      chatTargets: { kind: "except", chatIds: [-1001] },
    });
  });

  test("chat_id 的形态严格判定：标量、空数组、混写与重复 id 一律拒绝", () => {
    const shape: string = `${PATH}: $[0].chat_id must be ["all"], ["except", <chat id>, ...] or a list of at most 64 unique non-zero safe integer chat ids.`;
    // 标量写法不再受理；"all" 只能单独出现，"except" 只能作为首项且必须带 id。
    for (const chatId of [-1001, "all", "except", [], ["all", -1001], ["except"], {}, null]) {
      rejects([task({ chat_id: chatId })], shape);
    }
    rejects([task({ chat_id: Array.from({ length: 65 }, (_: unknown, index: number) => -index - 1) })], shape);
    expect(parseCronConfig([task({ chat_id: Array.from({ length: 64 }, (_: unknown, index: number) => -index - 1) })], PATH)[0]!
      .chatTargets).toMatchObject({ kind: "list" });
    const element: string = `${PATH}: $[0].chat_id[1] must be a unique non-zero safe integer chat id.`;
    for (const chatId of [[-1001, 0], [-1001, "-1002"], [-1001, "all"], [-1001, -1001], [-1001, 1.5], [-1001, null], [-1001, Number.MAX_SAFE_INTEGER + 2]]) {
      rejects([task({ chat_id: chatId })], element);
    }
    rejects([task({ chat_id: ["except", -1001, -1001] })], `${PATH}: $[0].chat_id[2] must be a unique non-zero safe integer chat id.`);
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
    rejects([task({ chat_id: [0] })], "$[0].chat_id[0] must be a unique non-zero safe integer chat id");
    // 不支持论坛话题：message_thread_id 是未知键，整份拒绝。
    rejects([task({ message_thread_id: 12 })], "$[0] must be { name, chat_id, cron, time_zone?, rand_cron?, just_once?, actions }");
    rejects([task({ actions: [] })], "$[0].actions must be a non-empty array with at most 16 actions");
    rejects([task({ actions: Array.from({ length: 17 }, () => ({ type: "send_message", payload: { content: "x" } })) })], "$[0].actions must be");
    rejects([task({ actions: [{ type: "send_video", payload: {} }] })], "$[0].actions[0].type must be send_message, send_image, send_file or send_voice");
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
    rejects(message({ url: ["ftp://e.com/a.png"] }), "$[0].actions[0].payload.url[0] must be an absolute http(s) URL");
    rejects(message({ url: ["e.com/a.png"] }), "$[0].actions[0].payload.url[0] must be an absolute http(s) URL");
  });

  test("is_blurred 只用于图片：缺省为 false，显式 true 与随机图组合，非布尔值按字段路径拒绝", () => {
    const image = (payload: Record<string, unknown>, type: string = "send_image"): unknown => [task({ actions: [{ type, payload }] })];
    const parsed = (payload: Record<string, unknown>): unknown => parseCronConfig(image(payload), PATH)[0]!.actions[0];
    expect(parsed({ url: ["https://e.com/a.png"] })).toMatchObject({ isBlurred: false });
    expect(parsed({ url: ["https://e.com/a.png"], is_blurred: false })).toMatchObject({ isBlurred: false });
    expect(parsed({ rand_image: true, is_blurred: true })).toEqual({
      type: "send_image", content: undefined, source: { kind: "random", directory: null }, isBlurred: true,
    });
    for (const isBlurred of ["true", 1, null, {}]) {
      rejects(image({ url: "https://e.com/a.png", is_blurred: isBlurred }), "$[0].actions[0].payload.is_blurred must be a boolean.");
    }
    rejects(image({ url: "https://e.com/a.png", blurred: true }), "$[0].actions[0].payload must be { content?, rand_image?, url?, path?, is_blurred? }");
    rejects(image({ url: "https://e.com/f", is_blurred: true }, "send_file"), "$[0].actions[0].payload must be { content?, url?, path? }");
    rejects(image({ content: "x", is_blurred: true }, "send_message"), "$[0].actions[0].payload must be { content }");
  });

  test("path 接受绝对路径与相对项目根的路径，不限定目录，按规范化结果保存", () => {
    const expected: string = "$[0].actions[0].payload.path must be an absolute local path or a path relative to the project root.";
    const image = (payload: Record<string, unknown>): unknown => [task({ actions: [{ type: "send_image", payload }] })];
    for (const path of ["", "/tmp/a\0.png", "a\0.png", 7, null]) rejects(image({ path: [path] }), expected.replace("payload.path", "payload.path[0]"));
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
    expect(config[0]!.actions[0]).toEqual({ type: "send_image", content: undefined, source: { kind: "random", directory: PROJECT_ROOT }, isBlurred: false });
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
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_image", payload: { url: ["https://e.com/a.png"] } }] })]));
    expect(await loadCronConfig()).toHaveLength(1);
    await Bun.write(CRON_CONFIG_PATH, "[ // comment\n]");
    await expect(loadCronConfig()).rejects.toThrow(`${CRON_CONFIG_PATH}: $ must be a readable valid JSON document.`);
  });
});

test("固定图片数组严格限制 1–10 项，拒绝随机模式与数组混用", () => {
  const image = (payload: unknown): unknown => [task({ actions: [{ type: "send_image", payload }] })];
  for (const length of [1, 2, 10]) {
    const urls: string[] = Array.from({ length }, (_: unknown, index: number): string => `https://e.com/${index}.png`);
    expect(parseCronConfig(image({ url: urls, rand_image: false }), PATH)[0]!.actions[0])
      .toMatchObject({ source: { kind: "urls", urls } });
  }
  for (const value of [[], Array(11).fill("https://e.com/a.png"), "https://e.com/a.png", null, {}]) {
    rejects(image({ url: value }), "payload.url must be an array of 1–10");
  }
  for (const value of [null, 7, [], {}, "ftp://e.com/a.png"]) {
    rejects(image({ url: ["https://e.com/a.png", value] }), "payload.url[1] must be an absolute http(s) URL");
  }
  for (const value of ["", " ", null, [], 1]) {
    rejects(image({ path: ["./a.jpg", value] }), "payload.path[1] must be an absolute local path");
  }
  rejects(image({ path: ["./a.jpg"], rand_image: true }), "payload.path must be an absolute local path");
  rejects(image({ url: ["https://e.com/a.jpg"], rand_image: true }), "payload.url must be absent when rand_image is true");
  rejects(image({ url: ["https://e.com/a.jpg"], path: ["./a.jpg"] }), "payload must be exactly one of url or path arrays");
  expect(parseCronConfig(image({ path: ["./a.jpg", "/srv/b.png"] }), PATH)[0]!.actions[0])
    .toMatchObject({ source: { kind: "paths", paths: [join(PROJECT_ROOT, "a.jpg"), "/srv/b.png"] } });
});

test("固定图片数组异步检查每个来源，目录或缺失文件报告精确下标", async () => {
  mkdirSync(FILES_ROOT, { recursive: true });
  const valid: string = join(FILES_ROOT, "a.jpg");
  await Bun.write(valid, "image");
  for (const second of [FILES_ROOT, join(FILES_ROOT, "missing.jpg")]) {
    await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_image", payload: { path: [valid, second] } }] })]));
    await expect(loadCronConfig()).rejects.toThrow("payload.path[1] must be an existing regular file");
  }
  await Bun.write(CRON_CONFIG_PATH, JSON.stringify([task({ actions: [{ type: "send_image", payload: { path: [valid] } }] })]));
  expect(await loadCronConfig()).toHaveLength(1);
});

test("图片来源数组在编译期只读", () => {
  const assertReadonly = (config: CronConfig): void => {
    const action = config[0]!.actions[0]!;
    if (action.type === "send_image" && action.source.kind === "urls") {
      // @ts-expect-error 已校验来源数组不能被调用方扩展。
      action.source.urls.push("https://e.com/unvalidated.png");
    }
  };
  expect(assertReadonly).toBeDefined();
});
