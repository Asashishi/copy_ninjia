/**
 * config/ 热重载的主线程判定：按启动总闸同一套严格解析器读取五份可热重载部署
 * 文件（ad_samples.json、agent.json、mood.json、stickers.json、cron.json），再与主线程
 * 已生效快照比较并整体替换 holder。
 *
 * 判定口径（约束见 docs/cn/04-invariants.md）：
 * - 读不到（ENOENT 以外）或严格解析失败的变更整份拒绝，holder 保留上一份已校验快照；
 * - 文件真正不存在是合法状态：启动时存在的文件被删除，对应 holder 换成 null；启动时
 *   缺省的文件运行期出现，按新内容填充。agent.json 的 ad_detect 段与对话核心能力段
 *   同理，各段独立判定；
 * - 与当前快照深相等的内容不替换，holder 对象身份保持不变。
 *
 * 一份文件内的变更要么整体生效、要么整体拒绝。拒绝诊断沿用 InputValidationError
 * 口径，只含文件路径、字段路径与期望形态。本模块只读盘并改写主线程 holder；
 * 功能可用性结论的重算、cron 调度对账、监听、日志与向 Worker 分发由
 * app/configReload.ts 负责。
 */

import { adoptAdSampleConfig, loadAdSampleConfig } from "./adSamples";
import {
  adoptAdDetectAgentConfig,
  adoptAgentDeploymentConfig,
  loadAgentConfigSnapshots,
} from "./agent";
import { adoptCronConfig, loadCronConfig } from "./cron";
import { adoptMoodConfig, loadMoodConfig } from "./mood";
import { deploymentInputExists } from "./readiness";
import { adoptStickerConfig, loadStickerConfig } from "./stickers";
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
  CRON_CONFIG_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
} from "../consts/paths";
import type { CronConfig } from "../types/cron";
import type {
  AdSampleConfig,
  AgentConfigSnapshots,
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

/** 按固定顺序逐份读取五份可热重载部署文件；不改写任何 holder。 */
export async function readHotDeploymentConfigs(): Promise<HotDeploymentConfigReads> {
  const adSamples: HotConfigRead<AdSampleConfig> = await readHotConfig(AD_SAMPLES_CONFIG_PATH, loadAdSampleConfig);
  const agent: HotConfigRead<AgentConfigSnapshots> = await readHotConfig(AGENT_CONFIG_PATH, loadAgentConfigSnapshots);
  const mood: HotConfigRead<MoodConfig> = await readHotConfig(MOOD_CONFIG_PATH, loadMoodConfig);
  const stickers: HotConfigRead<StickerConfig> = await readHotConfig(STICKERS_CONFIG_PATH, loadStickerConfig);
  const cron: HotConfigRead<CronConfig> = await readHotConfig(CRON_CONFIG_PATH, loadCronConfig);
  return { adSamples, agent, mood, stickers, cron };
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

  const adSamples: AdSampleConfig | null | undefined = nextFileSnapshot({
    read: reads.adSamples,
    current: defaultAdSampleConfigCache.current,
    rejections,
  });
  if (adSamples !== undefined) adoptAdSampleConfig(adSamples);
  recordFileOutcome(adSamples, AD_SAMPLES_CONFIG_PATH, paths);

  let adDetectChanged: boolean = false;
  let aiAgentChanged: boolean = false;
  if (reads.agent.kind === "invalid") {
    rejections.push(reads.agent.reason);
  } else {
    // agent.json 缺省时两段都按未配置判定；两段各自与当前快照比较、各自替换。
    const next: AgentConfigSnapshots = reads.agent.kind === "absent"
      ? { adDetect: null, agent: null }
      : reads.agent.value;
    if (!Bun.deepEquals(next.adDetect, adDetectAgentConfigCache.current)) {
      adoptAdDetectAgentConfig(next.adDetect);
      adDetectChanged = true;
    }
    if (!Bun.deepEquals(next.agent, agentDeploymentConfigCache.current)) {
      adoptAgentDeploymentConfig(next.agent);
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

  const cron: CronConfig | null | undefined = nextFileSnapshot({
    read: reads.cron,
    current: cronConfigCache.current,
    rejections,
  });
  if (cron !== undefined) adoptCronConfig(cron);
  recordFileOutcome(cron, CRON_CONFIG_PATH, paths);

  return {
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
