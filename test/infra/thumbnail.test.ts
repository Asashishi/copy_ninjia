/**
 * Telegram 缩略图压缩（infra/image.ts 的 prepareThumbnailJpeg）。
 *
 * 这条路上**没有直通分支**：Bot API 对 thumbnail 的三项要求（JPEG、长边 ≤320、
 * 体积 <200 kB）没有一项能靠嗅探字节确认，原样上传一张 1K 生图必然被整条拒绝。
 * 使用真实编解码器验证 JPEG 格式、尺寸、体积与透明度合成语义。
 */

import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { imageFixture } from "../helpers/image";
import { prepareThumbnailJpeg, sniffImageFormat } from "../../packages/infra/image";

/** 造一张指定尺寸的 PNG，用来模拟生图模型交回来的原始封面。 */
async function makePng(width: number, height: number): Promise<Uint8Array> {
  return new Bun.Image(imageFixture(width, height)).png().bytes();
}

describe("Telegram 缩略图压缩", () => {
  test.each([0, 0.5, 1])("透明度 %s 按黑色背景合成，不暴露透明像素颜色", async (alpha: number) => {
    const bytes: Uint8Array = await sharp({
      create: { width: 8, height: 4, channels: 4, background: { r: 255, g: 128, b: 32, alpha } },
    }).png().toBuffer();
    const thumbnail: Uint8Array | null = await prepareThumbnailJpeg({
      bytes, maxEdge: 320, maxBytes: 180 * 1024, qualities: [88],
    });
    const decoded: Uint8Array = await sharp(thumbnail!).raw().toBuffer();
    for (let index: number = 0; index < decoded.length; index++) {
      const expected: number = [255, 128, 32][index % 3]! * alpha;
      expect(Math.abs(decoded[index]! - expected)).toBeLessThanOrEqual(2);
    }
  });

  test("EXIF 方向不会隐式旋转封面", async () => {
    const bytes: Uint8Array = await sharp(await makePng(64, 32))
      .withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const thumbnail: Uint8Array | null = await prepareThumbnailJpeg({
      bytes, maxEdge: 320, maxBytes: 180 * 1024, qualities: [88],
    });
    const metadata: Bun.Image.Metadata = await new Bun.Image(thumbnail!).metadata();
    expect([metadata.width, metadata.height]).toEqual([64, 32]);
  });

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

    const meta: Bun.Image.Metadata = await new Bun.Image(thumbnail!).metadata();
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

    const meta: Bun.Image.Metadata = await new Bun.Image(thumbnail!).metadata();
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

    const meta: Bun.Image.Metadata = await new Bun.Image(thumbnail!).metadata();
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

  test("高质量超限后使用首个符合体积限制的质量档", async () => {
    const bytes: Uint8Array = await makePng(320, 320);
    const options = { bytes, maxEdge: 320, maxBytes: 1_000_000 };
    const high: Uint8Array | null = await prepareThumbnailJpeg({ ...options, qualities: [88] });
    const low: Uint8Array | null = await prepareThumbnailJpeg({ ...options, qualities: [40] });
    expect(high!.byteLength).toBeGreaterThan(low!.byteLength);
    const thumbnail: Uint8Array | null = await prepareThumbnailJpeg({
      ...options,
      maxBytes: low!.byteLength,
      qualities: [88, 40],
    });
    expect(thumbnail).toEqual(low);
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
