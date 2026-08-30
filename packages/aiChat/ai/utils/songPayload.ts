/**
 * 生歌结果载荷的校验与解码。
 *
 * 与 imagePayload.ts 分开而不是共用一个泛化的解码器：两者的门禁**不同**。图片
 * 那侧靠字节签名核对声明的 MIME，因为 PNG/JPEG 的魔数是稳定的两种；音频这侧
 * 拿到的容器由供应商决定（Lyria 默认 MP3，也可请求 WAV），逐一维护魔数表只会
 * 在换容器时静默把一首正常的歌判死。这里改为「只认 audio/* 且体积在上限内」，
 * 容器正确性交给 Telegram 与播放端。
 *
 * 规范性判定与两道大小上限复用 ./base64Payload.ts 的公共解码闸——那一段与载荷类型
 * 无关，两份实现只会漂移；上限按生歌自己的常量传入。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import {
  SONG_GENERATION_MAX_BYTES,
  SONG_GENERATION_MAX_ENCODED_CHARS,
} from "../../../consts/aiChat/songGeneration";
import type { GeneratedSongDecodeResult } from "../../../types/aiChat/songGeneration";
import type { Base64PayloadDecodeResult } from "../../../types/aiChat/payload";
import { decodeBase64Payload } from "./base64Payload";

/**
 * 把一段模型返回的 base64 音频收窄成可发送的歌曲。
 *
 * 失败带回原因而不是裸 null：一次生成就是一笔按首计的账单，调用方只记一句
 * 「生歌失败」的话，日志里就没有任何一行能分辨「载荷超限」「网关回了脏 base64」
 * 与「模型压根没给音频」。记日志留给调用方，本模块保持纯函数叶子。
 *
 * @param encoded 标准 base64（无换行）。
 * @param mimeType 供应商声明的音频 MIME；必须以 `audio/` 开头。
 */
export function decodeGeneratedSong(
  encoded: string,
  mimeType: string | undefined
): GeneratedSongDecodeResult {
  if (typeof mimeType !== "string" || !mimeType.startsWith("audio/")) {
    return { ok: false, reason: "missing audio mime type" };
  }
  // 编码态上限先挡住异常大响应，避免解码后才发现超限而额外分配一份最多不可控
  // 大小的字节数组；整首歌本来就有几 MB，这一步不是可省的保险。
  const decoded: Base64PayloadDecodeResult = decodeBase64Payload({
    encoded,
    maxEncodedChars: SONG_GENERATION_MAX_ENCODED_CHARS,
    maxBytes: SONG_GENERATION_MAX_BYTES,
  });
  if (!decoded.ok) return decoded;
  return { ok: true, song: { bytes: decoded.bytes, mimeType } };
}

/**
 * 按音频 MIME 推出 Telegram 上传要用的文件扩展名。
 *
 * Bot API 靠文件名扩展名判定容器：扩展名与真实容器对不上时，客户端会拿到一条
 * 点开就报错的音频。认不出的容器统一退回 `mp3`——那是 Lyria 的默认输出，也是
 * 这条路上唯一会大量出现的容器。
 */
export function songFileExtension(mimeType: string): string {
  switch (mimeType) {
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/ogg":
      return "ogg";
    case "audio/flac":
      return "flac";
    case "audio/aac":
      return "aac";
    case "audio/m4a":
    case "audio/mp4":
      return "m4a";
    default:
      return "mp3";
  }
}
