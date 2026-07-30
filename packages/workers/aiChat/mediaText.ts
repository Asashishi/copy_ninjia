import type { AiRecordMediaMessage } from "../../types/aiChat/protocol";
import type { MediaKind } from "../../types/media";
import {
  ANIMATION_FALLBACK_PLACEHOLDER,
  ANIMATION_PENDING_PLACEHOLDER,
  IMAGE_FALLBACK_PLACEHOLDER,
  IMAGE_PENDING_PLACEHOLDER,
  STICKER_FALLBACK_PLACEHOLDER,
  STICKER_PENDING_PLACEHOLDER,
} from "../../consts/aiChat/media";

/** 媒体转录行/占位/回填标签的纯字符串拼装，供 mediaIngest.ts 的
 *  recordChatMedia 与 replyQueue.ts 的 pushReplyTrigger 共用。 */

/** 媒体转录行：描述/占位标签在前，媒体自带的 caption（若有）跟在后面
 *  （贴纸没有 caption，恒为空串，等价于直接返回标签本身）。 */
export function composeMediaText(tag: string, sanitizedCaption: string): string {
  return sanitizedCaption ? `${tag} ${sanitizedCaption}` : tag;
}

/** 媒体刚入缓存、描述还没解析出来时的占位文本，按类型区分措辞。 */
export function pendingPlaceholderFor(kind: MediaKind): string {
  switch (kind) {
    case "sticker":
      return STICKER_PENDING_PLACEHOLDER;
    case "animation":
      return ANIMATION_PENDING_PLACEHOLDER;
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
    default:
      return `[图片：${description}]`;
  }
}

/** 解析失败时回填的兜底文本：贴纸退回原有的元数据行（不丢失 emoji/包名
 *  信息，见 ai/stickers/describe.ts 的 describeStickerForContext），图片/GIF 用
 *  通用的失败说明。 */
export function fallbackTextFor(kind: MediaKind, msg: AiRecordMediaMessage): string {
  if (kind === "sticker") return msg.stickerFallbackText ?? STICKER_FALLBACK_PLACEHOLDER;
  if (kind === "animation") return ANIMATION_FALLBACK_PLACEHOLDER;
  return IMAGE_FALLBACK_PLACEHOLDER;
}

/** 拿媒体回复机器人但解析失败时，喂给必回指令的内容描述。贴纸退回元数据
 *  行仍有信息量；图片/GIF 的常规兜底文案写着「请无视此消息」，塞进「别
 *  已读不回」的指令里自相矛盾（模型可能听话地沉默），换成明说没看清，
 *  让模型自然回一句「看不清」而不是被指示无视。 */
export function replyFallbackDescriptionFor(msg: AiRecordMediaMessage): string {
  if (msg.kind === "sticker" && msg.stickerFallbackText) return msg.stickerFallbackText;
  return "（画面内容没能识别出来，你没看清对方发了什么）";
}
