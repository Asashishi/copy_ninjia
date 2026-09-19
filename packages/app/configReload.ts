/**
 * config/ 部署配置热重载的主线程 owner（状态见 cache/main/configReload.ts）。
 *
 * 目录级 `fs.watch` 覆盖原地写入、临时文件改名替换、删除与重建；任何事件只重新
 * 武装一次防抖 timer，到期后由最新值执行器串行跑一轮：config/reload.ts 读取并
 * 严格解析四份可热重载文件 → 同步替换主线程 holder → 把变化投给持有副本的
 * Worker（AI 闲聊：agent 对话段、mood、stickers；Anti-Raid：ad_detect 段与广告
 * 示例）。一轮在途时到达的事件合并成至多一轮补跑。
 *
 * 被拒绝的变更逐条记英文错误日志，对应快照保持上一份已校验版本；可用性判定与
 * 拒绝口径见 config/reload.ts。watcher 与 timer 均 unref，不扣住进程退出；停机
 * 由 quiesceConfigReload 在维护关闸阶段停止接纳，在途读取完成后不再分发。
 */

import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { syncAiChatConfig } from "../aiChat";
import { syncAntiRaidAgentConfig } from "../antiRaid";
import { configReloadRuntime } from "../cache/main/configReload";
import { applyHotDeploymentConfigs, readHotDeploymentConfigs } from "../config/reload";
import { CONFIG_RELOAD_DEBOUNCE_MS } from "../consts/configReload";
import { CONFIG_ROOT } from "../consts/paths";
import { logger } from "../infra/logger";
import { createLatestValueRunner } from "../libs/latestValueRunner";
import type { HotDeploymentConfigChanges, HotDeploymentConfigReads } from "../types/config";

/** 读取、应用并分发一轮；停止接纳后读完的结果直接丢弃。 */
async function reconcileDeploymentConfigs(): Promise<void> {
  const reads: HotDeploymentConfigReads = await readHotDeploymentConfigs();
  if (!configReloadRuntime.accepting) return;
  const changes: HotDeploymentConfigChanges = applyHotDeploymentConfigs(reads);
  for (const rejection of changes.rejections) {
    logger.error(`Rejected a runtime deployment config change; keeping the last validated snapshot: ${rejection}`);
  }
  for (const path of changes.reloadedPaths) {
    logger.log(`Reloaded deployment config ${path}.`);
  }
  if (changes.aiAgent || changes.mood || changes.stickers) syncAiChatConfig(changes);
  if (changes.adDetect || changes.adSamples) syncAntiRaidAgentConfig();
}

/** 防抖到期：交给执行器跑一轮；执行器拒绝只记日志，下一次事件照常重试。 */
function runConfigReload(): void {
  configReloadRuntime.debounceTimer = null;
  const runner: typeof configReloadRuntime.runner = configReloadRuntime.runner;
  if (!configReloadRuntime.accepting || runner === null) return;
  runner.push(null).catch((error: unknown): void => {
    logger.error("Deployment config reload failed:", error);
  });
}

/** 每个目录事件重新武装防抖 timer。 */
function scheduleConfigReload(): void {
  if (!configReloadRuntime.accepting) return;
  if (configReloadRuntime.debounceTimer !== null) clearTimeout(configReloadRuntime.debounceTimer);
  const timer: ReturnType<typeof setTimeout> = setTimeout(runConfigReload, CONFIG_RELOAD_DEBOUNCE_MS);
  timer.unref();
  configReloadRuntime.debounceTimer = timer;
}

/** watcher 自身失效后关闭它；本进程余下时间不再热重载，重启后恢复。 */
function handleWatcherError(error: unknown): void {
  logger.error("Deployment config watcher failed; runtime config reload stays off until restart:", error);
  configReloadRuntime.watcher?.close();
  configReloadRuntime.watcher = null;
}

/**
 * 开始监听 config/。须在 AI 闲聊与 Anti-Raid 初始化之后调用，保证首轮分发时
 * Worker 已持有初始快照；启动总闸到监听建立之间的改动没有事件可等，因此
 * 建立后立即对账一轮。watcher 建立失败时记错误日志，本进程不热重载，已生效
 * 配置照常运行。重复调用不重复建立 watcher。
 */
export function startConfigReload(): void {
  if (configReloadRuntime.watcher !== null) return;
  let watcher: FSWatcher;
  try {
    watcher = watch(CONFIG_ROOT, scheduleConfigReload);
  } catch (error: unknown) {
    logger.error("Deployment config watcher could not start; runtime config reload stays off until restart:", error);
    return;
  }
  configReloadRuntime.runner ??= createLatestValueRunner<null>(reconcileDeploymentConfigs);
  configReloadRuntime.accepting = true;
  watcher.on("error", handleWatcherError);
  watcher.unref();
  configReloadRuntime.watcher = watcher;
  runConfigReload();
}

/** 停机维护关闸：停止接纳事件、清除防抖 timer 并关闭 watcher；可重复调用。 */
export function quiesceConfigReload(): void {
  configReloadRuntime.accepting = false;
  if (configReloadRuntime.debounceTimer !== null) {
    clearTimeout(configReloadRuntime.debounceTimer);
    configReloadRuntime.debounceTimer = null;
  }
  configReloadRuntime.watcher?.close();
  configReloadRuntime.watcher = null;
}
