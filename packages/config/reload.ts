/**
 * config/ 热重载的主线程判定：按启动总闸同一套严格解析器读取四份可热重载部署
 * 文件（ad_samples.json、agent.json、mood.json、stickers.json），再与主线程已生效
 * 快照比较并整体替换 holder。
 *
 * 只替换已生效配置的内容，不改变 config/readiness.ts 的功能可用性结论：
 * - 读不到或严格解析失败的变更整份拒绝，holder 保留上一份已校验快照；
 * - 启动时缺省的文件运行期出现、启动时存在的文件被删除，以及 agent.json 的
 *   ad_detect 段或 text/summary/media 核心段整体增删，都会改变功能可用性，同样
 *   拒绝，须重启由启动总闸重新判定；
 * - 与当前快照深相等的内容不替换，holder 对象身份保持不变。
 *
 * 一份文件内的变更要么整体生效、要么整体拒绝。拒绝诊断沿用 InputValidationError
 * 口径，只含文件路径、字段路径与期望形态。本模块只读盘并改写主线程 holder；
 * 监听、日志与向 Worker 分发由 app/configReload.ts 负责。
 */

import { adoptAdSampleConfig, loadAdSampleConfig } from "./adSamples";
import {
  adoptAdDetectAgentConfig,
  adoptAgentDeploymentConfig,
  loadAgentConfigSnapshots,
} from "./agent";
import { adoptMoodConfig, loadMoodConfig } from "./mood";
import { deploymentInputExists } from "./readiness";
import { adoptStickerConfig, loadStickerConfig } from "./stickers";
import {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  defaultAdSampleConfigCache,
  defaultMoodConfigCache,
  defaultStickerConfigCache,
} from "../cache/perThread/config";
import {
  AD_SAMPLES_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
} from "../consts/paths";
import { InputValidationError } from "../libs/inputValidation";
import type {
  AdSampleConfig,
  AgentConfigSnapshots,
  HotConfigRead,
  HotDeploymentConfigChanges,
  HotDeploymentConfigReads,
  MoodConfig,
  StickerConfig,
} from "../types/config";

