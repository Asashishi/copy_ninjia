/**
 * 生歌消息的 caption 拼装：模型自己那句话 + 一段固定格式的曲目元信息。
 *
 * 元信息那两行是给群友看的「这是什么文件」——曲名/演唱者、容器、体积、码率，
 * 排版对齐常见音乐 bot 的样式。**只写算得出来的**：容器与体积恒有（mime 与字节
 * 数就在手里），码率要靠解析音频才有（见 utils/audioMetadata.ts），解析不出就
 * 整段省掉那一项，不填一个编出来的数。
 *
 * 时长不进 caption：它由 sendAudio 的 `duration` 参数交给 Telegram，直接显示在
 * 播放条上，写进 caption 只是同一件事说两遍。
 *
 * 纯函数叶子模块，不接触任何缓存与 SDK 类型（见 AGENTS.md 的「缓存与线程归属」）。
 */

import { SONG_METADATA_HASHTAG } from "../../../consts/aiChat/songGeneration";
import type { AudioTrackMetadata } from "./audioMetadata";
import { songFileExtension } from "./songPayload";

/** buildSongCaption 的入参。 */
export interface SongCaptionParams {
  /** 模型自己想对群友说的话；没写时 caption 只有元信息两行。 */
  readonly modelCaption: string | null;
  /** 已按上限收过的曲名。 */
  readonly title: string;
  /** 已按上限收过的演唱者。 */
  readonly performer: string;
  /** 音频字节数，用于算体积。 */
  readonly byteLength: number;
  /** 供应商声明的音频 mime，用于取容器标签。 */
  readonly mimeType: string;
  /** 解析出的时长与码率；认不出容器时为 null。 */
  readonly metadata: AudioTrackMetadata | null;
}

/** 体积按 MiB 保留两位；与 Telegram 播放条上那个大小是同一份字节数。 */
function formatSizeMb(byteLength: number): string {
  return `${(byteLength / 1024 / 1024).toFixed(2)}MB`;
}

/**
 * 拼出完整 caption；恒非空——曲目信息那两行无条件存在，模型没写话时它就是全部。
 */
export function buildSongCaption({
  modelCaption,
  title,
  performer,
  byteLength,
  mimeType,
  metadata,
}: SongCaptionParams): string {
  const bitrate: string = metadata === null ? "" : ` ${metadata.bitrateKbps.toFixed(2)}kbps`;
  const info: string =
    `「${title}」- ${performer}\n` +
    `${SONG_METADATA_HASHTAG} #${songFileExtension(mimeType)} ${formatSizeMb(byteLength)}${bitrate}`;
  return modelCaption === null ? info : `${modelCaption}\n\n${info}`;
}
