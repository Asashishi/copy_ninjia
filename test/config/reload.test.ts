import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  defaultAdSampleConfigCache,
  defaultMoodConfigCache,
  defaultStickerConfigCache,
} from "../../packages/cache/perThread/config";
import { applyHotDeploymentConfigs, readHotDeploymentConfigs } from "../../packages/config/reload";
import { cronConfigCache } from "../../packages/cache/main/cron";
import { assetConfigCache } from "../../packages/cache/main/assets";
import { DEFAULT_ASSET_CONFIG } from "../../packages/consts/ui/assets";
import {
  AD_SAMPLES_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  ASSETS_CONFIG_PATH,
  RUNTIME_DATA_ROOT,
  CRON_CONFIG_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
} from "../../packages/consts/paths";
import type { CronConfig } from "../../packages/types/cron";
import type {
  AdDetectAgentConfig,
  AdSampleConfig,
  AgentDeploymentConfig,
  HotDeploymentConfigChanges,
  MoodConfig,
  StickerConfig,
} from "../../packages/types/config";

/** 测试 preload 已把 config_example 副本解析进 holder；每条用例结束后还原文件与 holder。 */
interface Baseline {
  readonly files: ReadonlyMap<string, string>;
  readonly adSamples: AdSampleConfig | null;
  readonly adDetect: AdDetectAgentConfig | null;
  readonly agent: AgentDeploymentConfig | null;
  readonly mood: MoodConfig | null;
  readonly stickers: StickerConfig | null;
  readonly cron: CronConfig | null;
}

const HOT_PATHS: readonly string[] = [
  AD_SAMPLES_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
  CRON_CONFIG_PATH,
];

let baseline: Baseline;

beforeAll(async (): Promise<void> => {
  const files: Map<string, string> = new Map<string, string>();
  for (const path of HOT_PATHS) files.set(path, await Bun.file(path).text());
  baseline = {
    files,
    adSamples: defaultAdSampleConfigCache.current,
    adDetect: adDetectAgentConfigCache.current,
    agent: agentDeploymentConfigCache.current,
    mood: defaultMoodConfigCache.current,
    stickers: defaultStickerConfigCache.current,
    cron: cronConfigCache.current,
  };
});

afterEach(async (): Promise<void> => {
  for (const [path, text] of baseline.files) await Bun.write(path, text);
  defaultAdSampleConfigCache.current = baseline.adSamples;
  adDetectAgentConfigCache.current = baseline.adDetect;
  agentDeploymentConfigCache.current = baseline.agent;
  defaultMoodConfigCache.current = baseline.mood;
  defaultStickerConfigCache.current = baseline.stickers;
  cronConfigCache.current = baseline.cron;
  rmSync(ASSETS_CONFIG_PATH, { force: true });
  assetConfigCache.current = DEFAULT_ASSET_CONFIG;
});

async function reload(): Promise<HotDeploymentConfigChanges> {
  return applyHotDeploymentConfigs(await readHotDeploymentConfigs());
}

