import type { Sticker, PhotoSize } from "@grammyjs/types";
import { stickerSentTagTemplate } from "../../../consts/aiChat/prompts/transcript";
import type { TelegramVisionSource } from "../../../types/media";

/**
 * 贴纸的两个纯函数：挑选视觉解析素材来源（pickStickerVisionSource）与把贴纸
 * 转成对话缓存里的一行文本（describeStickerForContext）。
 *
 * 刻意与 aiChat/ai/stickers/sets.ts 分开成一个不碰任何缓存的叶子模块：这两个函数是
 * **主线程**的消息流水线（auto/message/sticker.ts、auto/message/text.ts）在把
 * 贴纸投给 AI Worker 之前就要用的，而 sets.ts 持有 AI Worker 独占的贴纸集合
 * 缓存（cache/workers/aiChat/stickers/sets.ts）。合在一起时主线程 import 一个
 * 纯函数就会把那几张只属于 Worker 的 Map 在主线程 isolate 里也实例化一份
 * ——永远是空的，纯属把别的线程的状态搬到了不该在的地方。
 */

/**
 * 选出一枚贴纸用于视觉解析的下载素材：静态贴纸（is_animated/is_video 均为
 * false）本体就是 webp 图片，直接下载；动态贴纸（tgs，Lottie 矢量动画）和
 * 视频贴纸（webm）都没有能直接喂视觉模型的静态画面，本项目也没有解码
 * 能力，改用 Telegram 自带的缩略图（webp 或 jpg）代替；两者都没有则放弃
 * 视觉解析，返回 null。
 *
 * 返回的 fileUniqueId 恒为贴纸自身的 file_unique_id（贴纸的身份），与实际
 * 下载来源（本体或缩略图）解耦——保证同一枚贴纸无论走哪条素材来源，描述
 * 都记在同一个缓存/目录键下，见 aiChat/ai/imageDescription.ts 的 describeMedia、
 * aiChat/ai/stickers/catalog.ts 的目录条目键。
 */
export function pickStickerVisionSource(sticker: Sticker): TelegramVisionSource | null {
  const source: PhotoSize | undefined = !sticker.is_animated && !sticker.is_video ? sticker : sticker.thumbnail;
  if (!source) return null;
  return {
    fileId: source.file_id,
    fileUniqueId: sticker.file_unique_id,
    width: source.width,
    height: source.height,
  };
}

/** describeStickerForContext 读取的贴纸元数据；两项都可能缺失。 */
export interface DescribeStickerForContextParams {
  /** 贴纸的情绪 emoji。 */
  emoji?: string;
  /** 所属贴纸包名。 */
  set_name?: string;
}

/**
 * 把一枚贴纸描述成 AI 对话缓存里的一行文本，带上模型能参考的元数据：
 * 贴纸的情绪 emoji 和所属贴纸包名，以及（若有）画面描述。三者都可能缺失
 * （无 emoji 的贴纸、不属于任何包的贴纸、没有目录/视觉解析结果的贴纸），
 * 按有什么写什么。群友发的贴纸和机器人自己发的贴纸都用这个格式记录。
 * @param visualDescription 画面描述（贴纸目录条目或视觉解析结果，见
 *   aiChat/ai/stickers/catalog.ts、aiChat/ai/imageDescription.ts 的 describeMedia）；没有则
 *   省略这部分，退化为原有的纯元数据行。
 */
export function describeStickerForContext(sticker: DescribeStickerForContextParams, visualDescription?: string): string {
  const parts: string[] = [];
  if (visualDescription) parts.push(`画面：${visualDescription}`);
  if (sticker.emoji) parts.push(`情绪含义 ${sticker.emoji}`);
  if (sticker.set_name) parts.push(`来自贴纸包「${sticker.set_name}」`);
  return stickerSentTagTemplate(parts.join("，"));
}
