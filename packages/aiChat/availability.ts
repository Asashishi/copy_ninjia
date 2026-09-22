/**
 * AI 闲聊「此刻到底跑不跑」的唯一判定入口。
 *
 * 三个条件缺一不可：config/agent.json 的 AI 能力与凭据严格合法、辅助部署配置
 * 解析得动（config/{stickers,mood}.json 与 prompt/persona.md，见 config/readiness.ts）、本群开了
 * /ai_chat enable（ChatState.isAIChatEnabled，缺省关闭）。判定散在各调用点的话，
 * 前两个条件迟早会漏掉某一处——漏在投喂路径上就是每条群消息都去 Worker 里换一次
 * 「部署配置不可用」的错误日志，或让那条线程读配置
 * 时当场抛出、进而走完整套崩溃自愈；漏在 hydrate 上更糟：那条路把「本群没开」
 * 当成删除记忆的依据，前提临时缺失会被误读成全部群都关了，一次重启就把 memory/
 * 里的 AI 记忆全部删光。
 *
 * 单独成文件而不并进 aiChat/index.ts：那个模块在 import 期就登记 chatTeardown、
 * 建立 Worker 监督句柄，而命令与自动流水线只想问一句「开没开」。
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
