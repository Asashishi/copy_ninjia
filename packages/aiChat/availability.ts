/**
 * AI 闲聊「此刻是否运行」的唯一判定入口。
 *
 * 三个条件缺一不可：config/agent.json 的 AI 能力与凭据严格合法、辅助部署配置
 * 解析成功（config/{stickers,mood}.json 与 prompt/persona.md，见 config/readiness.ts）、
 * 本群已执行 /ai_chat enable（ChatState.isAIChatEnabled，缺省关闭）。
 */

import { aiChatConfigReadiness } from "../config/readiness";
import { getChatState } from "../infra/storage/stateStore";

/**
 * 进程侧是否具备跑 AI 闲聊的前提（agent 能力配置 + 三份辅助部署配置）。为假时整条线停摆：
 * 投喂与回复关闭，/ai_chat enable 与 /mood switch 直接拒绝。启动时就不可用则 AI Worker
 * 不启动、记忆只进主线程镜像不投递（一条都不删，等前提补齐）；运行期经 config/ 热重载
 * 变为不可用时 Worker 保持闲置。前提补齐后由 aiChat/hydration.ts 的 resumeAiChat 恢复。
 */
export function isAiChatConfigured(): boolean {
  return aiChatConfigReadiness().ok;
}

/**
 * 某群此刻是否真的在跑 AI 闲聊：进程侧前提齐备且本群 opt-in。投喂消息、
 * 触发回复、自录内联结果之前都要过这一关。
 */
export function isAiChatActiveIn(chatId: number): boolean {
  return isAiChatConfigured() && getChatState(chatId).isAIChatEnabled === true;
}
