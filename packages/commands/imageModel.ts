import type { CommandContext, Context } from "grammy";
import { publishImageProvider } from "../aiChat";
import { IMAGE_MODEL_TEXTS } from "../consts/commands";
import { getImageProviderOverride, setImageProviderOverride } from "../infra/storage/stateStore";
import { handleProviderModelCommand, type ProviderModelCommand } from "./providerModel";

/**
 * `/image_model gpt|gemini`：切换本天才生图用哪家供应商，所有群共用同一份选择
 * （见 types/chatState.ts 的 GlobalModelState.image，落盘在
 * state.global.model.image）。
 *
 * **只换生图**。回复会话、记忆压缩与视觉描述另由 `/chat_model` 决定；生图能独立
 * 换家，是因为它是单次无状态请求，没有跨轮对话记录会因此跨两套格式（理由写在
 * aiChat/provider.ts 的头注里）。
 *
 * 权限、参数别名、两把 key 的门禁与「落盘先于推送」的次序全部收在
 * commands/providerModel.ts，本文件只描述这条命令的差异。
 */
const IMAGE_MODEL_COMMAND: ProviderModelCommand = {
  texts: IMAGE_MODEL_TEXTS,
  persistContext: "image_model switched",
  selected: getImageProviderOverride,
  select: setImageProviderOverride,
  publish: publishImageProvider,
};

export function handleImageModelCommand(ctx: CommandContext<Context>): Promise<void> {
  return handleProviderModelCommand(ctx, IMAGE_MODEL_COMMAND);
}
