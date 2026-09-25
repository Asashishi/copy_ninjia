import type { AiRecordMediaMessage } from "../../types/aiChat/protocol";
import type { BotImageOrigin } from "../../types/aiChat/memory";
import { botImageTagTemplate } from "../../consts/aiChat/prompts/transcript";
import type { MediaKind } from "../../types/media";
import {
  ANIMATION_FALLBACK_PLACEHOLDER,
  ANIMATION_PENDING_PLACEHOLDER,
  IMAGE_FALLBACK_PLACEHOLDER,
  IMAGE_PENDING_PLACEHOLDER,
  STICKER_FALLBACK_PLACEHOLDER,
  STICKER_PENDING_PLACEHOLDER,
} from "../../consts/aiChat/media";
import { VOICE_FALLBACK_PLACEHOLDER, VOICE_PENDING_PLACEHOLDER } from "../../consts/aiChat/voice";

/** 媒体转录行/占位/回填标签的纯字符串拼装，供 mediaIngest.ts 的
 *  recordChatMedia、replyQueue.ts 的 pushReplyTrigger 与 botImages.ts 共用。 */

/** 媒体刚入缓存、描述还没解析出来时的占位文本，按类型区分措辞。 */
export function pendingPlaceholderFor(kind: MediaKind): string {
  switch (kind) {
    case "sticker":
      return STICKER_PENDING_PLACEHOLDER;
    case "animation":
      return ANIMATION_PENDING_PLACEHOLDER;
    case "voice":
      return VOICE_PENDING_PLACEHOLDER;
    default:
      return IMAGE_PENDING_PLACEHOLDER;
  }
}

/** 解析成功后回填的描述标签，按类型区分措辞。 */
export function resolvedTagFor(kind: MediaKind, description: string): string {
  switch (kind) {
    case "sticker":
      return `[贴纸：${description}]`;
    case "animation":
      return `[GIF：${description}]`;
    case "voice":
      return `[语音：${description}]`;
    default:
      return `[图片：${description}]`;
  }
}

/** 解析失败时回填的兜底文本：贴纸退回原有的元数据行（不丢失 emoji/包名
 *  信息，见 aiChat/ai/stickers/describe.ts 的 describeStickerForContext），图片/GIF/
 *  语音用各自的通用失败说明。 */
export function fallbackTextFor(kind: MediaKind, msg: AiRecordMediaMessage): string {
  if (kind === "sticker") return msg.stickerFallbackText ?? STICKER_FALLBACK_PLACEHOLDER;
  if (kind === "animation") return ANIMATION_FALLBACK_PLACEHOLDER;
  if (kind === "voice") return VOICE_FALLBACK_PLACEHOLDER;
  return IMAGE_FALLBACK_PLACEHOLDER;
}

/** 拿媒体回复机器人但解析失败时，喂给必回指令的内容描述。贴纸退回元数据
 *  行仍有信息量；图片/GIF/语音的常规兜底文案写着「请无视此消息」，塞进「别
 *  已读不回」的指令里自相矛盾（模型可能听话地沉默），换成明说没看清/没听清，
 *  让模型自然回一句「看不清」而不是被指示无视。 */
export function replyFallbackDescriptionFor(msg: AiRecordMediaMessage): string {
  if (msg.kind === "sticker" && msg.stickerFallbackText) return msg.stickerFallbackText;
  if (msg.kind === "voice") return "（这条语音没能识别出来，你没听清对方说了什么）";
  return "（画面内容没能识别出来，你没看清对方发了什么）";
}

/** 机器人自发图片的转录正文：自录记号紧接已清洗的图注。detail 在占位态是生图
 *  提示词（命令图为空串），内容态是识图描述，记号选择见 botImageTagTemplate。 */
export function botImageText(origin: BotImageOrigin, detail: string, caption: string): string {
  return `${botImageTagTemplate(origin, detail)}${caption}`;
}
