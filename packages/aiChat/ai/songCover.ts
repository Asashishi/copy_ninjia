/**
 * 生歌消息的封面缩略图：按曲目信息调一次图片模型，压成 Telegram 能收的 JPEG。
 *
 * 与 generate_image 工具的调用路径完全分开：不占每群生图冷却、不计入本轮动作
 * 预算、不进自录记忆——这些限额只存在于 aiChat/ai/tools/replyToolset/imageGeneration.ts，
 * 本模块直接调用 generateChatImage，不经过那一层。
 *
 * 任一步失败（含逃出下层 try/catch 的异常）一律返回 null 并静默处理；调用方
 * 按「这次没有封面」继续发歌，已生成、已计费的歌曲本身不受影响。正常失败由
 * 底层各自记日志（生图在实现包里，压缩在 infra/image.ts）；只有逃出下层契约
 * 的异常在这里补记一行英文日志。
 *
 * 跑在 AI 闲聊 Worker 线程上（调用方就是生歌工具）。
 */

import {
  SONG_COVER_JPEG_QUALITIES,
  SONG_COVER_MAX_BYTES,
  SONG_COVER_MAX_EDGE,
} from "../../consts/aiChat/songGeneration";
import { DEFAULT_IMAGE_GENERATION_ASPECT_RATIO } from "../../consts/aiChat/imageGeneration";
import { songCoverPrompt } from "../../consts/aiChat/prompts/song";
import { logger } from "../../infra/logger";
import { prepareThumbnailJpeg } from "../../infra/image";
import { generateChatImage } from "./imageGeneration";
import type { GeneratedChatImage } from "../../types/aiChat/imageGeneration";

/** generateSongCover 的入参；三项都只作为封面画面的气氛线索。 */
export interface SongCoverParams {
  /** 曲名。 */
  title: string;
  /** 演唱者。 */
  performer: string;
  /** 交给音乐模型的创作说明。 */
  songPrompt: string;
  /** 本轮生成的取消信号；与生歌请求同一个。 */
  signal?: AbortSignal;
}

/**
 * 画一张封面并压成缩略图；任一步失败返回 null。
 *
 * 画幅固定正方形：封面与客户端缩略图都是方形，避免生成最终会被裁掉的边缘内容。
 */
export async function generateSongCover({
  title,
  performer,
  songPrompt,
  signal,
}: SongCoverParams): Promise<Uint8Array | null> {
  try {
    const image: GeneratedChatImage | null = await generateChatImage({
      prompt: songCoverPrompt(title, performer, songPrompt),
      aspectRatio: DEFAULT_IMAGE_GENERATION_ASPECT_RATIO,
      ...(signal ? { signal } : {}),
    });
    if (!image) return null;
    // 字节按引用交给压缩，不 Buffer.from 复制一份：一张 1K 生图有几 MB，而
    // sharp 本来就接收 Uint8Array（见 infra/image.ts 的入参类型）。
    return await prepareThumbnailJpeg({
      bytes: image.bytes,
      maxEdge: SONG_COVER_MAX_EDGE,
      maxBytes: SONG_COVER_MAX_BYTES,
      qualities: SONG_COVER_JPEG_QUALITIES,
    });
  } catch (error: unknown) {
    // 本轮被作废时 signal 已 abort，那不是故障，不记日志。
    if (signal?.aborted !== true) logger.error("Error generating a song cover:", error);
    return null;
  }
}
