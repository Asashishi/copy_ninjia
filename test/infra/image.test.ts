import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { animatedGifFixture, imageFixture } from "../helpers/image";

const { prepareVisionImage, sniffImageFormat } = await import("../../packages/infra/image");

async function tinyPng(): Promise<Uint8Array> {
  return new Bun.Image(imageFixture(2, 2)).png().bytes();
}
async function tinyJpeg(): Promise<Uint8Array> {
  return new Bun.Image(imageFixture(2, 2)).jpeg().bytes();
}
async function tinyWebp(): Promise<Uint8Array> {
  return new Bun.Image(imageFixture(2, 2)).webp().bytes();
}
async function tinyGif(): Promise<Uint8Array> {
  return animatedGifFixture();
}

describe("infra/image sniffImageFormat", () => {
  test("识别 png/jpeg/webp/gif 的文件头魔数", async () => {
    expect(sniffImageFormat(await tinyPng())).toBe("png");
    expect(sniffImageFormat(await tinyJpeg())).toBe("jpeg");
    expect(sniffImageFormat(await tinyWebp())).toBe("webp");
    expect(sniffImageFormat(await tinyGif())).toBe("gif");
  });

  test("不认识的字节返回 unknown", () => {
    expect(sniffImageFormat(new TextEncoder().encode("not an image, just text"))).toBe("unknown");
    expect(sniffImageFormat(new Uint8Array(0))).toBe("unknown");
    expect(sniffImageFormat(new Uint8Array([0x01, 0x02]))).toBe("unknown");
  });

  test("Uint8Array 子视图只读取可见区间", () => {
    const bytes: Uint8Array = new Uint8Array([
      0,
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0,
    ]);
    expect(sniffImageFormat(bytes.subarray(1, 9))).toBe("png");
    expect(sniffImageFormat(bytes)).toBe("unknown");
  });
});

describe("infra/image prepareVisionImage", () => {
  test("jpeg/png 原样直通，不经过转码", async () => {
    const jpeg: Uint8Array = await tinyJpeg();
    const jpegResult = await prepareVisionImage(jpeg);
    expect(jpegResult?.mime).toBe("image/jpeg");
    expect(jpegResult?.bytes).toBe(jpeg); // 同一个引用，说明没有走转码分支

    const png: Uint8Array = await tinyPng();
    const pngResult = await prepareVisionImage(png);
    expect(pngResult?.mime).toBe("image/png");
    expect(pngResult?.bytes).toBe(png);
  });

  test("webp 转码为 png", async () => {
    const result = await prepareVisionImage(await tinyWebp());
    expect(result?.mime).toBe("image/png");
    expect(result && sniffImageFormatOfResult(result.bytes)).toBe("png");
  });

  test("gif 转码为 png（只取第一帧）", async () => {
    const result = await prepareVisionImage(await tinyGif());
    expect(result?.mime).toBe("image/png");
    expect(result && sniffImageFormatOfResult(result.bytes)).toBe("png");
    const firstFrame: Uint8Array = imageFixture(2, 2);
    for (const offset of [54, 57, 62, 65]) {
      firstFrame.set([0, 255, 255], offset);
    }
    const expected: Uint8Array = await new Bun.Image(firstFrame).png().bytes();
    expect(await sharp(result!.bytes).ensureAlpha().raw().toBuffer())
      .toEqual(await sharp(expected).ensureAlpha().raw().toBuffer());
  });

  test("动态 webp 读取第一帧并保留透明度", async () => {
    const pixels: Uint8Array = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 128,
      0, 0, 255, 255, 255, 255, 0, 255,
    ]);
    const animated: Uint8Array = await sharp(pixels, {
      raw: { width: 2, height: 2, channels: 4, pageHeight: 1 },
    }).webp({ lossless: true }).toBuffer();
    const result = await prepareVisionImage(animated);
    expect(result?.mime).toBe("image/png");
    const frame = await sharp(result!.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([frame.info.width, frame.info.height]).toEqual([2, 1]);
    expect<Uint8Array>(frame.data).toEqual(pixels.subarray(0, 8));
  });

  test("转码只消费子视图的可见字节且保持输入不变", async () => {
    const webp: Uint8Array = await tinyWebp();
    const source: Uint8Array = new Uint8Array(webp.length + 8).fill(42);
    source.set(webp, 4);
    const snapshot: Uint8Array = source.slice();
    const result = await prepareVisionImage(source.subarray(4, 4 + webp.length));
    expect(result?.bytes).toEqual((await prepareVisionImage(webp))?.bytes);
    expect(source).toEqual(snapshot);
  });

  test("损坏的 webp/gif 在转码边界返回 null", async () => {
    expect(await prepareVisionImage((await tinyWebp()).subarray(0, 12))).toBeNull();
    expect(await prepareVisionImage((await tinyGif()).subarray(0, 6))).toBeNull();
  });

  test("不支持/无法识别的格式返回 null", async () => {
    expect(await prepareVisionImage(new TextEncoder().encode("garbage"))).toBeNull();
  });
});

function sniffImageFormatOfResult(bytes: Uint8Array): string {
  return sniffImageFormat(bytes);
}
