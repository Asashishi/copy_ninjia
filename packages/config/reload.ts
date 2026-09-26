/**
 * config/dynamic/ 热重载的主线程判定：按启动总闸同一套严格解析器读取六份可热重载部署
 * 文件（assets.json、ad_samples.json、agent.json、mood.json、stickers.json、cron.json），
 * 再与主线程已生效快照比较并整体替换 holder。
 *
 * 判定口径（约束见 docs/cn/04-invariants.md）：
 * - 读不到（ENOENT 以外）或严格解析失败的变更整份拒绝，holder 保留上一份已校验快照；
 * - 文件真正不存在是合法状态：启动时存在的文件被删除，对应 holder 换成 null；启动时
 *   缺省的文件运行期出现，按新内容填充。agent.json 的 ad_detect 段与对话核心能力段
 *   同理，各段独立判定；
 * - 与当前快照深相等的内容不替换，holder 对象身份保持不变；
 * - assets.json 缺省即全部取内置缺省，删除文件时换回 DEFAULT_ASSET_CONFIG；随机图片目录
 *   与当前快照不同时，读取阶段先按启动同一口径准备并严格检查新目录，失败则拒绝
 *   assets.json 的变更；
 * - cron.json 的 send_voice 依赖 agent.json 的 `agent.tts`：新任务表用到 send_voice 而本轮
 *   生效的 agent 配置没有 tts 时拒绝 cron.json 的变更；任务表仍用 send_voice 时拒绝去掉
 *   tts 的 agent.json 变更。
 *
 * 一份文件内的变更要么整体生效、要么整体拒绝。拒绝诊断沿用 InputValidationError
 * 口径，只含文件路径、字段路径与期望形态。本模块只读盘并改写主线程 holder；
 * 功能可用性结论的重算、cron 调度对账、监听、日志与向 Worker 分发由
 * app/configReload.ts 负责。
 */

import { adoptAdSampleConfig, loadAdSampleConfig } from "./adSamples";
import { adoptAssetConfig, loadAssetConfig } from "./assets";
import {
  adoptAdDetectAgentConfig,
  adoptAgentDeploymentConfig,
  loadAgentConfigSnapshots,
} from "./agent";
import { adoptCronConfig, assertCronVoiceSupported, cronConfigUsesVoice, loadCronConfig } from "./cron";
import { adoptMoodConfig, loadMoodConfig } from "./mood";
import { deploymentInputExists } from "./readiness";
import { adoptStickerConfig, loadStickerConfig } from "./stickers";
import { assetConfigCache } from "../cache/main/assets";
import { cronConfigCache } from "../cache/main/cron";
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
  ASSETS_CONFIG_PATH,
  CRON_CONFIG_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
} from "../consts/paths";
import { DEFAULT_ASSET_CONFIG } from "../consts/ui/assets";
import { ensureRandomImageDirectory } from "../infra/randomImage";
import type { CronConfig } from "../types/cron";
import { InputValidationError } from "../libs/inputValidation";
import type {
  AdSampleConfig,
  AgentConfigSnapshots,
  AssetConfig,
  AgentTtsCapabilityConfig,
  HotConfigRead,
  HotDeploymentConfigChanges,
  HotDeploymentConfigReads,
  MoodConfig,
  StickerConfig,
} from "../types/config";
import { errorMessage } from "../libs/errorMessage";

/** 读取一份可热重载文件；只把 ENOENT 当作缺省，其余失败一律转成拒绝诊断。 */
async function readHotConfig<T>(
  path: string,
  load: (path: string) => Promise<T>
): Promise<HotConfigRead<T>> {
  try {
    if (!await deploymentInputExists(path)) return { kind: "absent" };
    return { kind: "loaded", value: await load(path) };
  } catch (error: unknown) {
    return { kind: "invalid", reason: errorMessage(error) };
  }
}

/**
 * 读取 assets.json；随机图片目录与当前快照不同时，接管之前先准备并严格检查新目录，
 * 失败按拒绝处理。
 */
async function readHotAssetConfig(): Promise<HotConfigRead<AssetConfig>> {
  const read: HotConfigRead<AssetConfig> = await readHotConfig(ASSETS_CONFIG_PATH, loadAssetConfig);
  if (read.kind === "invalid") return read;
  const directory: string = read.kind === "loaded"
    ? read.value.randomHImageDirectory
    : DEFAULT_ASSET_CONFIG.randomHImageDirectory;
  if (directory === assetConfigCache.current.randomHImageDirectory) return read;
  try {
    await ensureRandomImageDirectory(directory);
  } catch (error: unknown) {
    return { kind: "invalid", reason: errorMessage(error) };
  }
  return read;
}

