import type { CommandContext, Context } from "grammy";
import { publishChatProvider } from "../aiChat";
import { CHAT_MODEL_TEXTS } from "../consts/commands";
import { getChatProviderOverride, setChatProviderOverride } from "../infra/storage/stateStore";
import { handleProviderModelCommand, type ProviderModelCommand } from "./providerModel";

/**
 * `/chat_model gpt|gemini`：切换闲聊侧用哪家供应商，所有群共用同一份选择
 * （见 types/chatState.ts 的 GlobalModelState.chat，落盘在
 * state.global.model.chat）。
 *
 * **覆盖生图以外的三项能力**：回复会话、纯文本（记忆压缩的中期摘要与贴纸包
 * 摘要）与视觉描述。画图另由 `/image_model` 管，两条合起来正好铺满
 * AiChatProvider 契约的四项，互不重叠。
 *
 * 切换只在**下一轮回复**生效：replyModel.ts 在进入工具循环之前就
 * createReplySession，在途那轮已经绑定了实现，不会被劈成两套格式（见
 * aiChat/provider.ts 的 chatAiProvider）。回执文案已经说明这一点。
 *
 * 权限、参数别名、两把 key 的门禁与「落盘先于推送」的次序全部收在
 * commands/providerModel.ts，本文件只描述这条命令的差异。
 */
const CHAT_MODEL_COMMAND: ProviderModelCommand = {
  texts: CHAT_MODEL_TEXTS,
  persistContext: "chat_model switched",
  selected: getChatProviderOverride,
  select: setChatProviderOverride,
  publish: publishChatProvider,
};

export function handleChatModelCommand(ctx: CommandContext<Context>): Promise<void> {
  return handleProviderModelCommand(ctx, CHAT_MODEL_COMMAND);
}