/** 读取一份可热重载文件；只把 ENOENT 当作缺省，其余失败一律转成拒绝诊断。 */
async function readHotConfig<T>(
  path: string,
  load: (path: string) => Promise<T>
): Promise<HotConfigRead<T>> {
  try {
    if (!await deploymentInputExists(path)) return { kind: "absent" };
    return { kind: "loaded", value: await load(path) };
  } catch (error: unknown) {
    return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** 按固定顺序逐份读取四份可热重载部署文件；不改写任何 holder。 */
export async function readHotDeploymentConfigs(): Promise<HotDeploymentConfigReads> {
  const adSamples: HotConfigRead<AdSampleConfig> = await readHotConfig(AD_SAMPLES_CONFIG_PATH, loadAdSampleConfig);
  const agent: HotConfigRead<AgentConfigSnapshots> = await readHotConfig(AGENT_CONFIG_PATH, loadAgentConfigSnapshots);
  const mood: HotConfigRead<MoodConfig> = await readHotConfig(MOOD_CONFIG_PATH, loadMoodConfig);
  const stickers: HotConfigRead<StickerConfig> = await readHotConfig(STICKERS_CONFIG_PATH, loadStickerConfig);
  return { adSamples, agent, mood, stickers };
}

/** 改变功能可用性的变更诊断。 */
function availabilityRejection(path: string, fieldPath: string, expected: string): string {
  return new InputValidationError(
    path,
    fieldPath,
    `${expected} as it was at startup; restart the process to change feature availability`
  ).message;
}

/** nextFileSnapshot 的入参：本轮读取结果、当前快照、文件路径与拒绝诊断收集表。 */
interface FileSnapshotOptions<T> {
  readonly read: HotConfigRead<T>;
  readonly current: T | null;
  readonly path: string;
  readonly rejections: string[];
}

/** 判定单份文件：返回要替换成的新快照；内容不变或被拒绝时返回 null，诊断写入 rejections。 */
function nextFileSnapshot<T>({ read, current, path, rejections }: FileSnapshotOptions<T>): T | null {
  switch (read.kind) {
    case "invalid":
      rejections.push(read.reason);
      return null;
    case "absent":
      if (current !== null) rejections.push(availabilityRejection(path, "$", "present"));
      return null;
    case "loaded":
      if (current === null) {
        rejections.push(availabilityRejection(path, "$", "absent"));
        return null;
      }
      return Bun.deepEquals(read.value, current) ? null : read.value;
  }
}

/** 判定 agent.json：两段的「配没配」都必须与当前快照一致，否则整份拒绝。 */
function nextAgentSnapshots(
  read: HotConfigRead<AgentConfigSnapshots>,
  current: AgentConfigSnapshots,
  rejections: string[]
): AgentConfigSnapshots | null {
  if (read.kind === "invalid") {
    rejections.push(read.reason);
    return null;
  }
  // agent.json 缺省时两段都按未配置判定。
  const next: AgentConfigSnapshots = read.kind === "absent" ? { adDetect: null, agent: null } : read.value;
  if ((next.adDetect === null) !== (current.adDetect === null)) {
    rejections.push(availabilityRejection(
      AGENT_CONFIG_PATH,
      "$.agent.ad_detect",
      current.adDetect === null ? "absent" : "configured"
    ));
    return null;
  }
  if ((next.agent === null) !== (current.agent === null)) {
    rejections.push(availabilityRejection(
      AGENT_CONFIG_PATH,
      "$.agent",
      current.agent === null ? "without the text, summary and media capabilities" : "configured with text, summary and media"
    ));
    return null;
  }
  return next;
}

/**
 * 把一轮读取结果应用到主线程 holder，返回实际替换了哪些快照。同步执行：判定与
 * 替换之间不让出事件循环，调用方可以紧接着按返回值分发给 Worker。
 */
export function applyHotDeploymentConfigs(reads: HotDeploymentConfigReads): HotDeploymentConfigChanges {
  const rejections: string[] = [];
  const reloadedPaths: string[] = [];

  const adSamples: AdSampleConfig | null = nextFileSnapshot({
    read: reads.adSamples,
    current: defaultAdSampleConfigCache.current,
    path: AD_SAMPLES_CONFIG_PATH,
    rejections,
  });
  if (adSamples !== null) {
    adoptAdSampleConfig(adSamples);
    reloadedPaths.push(AD_SAMPLES_CONFIG_PATH);
  }

  const currentAgent: AgentConfigSnapshots = {
    adDetect: adDetectAgentConfigCache.current,
    agent: agentDeploymentConfigCache.current,
  };
  const agent: AgentConfigSnapshots | null = nextAgentSnapshots(reads.agent, currentAgent, rejections);
  let adDetectChanged: boolean = false;
  let aiAgentChanged: boolean = false;
  if (agent !== null) {
    if (!Bun.deepEquals(agent.adDetect, currentAgent.adDetect)) {
      adoptAdDetectAgentConfig(agent.adDetect);
      adDetectChanged = true;
    }
    // 两段「配没配」已与当前一致：AI 段有变化时新旧都不是 null。
    if (agent.agent !== null && !Bun.deepEquals(agent.agent, currentAgent.agent)) {
      adoptAgentDeploymentConfig(agent.agent);
      aiAgentChanged = true;
    }
  }
  if (adDetectChanged || aiAgentChanged) reloadedPaths.push(AGENT_CONFIG_PATH);

  const mood: MoodConfig | null = nextFileSnapshot({
    read: reads.mood,
    current: defaultMoodConfigCache.current,
    path: MOOD_CONFIG_PATH,
    rejections,
  });
  if (mood !== null) {
    adoptMoodConfig(mood);
    reloadedPaths.push(MOOD_CONFIG_PATH);
  }

  const stickers: StickerConfig | null = nextFileSnapshot({
    read: reads.stickers,
    current: defaultStickerConfigCache.current,
    path: STICKERS_CONFIG_PATH,
    rejections,
  });
  if (stickers !== null) {
    adoptStickerConfig(stickers);
    reloadedPaths.push(STICKERS_CONFIG_PATH);
  }

  return {
    adDetect: adDetectChanged,
    aiAgent: aiAgentChanged,
    adSamples: adSamples !== null,
    mood: mood !== null,
    stickers: stickers !== null,
    reloadedPaths,
    rejections,
  };
}