/** 按固定顺序逐份读取六份可热重载部署文件；不改写任何 holder。 */
export async function readHotDeploymentConfigs(): Promise<HotDeploymentConfigReads> {
  const assets: HotConfigRead<AssetConfig> = await readHotAssetConfig();
  const adSamples: HotConfigRead<AdSampleConfig> = await readHotConfig(AD_SAMPLES_CONFIG_PATH, loadAdSampleConfig);
  const agent: HotConfigRead<AgentConfigSnapshots> = await readHotConfig(AGENT_CONFIG_PATH, loadAgentConfigSnapshots);
  const mood: HotConfigRead<MoodConfig> = await readHotConfig(MOOD_CONFIG_PATH, loadMoodConfig);
  const stickers: HotConfigRead<StickerConfig> = await readHotConfig(STICKERS_CONFIG_PATH, loadStickerConfig);
  const cron: HotConfigRead<CronConfig> = await readHotConfig(CRON_CONFIG_PATH, loadCronConfig);
  return { assets, adSamples, agent, mood, stickers, cron };
}

/** nextFileSnapshot 的入参：本轮读取结果、当前快照与拒绝诊断收集表。 */
interface FileSnapshotOptions<T> {
  readonly read: HotConfigRead<T>;
  readonly current: T | null;
  readonly rejections: string[];
}

/**
 * 判定单份文件要换成的快照：`undefined` 表示保持不变（内容相同、仍然缺省或被拒绝），
 * `null` 表示文件已被删除，其余为新内容。拒绝诊断写入 rejections。
 */
function nextFileSnapshot<T>({ read, current, rejections }: FileSnapshotOptions<T>): T | null | undefined {
  switch (read.kind) {
    case "invalid":
      rejections.push(read.reason);
      return undefined;
    case "absent":
      return current === null ? undefined : null;
    case "loaded":
      return current !== null && Bun.deepEquals(read.value, current) ? undefined : read.value;
  }
}

/** reconcileVoiceDependency 的入参：agent.json 与 cron.json 各自判定后的候选。 */
interface VoiceDependencyOptions {
  /** agent.json 的候选两段快照；undefined 表示本轮被拒绝，保持当前快照。 */
  readonly agent: AgentConfigSnapshots | undefined;
  /** cron.json 的候选；undefined 保持不变，null 表示文件已删除。 */
  readonly cron: CronConfig | null | undefined;
  readonly rejections: string[];
}

/** 交叉核对后真正生效的两份候选；语义同 VoiceDependencyOptions 的同名字段。 */
interface VoiceDependencyDecision {
  readonly agent: AgentConfigSnapshots | undefined;
  readonly cron: CronConfig | null | undefined;
}

/**
 * cron.json 的 send_voice 依赖 agent.json 的 `agent.tts`。先按本轮会生效的 agent 配置核对
 * 新任务表，缺 tts 时拒绝 cron.json 的变更；再按生效的任务表核对新 agent 配置，任务表仍用
 * send_voice 而新配置去掉了 tts 时拒绝 agent.json 的变更。两份文件都保持整体生效或整体拒绝。
 */
function reconcileVoiceDependency({ agent, cron, rejections }: VoiceDependencyOptions): VoiceDependencyDecision {
  const tts: AgentTtsCapabilityConfig | undefined = agent === undefined
    ? agentDeploymentConfigCache.current?.tts
    : agent.agent?.tts;
  let acceptedCron: CronConfig | null | undefined = cron;
  if (cron !== undefined && cron !== null) {
    try {
      assertCronVoiceSupported(cron, tts);
    } catch (error: unknown) {
      rejections.push(errorMessage(error));
      acceptedCron = undefined;
    }
  }
  const effectiveCron: CronConfig | null = acceptedCron === undefined ? cronConfigCache.current : acceptedCron;
  const dropsTts: boolean = agent !== undefined && tts === undefined &&
    agentDeploymentConfigCache.current?.tts !== undefined;
  if (dropsTts && effectiveCron !== null && cronConfigUsesVoice(effectiveCron)) {
    rejections.push(new InputValidationError(
      AGENT_CONFIG_PATH,
      "$.agent",
      "configured with text, summary, media and tts while config/dynamic/cron.json uses send_voice"
    ).message);
    return { agent: undefined, cron: acceptedCron };
  }
  return { agent, cron: acceptedCron };
}

/** 一轮热重载里已生效与已删除的文件路径收集表。 */
interface FileOutcomePaths {
  readonly reloadedPaths: string[];
  readonly removedPaths: string[];
}

