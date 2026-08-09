/**
 * 部署输入与已启用功能前提的启动总闸。
 *
 * 所有已存在的可选配置都先严格解析，即使对应功能当前关闭也不忽略
 * 非法输入（见 config/readiness.ts）。随后再依据 `state.json` 检查已启用
 * 功能的跨文件前提，避免静默降级。
 *
 * 位置在 loadState 之后、Telegram 客户端与任何 Worker 之前（见 app/lifecycle.ts）：
 * 判定要读群状态，而失败时只该有实例锁需要释放。
 */

import {
  adDetectConfigReadiness,
  aiChatConfigReadiness,
  jaTranslateConfigReadiness,
  validateExistingDeploymentInputs,
} from "../config/readiness";
import { getAllChatStates } from "../infra/storage/stateStore";
import type { ConfigReadiness } from "../types/config";

/** 单个可选功能的启动前提；requirement 返回缺失说明（英文），齐备时返回 null。 */
interface FeaturePrerequisite {
  /** ChatState 上表示「本群开着」的布尔字段。 */
  readonly toggle: "isAIChatEnabled" | "isAdDetectEnabled" | "isJATranslationEnabled";
  readonly requirement: () => string | null;
}

/** 把 readiness 的失败收敛成一句缺失说明。 */
function describeReadiness(readiness: ConfigReadiness): string | null {
  return readiness.ok ? null : readiness.failure.reason;
}

const FEATURE_PREREQUISITES: readonly FeaturePrerequisite[] = [
  {
    toggle: "isAIChatEnabled",
    requirement: (): string | null => describeReadiness(aiChatConfigReadiness()),
  },
  {
    toggle: "isAdDetectEnabled",
    requirement: (): string | null => describeReadiness(adDetectConfigReadiness()),
  },
  {
    toggle: "isJATranslationEnabled",
    requirement: (): string | null => describeReadiness(jaTranslateConfigReadiness()),
  },
];

/** 收集当前状态里开着某个功能的群 id。 */
function chatsWithToggle(toggle: FeaturePrerequisite["toggle"]): number[] {
  const chatIds: number[] = [];
  for (const [chatId, state] of getAllChatStates()) {
    if (state[toggle] === true) chatIds.push(chatId);
  }
  return chatIds;
}

/**
 * 逐个功能核对；任一「开着但前提缺失」立刻抛出，由 ApplicationLifecycle 的
 * 失败路径释放实例锁。全部通过时静默返回。
 *
 * 一次只报第一个：三个功能同时坏掉的概率远低于「运维照着第一条改完再重启」，
 * 而把三条堆进一个异常只会让真正要修的那一条更难认。
 */
export function preflightEnabledFeatures(): void {
  // 已存在的部署输入无论功能是否启用都必须合法；真正缺省的可选文件再由
  // 下方按已启用功能判断是否构成缺失前提。
  validateExistingDeploymentInputs();
  for (const prerequisite of FEATURE_PREREQUISITES) {
    const chatIds: number[] = chatsWithToggle(prerequisite.toggle);
    if (chatIds.length === 0) continue;
    const missing: string | null = prerequisite.requirement();
    if (missing === null) continue;
    throw new Error(missing);
  }
}
