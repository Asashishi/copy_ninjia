import { describe, expect, test } from "bun:test";
import {
  BOT_PROFILE_ANIMATION_MAX_BYTES,
  BOT_PROFILE_ANIMATION_MAX_SIDE,
  BOT_PROFILE_PHOTO_MAX_BYTES,
} from "../../packages/consts/telegram";
import { defaultAvatarPhotoType, describeDefaultAvatar } from "../../packages/infra/telegram/avatar/photoType";
import { MP4_BYTES, ftypBox, moovBox, mp4OfSize, trakBox } from "../helpers/mp4";
import type { TrakBoxOptions } from "../helpers/mp4";

/** 带 PNG 签名、总长 totalBytes 的字节。 */
function pngOfSize(totalBytes: number): Uint8Array {
  const bytes: Uint8Array = new Uint8Array(totalBytes);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

/** 由给定各条轨道组成的最小 MP4。 */
function mp4WithTracks(...tracks: readonly TrakBoxOptions[]): Uint8Array {
  const moov: Uint8Array = moovBox(...tracks.map((track: TrakBoxOptions): Uint8Array => trakBox(track)));
  return Bun.concatArrayBuffers([ftypBox({ major: "isom" }), moov], Infinity, true);
}

const MAX_SIDE: number = BOT_PROFILE_ANIMATION_MAX_SIDE;

describe("defaultAvatarPhotoType", () => {
  test("JPEG/PNG 不超过图片上限时为静态头像，超过一个字节即判否", () => {
    expect(defaultAvatarPhotoType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("static");
    expect(defaultAvatarPhotoType(pngOfSize(BOT_PROFILE_PHOTO_MAX_BYTES))).toBe("static");
    expect(defaultAvatarPhotoType(pngOfSize(BOT_PROFILE_PHOTO_MAX_BYTES + 1))).toBeNull();
  });

  test("MP4 不超过其他文件上限时为动态头像，超过一个字节即判否", () => {
    expect(defaultAvatarPhotoType(MP4_BYTES)).toBe("animated");
    expect(defaultAvatarPhotoType(mp4OfSize(BOT_PROFILE_PHOTO_MAX_BYTES + 1))).toBe("animated");
    expect(defaultAvatarPhotoType(mp4OfSize(BOT_PROFILE_ANIMATION_MAX_BYTES))).toBe("animated");
    expect(defaultAvatarPhotoType(mp4OfSize(BOT_PROFILE_ANIMATION_MAX_BYTES + 1))).toBeNull();
  });

  test("视频轨须是边长不超过上限的非零正方形", () => {
    expect(defaultAvatarPhotoType(mp4WithTracks({ width: MAX_SIDE, height: MAX_SIDE }))).toBe("animated");
    expect(defaultAvatarPhotoType(mp4WithTracks({ width: MAX_SIDE + 1, height: MAX_SIDE + 1 }))).toBeNull();
    expect(defaultAvatarPhotoType(mp4WithTracks({ width: MAX_SIDE, height: MAX_SIDE - 1 }))).toBeNull();
    expect(defaultAvatarPhotoType(mp4WithTracks({ width: 0, height: 0 }))).toBeNull();
  });

  test("至少要有一条视频轨，且每条视频轨都满足尺寸要求；音频轨不参与判定", () => {
    const audio: TrakBoxOptions = { width: 0, height: 0, handler: "soun" };
    expect(defaultAvatarPhotoType(mp4WithTracks({ width: 800, height: 800 }, audio))).toBe("animated");
    expect(defaultAvatarPhotoType(mp4WithTracks(audio))).toBeNull();
    expect(defaultAvatarPhotoType(mp4WithTracks())).toBeNull();
    const mixed: Uint8Array = mp4WithTracks({ width: 800, height: 800 }, { width: 1_280, height: 720 });
    expect(defaultAvatarPhotoType(mixed)).toBeNull();
  });

  test("WebP、GIF 与未知签名判否", () => {
    const webp: Uint8Array = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    ]);
    expect(defaultAvatarPhotoType(webp)).toBeNull();
    expect(defaultAvatarPhotoType(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(defaultAvatarPhotoType(new TextEncoder().encode("<!DOCTYPE html>"))).toBeNull();
  });
});

describe("describeDefaultAvatar", () => {
  test("图片写格式名，MP4 写各视频轨宽高，其余为 unknown", () => {
    expect(describeDefaultAvatar(pngOfSize(16))).toBe("png");
    expect(describeDefaultAvatar(mp4WithTracks({ width: 1_280, height: 720 }, { width: 640, height: 640 })))
      .toBe("mp4 video tracks 1280x720,640x640");
    const audioOnly: Uint8Array = mp4WithTracks({ width: 0, height: 0, handler: "soun" });
    expect(describeDefaultAvatar(audioOnly)).toBe("mp4 video tracks none");
    expect(describeDefaultAvatar(new TextEncoder().encode("<!DOCTYPE html>"))).toBe("unknown");
  });
});