/** 把一份文件的判定结果记进生效或删除清单；保持不变时不记。 */
function recordFileOutcome<T>(next: T | null | undefined, path: string, paths: FileOutcomePaths): void {
  if (next === undefined) return;
  if (next === null) paths.removedPaths.push(path);
  else paths.reloadedPaths.push(path);
}

/**
 * 把一轮读取结果应用到主线程 holder，返回实际替换了哪些快照。同步执行：判定与
 * 替换之间不让出事件循环，调用方可以紧接着按返回值重算可用性并分发给 Worker。
 */
export function applyHotDeploymentConfigs(reads: HotDeploymentConfigReads): HotDeploymentConfigChanges {
  const rejections: string[] = [];
  const paths: FileOutcomePaths = { reloadedPaths: [], removedPaths: [] };

  let assetsChanged: boolean = false;
  if (reads.assets.kind === "invalid") {
    rejections.push(reads.assets.reason);
  } else {
    const assets: Readonly<AssetConfig> = reads.assets.kind === "absent" ? DEFAULT_ASSET_CONFIG : reads.assets.value;
    if (!Bun.deepEquals(assets, assetConfigCache.current)) {
      adoptAssetConfig(assets);
      assetsChanged = true;
      if (reads.assets.kind === "absent") paths.removedPaths.push(ASSETS_CONFIG_PATH);
      else paths.reloadedPaths.push(ASSETS_CONFIG_PATH);
    }
  }

  const adSamples: AdSampleConfig | null | undefined = nextFileSnapshot({
    read: reads.adSamples,
    current: defaultAdSampleConfigCache.current,
    rejections,
  });
  if (adSamples !== undefined) adoptAdSampleConfig(adSamples);
  recordFileOutcome(adSamples, AD_SAMPLES_CONFIG_PATH, paths);

  // agent.json 与 cron.json 先各自判定、交叉核对 send_voice 与 agent.tts 之后再替换，
  // 见 reconcileVoiceDependency。
  let nextAgent: AgentConfigSnapshots | undefined;
  if (reads.agent.kind === "invalid") {
    rejections.push(reads.agent.reason);
  } else {
    // agent.json 缺省时两段都按未配置判定。
    nextAgent = reads.agent.kind === "absent" ? { adDetect: null, agent: null } : reads.agent.value;
  }
  const cronRead: CronConfig | null | undefined = nextFileSnapshot({
    read: reads.cron,
    current: cronConfigCache.current,
    rejections,
  });
  const { agent: acceptedAgent, cron }: VoiceDependencyDecision = reconcileVoiceDependency({
    agent: nextAgent,
    cron: cronRead,
    rejections,
  });

  let adDetectChanged: boolean = false;
  let aiAgentChanged: boolean = false;
  if (acceptedAgent !== undefined) {
    // 两段各自与当前快照比较、各自替换。
    if (!Bun.deepEquals(acceptedAgent.adDetect, adDetectAgentConfigCache.current)) {
      adoptAdDetectAgentConfig(acceptedAgent.adDetect);
      adDetectChanged = true;
    }
    if (!Bun.deepEquals(acceptedAgent.agent, agentDeploymentConfigCache.current)) {
      adoptAgentDeploymentConfig(acceptedAgent.agent);
      aiAgentChanged = true;
    }
    if (adDetectChanged || aiAgentChanged) {
      if (reads.agent.kind === "absent") paths.removedPaths.push(AGENT_CONFIG_PATH);
      else paths.reloadedPaths.push(AGENT_CONFIG_PATH);
    }
  }

  const mood: MoodConfig | null | undefined = nextFileSnapshot({
    read: reads.mood,
    current: defaultMoodConfigCache.current,
    rejections,
  });
  if (mood !== undefined) adoptMoodConfig(mood);
  recordFileOutcome(mood, MOOD_CONFIG_PATH, paths);

  const stickers: StickerConfig | null | undefined = nextFileSnapshot({
    read: reads.stickers,
    current: defaultStickerConfigCache.current,
    rejections,
  });
  if (stickers !== undefined) adoptStickerConfig(stickers);
  recordFileOutcome(stickers, STICKERS_CONFIG_PATH, paths);

  if (cron !== undefined) adoptCronConfig(cron);
  recordFileOutcome(cron, CRON_CONFIG_PATH, paths);

  return {
    assets: assetsChanged,
    adDetect: adDetectChanged,
    aiAgent: aiAgentChanged,
    adSamples: adSamples !== undefined,
    mood: mood !== undefined,
    stickers: stickers !== undefined,
    cron: cron !== undefined,
    reloadedPaths: paths.reloadedPaths,
    removedPaths: paths.removedPaths,
    rejections,
  };
}