async function readAgentDocument(): Promise<{ agent: Record<string, Record<string, unknown>> }> {
  return await Bun.file(AGENT_CONFIG_PATH).json() as { agent: Record<string, Record<string, unknown>> };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("config/dynamic/ 热重载判定", () => {
  test("内容与已生效快照相同时不替换任何 holder", async () => {
    const changes: HotDeploymentConfigChanges = await reload();
    expect(changes).toEqual({
      assets: false,
      adDetect: false,
      aiAgent: false,
      adSamples: false,
      mood: false,
      stickers: false,
      cron: false,
      reloadedPaths: [],
      removedPaths: [],
      rejections: [],
    });
    expect(defaultMoodConfigCache.current).toBe(baseline.mood);
    expect(agentDeploymentConfigCache.current).toBe(baseline.agent);
    expect(adDetectAgentConfigCache.current).toBe(baseline.adDetect);
  });

  test("合法变更整体替换对应 holder，其余 holder 身份不变", async () => {
    await writeJson(STICKERS_CONFIG_PATH, { packs: ["NewPack_1", "MikuCat4"] });
    await writeJson(MOOD_CONFIG_PATH, {
      moods: [
        { name: "平静", weight: 60, instruction: "平静地说话。" },
        { name: "开心", weight: 40, instruction: "开心地说话。" },
      ],
    });

    const changes: HotDeploymentConfigChanges = await reload();

    expect(changes.rejections).toEqual([]);
    expect(changes.stickers).toBe(true);
    expect(changes.mood).toBe(true);
    expect(changes.aiAgent).toBe(false);
    expect(changes.adDetect).toBe(false);
    expect(changes.adSamples).toBe(false);
    expect(changes.reloadedPaths).toEqual([MOOD_CONFIG_PATH, STICKERS_CONFIG_PATH]);
    expect(defaultStickerConfigCache.current).toEqual({ packs: ["NewPack_1", "MikuCat4"] });
    expect(defaultMoodConfigCache.current?.moods.map((mood) => mood.name)).toEqual(["平静", "开心"]);
    expect(defaultAdSampleConfigCache.current).toBe(baseline.adSamples);
    expect(agentDeploymentConfigCache.current).toBe(baseline.agent);
  });

  test("广告示例规范化后相同视为未变化", async () => {
    const samples: readonly string[] = baseline.adSamples ?? [];
    await writeJson(AD_SAMPLES_CONFIG_PATH, samples.map((sample: string): string => `  ${sample}\n`));
    const changes: HotDeploymentConfigChanges = await reload();
    expect(changes.adSamples).toBe(false);
    expect(defaultAdSampleConfigCache.current).toBe(baseline.adSamples);
  });

  test("agent.json 两段分别判定变化", async () => {
    const document = await readAgentDocument();
    document.agent.text!.model = "reloaded-text-model";
    await writeJson(AGENT_CONFIG_PATH, document);

    let changes: HotDeploymentConfigChanges = await reload();
    expect(changes.aiAgent).toBe(true);
    expect(changes.adDetect).toBe(false);
    expect(changes.reloadedPaths).toEqual([AGENT_CONFIG_PATH]);
    expect(agentDeploymentConfigCache.current?.text.model).toBe("reloaded-text-model");
    expect(adDetectAgentConfigCache.current).toBe(baseline.adDetect);

    document.agent.ad_detect!.model = "reloaded-ad-model";
    await writeJson(AGENT_CONFIG_PATH, document);
    const aiAgentAfterFirstReload: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
    changes = await reload();
    expect(changes.aiAgent).toBe(false);
    expect(changes.adDetect).toBe(true);
    expect(adDetectAgentConfigCache.current?.model).toBe("reloaded-ad-model");
    expect(agentDeploymentConfigCache.current).toBe(aiAgentAfterFirstReload);
  });

  test("严格解析失败的变更整份拒绝，holder 保留上一份快照", async () => {
    await writeJson(STICKERS_CONFIG_PATH, { packs: ["NewPack_1", "bad name"] });
    await Bun.write(AD_SAMPLES_CONFIG_PATH, "[");

    const changes: HotDeploymentConfigChanges = await reload();

    expect(changes.stickers).toBe(false);
    expect(changes.adSamples).toBe(false);
    expect(changes.reloadedPaths).toEqual([]);
    expect(changes.rejections).toEqual([
      `${AD_SAMPLES_CONFIG_PATH}: $ must be a readable valid JSON document.`,
      `${STICKERS_CONFIG_PATH}: $.packs[1] must be a valid Telegram sticker pack short name.`,
    ]);
    expect(defaultStickerConfigCache.current).toBe(baseline.stickers);
    expect(defaultAdSampleConfigCache.current).toBe(baseline.adSamples);
  });

  test("agent.json 的非法字段整份拒绝，诊断不回显凭据", async () => {
    const document = await readAgentDocument();
    document.agent.text!.model = "would-be-applied";
    document.agent.summary!.base_url = "http://example.com/v1";
    await writeJson(AGENT_CONFIG_PATH, document);

    const changes: HotDeploymentConfigChanges = await reload();

    expect(changes.aiAgent).toBe(false);
    expect(changes.rejections).toHaveLength(1);
    expect(changes.rejections[0]).toStartWith(`${AGENT_CONFIG_PATH}: $.agent.summary.base_url must be`);
    expect(changes.rejections[0]).not.toContain(String(document.agent.summary!.api_key));
    expect(agentDeploymentConfigCache.current).toBe(baseline.agent);
  });

  test("删除启动时存在的文件：holder 换成 null 并记入删除清单，不算拒绝", async () => {
    rmSync(MOOD_CONFIG_PATH);
    const changes: HotDeploymentConfigChanges = await reload();
    expect(changes.mood).toBe(true);
    expect(changes.rejections).toEqual([]);
    expect(changes.reloadedPaths).toEqual([]);
    expect(changes.removedPaths).toEqual([MOOD_CONFIG_PATH]);
    expect(defaultMoodConfigCache.current).toBeNull();
  });

  test("启动时缺省的文件运行期出现：按新内容填充", async () => {
    defaultStickerConfigCache.current = null;
    const changes: HotDeploymentConfigChanges = await reload();
    expect(changes.stickers).toBe(true);
    expect(changes.rejections).toEqual([]);
    expect(changes.reloadedPaths).toEqual([STICKERS_CONFIG_PATH]);
    expect(defaultStickerConfigCache.current as StickerConfig | null).toEqual(baseline.stickers!);
  });

  test("启动时缺省且仍然缺省的文件不产生诊断，也不算变化", async () => {
    defaultStickerConfigCache.current = null;
    rmSync(STICKERS_CONFIG_PATH);
    const changes: HotDeploymentConfigChanges = await reload();
    expect(changes.stickers).toBe(false);
    expect(changes.rejections).toEqual([]);
    expect(changes.removedPaths).toEqual([]);
    expect(defaultStickerConfigCache.current).toBeNull();
  });

  test("已删除的文件内容非法地重新出现时整份拒绝，holder 保持 null", async () => {
    defaultMoodConfigCache.current = null;
    await Bun.write(MOOD_CONFIG_PATH, "{ not json");
    const changes: HotDeploymentConfigChanges = await reload();
    expect(changes.mood).toBe(false);
    expect(changes.rejections).toEqual([`${MOOD_CONFIG_PATH}: $ must be a readable valid JSON document.`]);
    expect(defaultMoodConfigCache.current).toBeNull();
  });

  test("agent.json 删掉 ad_detect 段只清空该段，同一次编辑里的其它改动照常生效", async () => {
    const document = await readAgentDocument();
    delete document.agent.ad_detect;
    document.agent.text!.model = "applied-model";
    await writeJson(AGENT_CONFIG_PATH, document);

    const changes: HotDeploymentConfigChanges = await reload();

    expect(changes.rejections).toEqual([]);
    expect(changes.adDetect).toBe(true);
    expect(changes.aiAgent).toBe(true);
    expect(changes.reloadedPaths).toEqual([AGENT_CONFIG_PATH]);
    expect(adDetectAgentConfigCache.current).toBeNull();
    expect(agentDeploymentConfigCache.current?.text.model).toBe("applied-model");
  });

  test("agent.json 补上启动时缺省的 ad_detect 段：填充该段，AI 段身份不变", async () => {
    adDetectAgentConfigCache.current = null;
    const changes: HotDeploymentConfigChanges = await reload();
    expect(changes.adDetect).toBe(true);
    expect(changes.aiAgent).toBe(false);
    expect(changes.rejections).toEqual([]);
    expect(adDetectAgentConfigCache.current as AdDetectAgentConfig | null).toEqual(baseline.adDetect!);
    expect(agentDeploymentConfigCache.current).toBe(baseline.agent);
  });

  test("agent.json 去掉对话核心能力时 AI 段换成 null，ad_detect 段身份不变", async () => {
    const document = await readAgentDocument();
    delete document.agent.media;
    await writeJson(AGENT_CONFIG_PATH, document);

    const changes: HotDeploymentConfigChanges = await reload();

    expect(changes.rejections).toEqual([]);
    expect(changes.aiAgent).toBe(true);
    expect(changes.adDetect).toBe(false);
    expect(agentDeploymentConfigCache.current).toBeNull();
    expect(adDetectAgentConfigCache.current).toBe(baseline.adDetect);
  });

  test("整份删除 agent.json 时两段都清空，并记入删除清单", async () => {
    rmSync(AGENT_CONFIG_PATH);
    const changes: HotDeploymentConfigChanges = await reload();
    expect(changes.adDetect).toBe(true);
    expect(changes.aiAgent).toBe(true);
    expect(changes.removedPaths).toEqual([AGENT_CONFIG_PATH]);
    expect(changes.reloadedPaths).toEqual([]);
    expect(adDetectAgentConfigCache.current).toBeNull();
    expect(agentDeploymentConfigCache.current).toBeNull();
  });

  test("cron.json：新增任务替换任务表，删除文件换成 null，非法内容整份拒绝", async () => {
    await writeJson(CRON_CONFIG_PATH, [{
      name: "daily",
      chat_id: [-1001],
      cron: "0 9 * * *",
      actions: [{ type: "send_message", payload: { content: "hi" } }],
    }]);
    let changes: HotDeploymentConfigChanges = await reload();
    expect(changes.cron).toBe(true);
    expect(changes.reloadedPaths).toEqual([CRON_CONFIG_PATH]);
    expect(cronConfigCache.current?.map((task) => task.name)).toEqual(["daily"]);

    await writeJson(CRON_CONFIG_PATH, [{ name: "daily", chat_id: [-1001], cron: "bad", actions: [] }]);
    changes = await reload();
    expect(changes.cron).toBe(false);
    expect(changes.rejections).toEqual([`${CRON_CONFIG_PATH}: $[0].cron must be a 5-field cron expression or @nickname with a future occurrence.`]);
    expect(cronConfigCache.current?.map((task) => task.name)).toEqual(["daily"]);

    rmSync(CRON_CONFIG_PATH);
    changes = await reload();
    expect(changes.cron).toBe(true);
    expect(changes.removedPaths).toEqual([CRON_CONFIG_PATH]);
    expect(cronConfigCache.current).toBeNull();
  });

  test("可选能力的增删只替换内容", async () => {
    const document = await readAgentDocument();
    delete document.agent.tts;
    await writeJson(AGENT_CONFIG_PATH, document);

    const changes: HotDeploymentConfigChanges = await reload();

    expect(changes.rejections).toEqual([]);
    expect(changes.aiAgent).toBe(true);
    expect(agentDeploymentConfigCache.current?.tts).toBeUndefined();
  });
});

describe("cron.json 的 send_voice 与 agent.json 的 agent.tts", () => {
  const VOICE_TASKS: readonly Record<string, unknown>[] = [{
    name: "voice",
    chat_id: [-1001],
    cron: "0 9 * * *",
    actions: [{ type: "send_voice", payload: { content: "おはよう" } }],
  }];
  const TEXT_TASKS: readonly Record<string, unknown>[] = [{
    name: "text",
    chat_id: [-1001],
    cron: "0 9 * * *",
    actions: [{ type: "send_message", payload: { content: "hi" } }],
  }];
  const CRON_REJECTION: string =
    `${CRON_CONFIG_PATH}: $[0].actions[0].type must be send_message, send_image or send_file ` +
    "unless config/dynamic/agent.json configures $.agent.tts alongside text, summary and media.";
  const AGENT_REJECTION: string = `${AGENT_CONFIG_PATH}: $.agent must be configured with text, summary, media and tts while config/dynamic/cron.json uses send_voice.`;

  async function writeAgentWithoutTts(): Promise<void> {
    const document = await readAgentDocument();
    delete document.agent.tts;
    await writeJson(AGENT_CONFIG_PATH, document);
  }

  test("agent.tts 缺省时新增 send_voice 的 cron.json 变更整份拒绝，任务表保持上一份", async () => {
    await writeAgentWithoutTts();
    expect((await reload()).rejections).toEqual([]);
    const previous: CronConfig | null = cronConfigCache.current;

    await writeJson(CRON_CONFIG_PATH, VOICE_TASKS);
    const changes: HotDeploymentConfigChanges = await reload();

    expect(changes.rejections).toEqual([CRON_REJECTION]);
    expect(changes.cron).toBe(false);
    expect(changes.reloadedPaths).toEqual([]);
    expect(cronConfigCache.current).toBe(previous);
  });

  test("agent.tts 在时 send_voice 照常生效；任务表仍用它时去掉 tts 的 agent.json 变更整份拒绝", async () => {
    await writeJson(CRON_CONFIG_PATH, VOICE_TASKS);
    expect((await reload()).rejections).toEqual([]);
    expect(cronConfigCache.current?.[0]?.actions).toEqual([{ type: "send_voice", content: "おはよう", tone: undefined }]);

    await writeAgentWithoutTts();
    const changes: HotDeploymentConfigChanges = await reload();
    expect(changes.rejections).toEqual([AGENT_REJECTION]);
    expect(changes.aiAgent).toBe(false);
    expect(changes.adDetect).toBe(false);
    expect(agentDeploymentConfigCache.current).toBe(baseline.agent);

    rmSync(AGENT_CONFIG_PATH);
    expect((await reload()).rejections).toEqual([AGENT_REJECTION]);
    expect(agentDeploymentConfigCache.current).toBe(baseline.agent);
    expect(adDetectAgentConfigCache.current).toBe(baseline.adDetect);
  });

  test("同一轮里去掉 send_voice 与去掉 tts 一起生效", async () => {
    await writeJson(CRON_CONFIG_PATH, VOICE_TASKS);
    await reload();
    await writeJson(CRON_CONFIG_PATH, TEXT_TASKS);
    await writeAgentWithoutTts();

    const changes: HotDeploymentConfigChanges = await reload();

    expect(changes.rejections).toEqual([]);
    expect(changes.cron).toBe(true);
    expect(changes.aiAgent).toBe(true);
    expect(agentDeploymentConfigCache.current?.tts).toBeUndefined();
  });

  test("同一轮里新增 send_voice 又去掉 tts：拒绝 cron.json，agent.json 照常生效", async () => {
    await writeJson(CRON_CONFIG_PATH, VOICE_TASKS);
    await writeAgentWithoutTts();

    const changes: HotDeploymentConfigChanges = await reload();

    expect(changes.rejections).toEqual([CRON_REJECTION]);
    expect(changes.cron).toBe(false);
    expect(changes.aiAgent).toBe(true);
    expect(cronConfigCache.current).toBe(baseline.cron);
  });
});

describe("config/dynamic/assets.json 热重载", () => {
  test("文件出现、修改与删除：整体替换快照，删除时换回内置缺省", async () => {
    await writeJson(ASSETS_CONFIG_PATH, { gag_thumbnail_url: "https://cdn.example/gag.png" });
    let changes: HotDeploymentConfigChanges = await reload();
    expect(changes.rejections).toEqual([]);
    expect(changes.assets).toBe(true);
    expect(changes.reloadedPaths).toEqual([ASSETS_CONFIG_PATH]);
    expect(assetConfigCache.current).toEqual({
      ...DEFAULT_ASSET_CONFIG,
      gagThumbnailUrl: "https://cdn.example/gag.png",
    });

    const adopted = assetConfigCache.current;
    changes = await reload();
    expect(changes.assets).toBe(false);
    expect(assetConfigCache.current).toBe(adopted);

    rmSync(ASSETS_CONFIG_PATH);
    changes = await reload();
    expect(changes.assets).toBe(true);
    expect(changes.removedPaths).toEqual([ASSETS_CONFIG_PATH]);
    expect(assetConfigCache.current).toBe(DEFAULT_ASSET_CONFIG);
  });

  test("非法内容整份拒绝，快照保持上一份，诊断不回显原值", async () => {
    await writeJson(ASSETS_CONFIG_PATH, { fortune_thumbnail_url: "cdn.example/secret-path.png" });
    const changes: HotDeploymentConfigChanges = await reload();
    expect(changes.assets).toBe(false);
    expect(changes.rejections).toEqual([
      `${ASSETS_CONFIG_PATH}: $.fortune_thumbnail_url must be an absolute https URL.`,
    ]);
    expect(assetConfigCache.current).toBe(DEFAULT_ASSET_CONFIG);
  });

  test("切换随机图片目录时先建好并检查新目录再接管", async () => {
    const created: string = join(RUNTIME_DATA_ROOT, "reload-gallery");
    rmSync(created, { recursive: true, force: true });
    await writeJson(ASSETS_CONFIG_PATH, { random_h_image_dir: "./reload-gallery" });
    try {
      const changes: HotDeploymentConfigChanges = await reload();
      expect(changes.rejections).toEqual([]);
      expect(assetConfigCache.current.randomHImageDirectory).toBe(created);
      expect(readdirSync(created)).toEqual([]);
    } finally {
      rmSync(created, { recursive: true, force: true });
    }
  });

  test("新目录检查失败时拒绝 assets.json 的变更，保留旧目录", async () => {
    const polluted: string = join(RUNTIME_DATA_ROOT, "reload-polluted-gallery");
    mkdirSync(polluted, { recursive: true });
    await Bun.write(join(polluted, "not-a-digest.png"), "x");
    await writeJson(ASSETS_CONFIG_PATH, {
      random_h_image_dir: "./reload-polluted-gallery",
      gag_thumbnail_url: "https://cdn.example/gag.png",
    });
    try {
      const changes: HotDeploymentConfigChanges = await reload();
      expect(changes.assets).toBe(false);
      expect(changes.rejections).toHaveLength(1);
      expect(changes.rejections[0]).toContain("$.random_h_image_dir must be a regular image named");
      expect(assetConfigCache.current).toBe(DEFAULT_ASSET_CONFIG);
    } finally {
      rmSync(polluted, { recursive: true, force: true });
    }
  });
});
