/**
 * Telegram 缩略图压缩（infra/image.ts 的 prepareThumbnailJpeg）。
 *
 * 这条路上**没有直通分支**：Bot API 对 thumbnail 的三项要求（JPEG、长边 ≤320、
 * 体积 <200 kB）没有一项能靠嗅探字节确认，原样上传一张 1K 生图必然被整条拒绝。
 * 因此用真实的 sharp 跑，而不是打桩——要验的正是「产出确实满足那三项」。
 */

import { describe, expect, test } from "bun:test";
import { prepareThumbnailJpeg, sniffImageFormat } from "../../packages/infra/image";

/** 造一张指定尺寸的 PNG，用来模拟生图模型交回来的原始封面。 */
async function makePng(width: number, height: number): Promise<Uint8Array> {
  const { default: sharp } = await import("sharp");
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      // background 是 Create 的必填项，噪点会把它整片盖掉；纯色图压得极小、
      // 验不出体积上限那条分支，用噪点逼近真实照片的可压缩性。
      background: { r: 0, g: 0, b: 0 },
      noise: { type: "gaussian", mean: 128, sigma: 90 },
    },
  }).png().toBuffer();
}

describe("Telegram 缩略图压缩", () => {
  test("大图被缩到长边上限内，产出确实是 JPEG", async () => {
    const source: Uint8Array = await makePng(1_024, 1_024);

    const thumbnail: Uint8Array | null = await prepareThumbnailJpeg({
      bytes: source,
      maxEdge: 320,
      maxBytes: 180 * 1024,
      qualities: [88, 72, 55, 40],
    });

    expect(thumbnail).not.toBeNull();
    expect(sniffImageFormat(thumbnail!)).toBe("jpeg");
    expect(thumbnail!.byteLength).toBeLessThanOrEqual(180 * 1024);

    const { default: sharp } = await import("sharp");
    const meta = await sharp(thumbnail!).metadata();
    expect(meta.width).toBeLessThanOrEqual(320);
    expect(meta.height).toBeLessThanOrEqual(320);
  });

  test("非正方形保持原始比例，不裁切也不拉伸", async () => {
    const source: Uint8Array = await makePng(1_600, 900);

    const thumbnail: Uint8Array | null = await prepareThumbnailJpeg({
      bytes: source,
      maxEdge: 320,
      maxBytes: 180 * 1024,
      qualities: [88],
    });

    const { default: sharp } = await import("sharp");
    const meta = await sharp(thumbnail!).metadata();
    expect(meta.width).toBe(320);
    // 1600:900 缩到长边 320 应得 320×180；裁切或拉伸都会让这一项对不上。
    expect(meta.height).toBe(180);
  });

  test("本来就小于上限的图不会被放大成插值噪点", async () => {
    const source: Uint8Array = await makePng(64, 64);

    const thumbnail: Uint8Array | null = await prepareThumbnailJpeg({
      bytes: source,
      maxEdge: 320,
      maxBytes: 180 * 1024,
      qualities: [88],
    });

    const { default: sharp } = await import("sharp");
    const meta = await sharp(thumbnail!).metadata();
    expect(meta.width).toBe(64);
  });

  test("所有质量档都压不进上限时返回 null，不交出一张会被拒的图", async () => {
    const source: Uint8Array = await makePng(1_024, 1_024);

    const thumbnail: Uint8Array | null = await prepareThumbnailJpeg({
      bytes: source,
      maxEdge: 320,
      // 100 字节没有任何质量档能满足，逐档降完仍要老实交回 null。
      maxBytes: 100,
      qualities: [88, 40],
    });

    expect(thumbnail).toBeNull();
  });

  test("认不出的字节不抛错，归一成一次普通失败", async () => {
    const thumbnail: Uint8Array | null = await prepareThumbnailJpeg({
      bytes: new TextEncoder().encode("definitely not an image"),
      maxEdge: 320,
      maxBytes: 180 * 1024,
      qualities: [88],
    });

    expect(thumbnail).toBeNull();
  });
});
