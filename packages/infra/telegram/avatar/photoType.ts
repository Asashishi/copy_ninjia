import type { InputProfilePhoto } from "grammy/types";
import {
  BOT_PROFILE_ANIMATION_MAX_BYTES,
  BOT_PROFILE_ANIMATION_MAX_SIDE,
  BOT_PROFILE_PHOTO_MAX_BYTES,
} from "../../../consts/telegram";
import { sniffImageFormat } from "../../image";
import type { SniffedImageFormat } from "../../image";
import { readMp4VideoTracks } from "../../video";
import type { Mp4VideoTrack } from "../../../types/media";

/**
 * 按字节签名、大小与视频轨尺寸判定默认头像素材的上传形态：不超过 BOT_PROFILE_PHOTO_MAX_BYTES 的 JPEG/PNG
 * 是静态头像；不超过 BOT_PROFILE_ANIMATION_MAX_BYTES、至少有一条视频轨且每条视频轨都是边长不超过
 * BOT_PROFILE_ANIMATION_MAX_SIDE 的非零正方形的 MP4 是动态头像。其余返回 null，期望形态见
 * DEFAULT_AVATAR_EXPECTED_FORM；超限的输入不做 MP4 结构解析。
 * 默认头像的本机文件核对（config/assets.ts）与复原上传（restore.ts）共用；本模块不接触 Bot API 客户端。
 */
export function defaultAvatarPhotoType(bytes: Uint8Array): InputProfilePhoto["type"] | null {
  const format: SniffedImageFormat = sniffImageFormat(bytes);
  if (format === "jpeg" || format === "png") return bytes.byteLength <= BOT_PROFILE_PHOTO_MAX_BYTES ? "static" : null;
  if (bytes.byteLength > BOT_PROFILE_ANIMATION_MAX_BYTES) return null;
  const tracks: readonly Mp4VideoTrack[] | null = readMp4VideoTracks(bytes);
  if (tracks === null || tracks.length === 0) return null;
  for (const track of tracks) {
    if (track.width !== track.height || track.width === 0 || track.width > BOT_PROFILE_ANIMATION_MAX_SIDE) return null;
  }
  return "animated";
}

/**
 * 默认头像素材的诊断描述，只写进复原失败日志：可识别的图片格式名；合法 MP4 写出各视频轨宽高（没有视频轨时
 * 写 none）；其余为 unknown。
 */
export function describeDefaultAvatar(bytes: Uint8Array): string {
  const format: SniffedImageFormat = sniffImageFormat(bytes);
  if (format !== "unknown") return format;
  const tracks: readonly Mp4VideoTrack[] | null = readMp4VideoTracks(bytes);
  if (tracks === null) return "unknown";
  const sizes: string = tracks.map((track: Mp4VideoTrack): string => `${track.width}x${track.height}`).join(",");
  return `mp4 video tracks ${sizes === "" ? "none" : sizes}`;
}
