/**
 * AI 闲聊供应商的唯一选取入口。两个实现包（packages/aiChat/gemini/、
 * packages/aiChat/openai/）都实现同一份 AiChatProvider 契约，领域侧只经这里
 * 拿实现，不 import 任何一家的子模块，也不认识任何 SDK 类型。
 *
 * 选取规则：默认 Gemini；只有在 Gemini 凭据缺席时才降级到 OpenAI。两把都
 * 没有时整条 AI 闲聊线不启动（判定在 aiChat/availability.ts，那里只看 env、
 * 不 import 本文件——主线程侧不该为了问一句「开没开」把两家 SDK 都拉进来）。
 *
 * 不做**自动**的运行时故障切换：一轮回复中途换供应商会让工具往返的对话记录跨
 * 两套格式，且两家的安全档位与画幅能力并不等价，静默切换等于让同一个群的回复
 * 口径无预警地漂移。
 *
 * 超管的显式切换是另一回事，两条命令各管一半、合起来铺满契约的四项能力：
 * - `/image_model` -> imageAiProvider()：生图。单次无状态请求，没有跨轮对话记录，
 *   换家不会让任何一段记录跨两套格式；画幅差异已由各实现包内部收口
 *   （aiChat/openai/image.ts 的 pickImageSize 把十档官方宽高比映射到三档）。
 * - `/chat_model` -> chatAiProvider()：回复会话、纯文本（记忆压缩的中期摘要、
 *   贴纸包摘要）与视觉描述。这条能安全切换的边界是**每轮回复只取一次**：
 *   workers/aiChat/replyModel.ts 在进入工具循环之前就 createReplySession，会话
 *   对象自己持有实现，因此切换只在下一轮回复生效，在途的那轮不会被劈成两半。
 *   纯文本与视觉本来就是单次无状态请求。跨轮之间没有供应商专属状态：落盘的
 *   AI 记忆快照是本仓自有的中立结构，两家共用同一份。
 *
 * 两条命令都不影响上面那道「两把 key 都没有就不启动」的门禁。反过来，**选过的
 * 那一家缺 key 时进程根本起不来**——启动闸在 app/featurePreflight.ts，因此下面
 * 两个入口拿到的选定值必定有对应凭据。
 *
 * 归属 AI 闲聊 Worker：全部调用方都在那条线程上。
 */

import { geminiProvider } from "./gemini";
import { openAiProvider } from "./openai";
import { chatProviderOverrideMirror } from "../cache/workers/aiChat/chatProvider";
import { imageProviderOverrideMirror } from "../cache/workers/aiChat/imageProvider";
import { AI_CHAT_GEMINI_API_KEY, AI_CHAT_OPENAI_API_KEY } from "../infra/config";
import type { AiChatProvider, AiProviderName } from "../types/aiChat/provider";

/**
 * 当前进程该用哪家供应商。
 *
 * 每次调用现查 env 而不是在模块求值期定死：config.ts 的两把密钥都是可选
 * env，模块加载顺序在测试与 Worker 重建路径上并不稳定，现查才能保证判定与
 * availability.ts 的门禁看到的是同一份配置。两把都缺时抛错——走到这里说明
 * 门禁已经放行过一次，是配置在进程启动后被抽掉，调用方各自的降级路径会把它
 * 归一成一次普通失败。
 */
export function activeAiProvider(): AiChatProvider {
  if (AI_CHAT_GEMINI_API_KEY !== undefined) return geminiProvider;
  if (AI_CHAT_OPENAI_API_KEY !== undefined) return openAiProvider;
  throw new Error("No AI chat provider is configured; set AI_CHAT_GEMINI_API_KEY or AI_CHAT_OPENAI_API_KEY.");
}

/**
 * 按选定值取实现；没选过就跟随默认选取。
 *
 * 选过的那一家缺凭据时**抛错而不是换一家**：静默换家会让同一个群的回复口径
 * 无预警漂移，正是模块头注拒绝的事。这条分支在正常部署上走不到——
 * app/featurePreflight.ts 的启动闸已经拒绝「选过 X 却没有 X 的 key」的进程，
 * 而 `.env` 在进程存活期间不会变、两条切换命令又都要求两把 key 都在。留着它是
 * 兜底：真走到了，说明启动闸被绕过或状态在运行期被外部改写，那时报错必须点名
 * 是哪一项、缺哪把 key，而不是让人从「回复风格怎么变了」倒查。
 */
function resolveSelected(selected: AiProviderName | null): AiChatProvider {
  if (selected === null) return activeAiProvider();
  if (selected === "openai") {
    if (AI_CHAT_OPENAI_API_KEY === undefined) {
      throw new Error('The selected AI provider is "openai" but AI_CHAT_OPENAI_API_KEY is not set.');
    }
    return openAiProvider;
  }
  if (AI_CHAT_GEMINI_API_KEY === undefined) {
    throw new Error('The selected AI provider is "gemini" but AI_CHAT_GEMINI_API_KEY is not set.');
  }
  return geminiProvider;
}

/**
 * 生图该用哪家。只影响生图这一项能力；回复会话、纯文本与视觉描述走
 * chatAiProvider()。
 *
 * 覆盖值由超管的 `/image_model` 写进 state.json，经协议推到本线程的只读镜像
 * （见 cache/workers/aiChat/imageProvider.ts）。
 */
export function imageAiProvider(): AiChatProvider {
  return resolveSelected(imageProviderOverrideMirror.current);
}

/**
 * 回复会话、纯文本与视觉描述该用哪家。不影响生图，那一项由 imageAiProvider()
 * 独立决定。
 *
 * 覆盖值由超管的 `/chat_model` 写进 state.json，经协议推到本线程的只读镜像
 * （见 cache/workers/aiChat/chatProvider.ts）。
 *
 * **每轮回复只在 createReplySession 之前取一次**（workers/aiChat/replyModel.ts），
 * 因此切换只在下一轮生效，在途的那轮不会被劈成两套格式——理由见模块头注。
 */
export function chatAiProvider(): AiChatProvider {
  return resolveSelected(chatProviderOverrideMirror.current);
}
