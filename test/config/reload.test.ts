import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  defaultAdSampleConfigCache,
  defaultMoodConfigCache,
  defaultStickerConfigCache,
} from "../../packages/cache/perThread/config";
import { applyHotDeploymentConfigs, readHotDeploymentConfigs } from "../../packages/config/reload";
import {
  AD_SAMPLES_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
} from "../../packages/consts/paths";
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
}

const HOT_PATHS: readonly string[] = [
  AD_SAMPLES_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
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
  };
});

afterEach(async (): Promise<void> => {
  for (const [path, text] of baseline.files) await Bun.write(path, text);
  defaultAdSampleConfigCache.current = baseline.adSamples;
  adDetectAgentConfigCache.current = baseline.adDetect;
  agentDeploymentConfigCache.current = baseline.agent;
  defaultMoodConfigCache.current = baseline.mood;
  defaultStickerConfigCache.current = baseline.stickers;
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

describe("config/ 热重载判定", () => {
  test("内容与已生效快照相同时不替换任何 holder", async () => {
    const changes: HotDeploymentConfigChanges = await reload();
    expect(changes).toEqual({
      adDetect: false,
      aiAgent: false,
      adSamples: false,
      mood: false,
      stickers: false,
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

  test("可选能力的增删只替换内容", async () => {
    const document = await readAgentDocument();
    delete document.agent.song;
    await writeJson(AGENT_CONFIG_PATH, document);

    const changes: HotDeploymentConfigChanges = await reload();

    expect(changes.rejections).toEqual([]);
    expect(changes.aiAgent).toBe(true);
    expect(agentDeploymentConfigCache.current?.song).toBeUndefined();
  });
});
