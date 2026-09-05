import { describe, expect, test } from "bun:test";
import sharp from "sharp";

const { prepareVisionImage, sniffImageFormat } = await import("../../packages/infra/image");

async function tinyPng(): Promise<Uint8Array> {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
}
async function tinyJpeg(): Promise<Uint8Array> {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).jpeg().toBuffer();
}
async function tinyWebp(): Promise<Uint8Array> {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: "green" } }).webp().toBuffer();
}
async function tinyGif(): Promise<Uint8Array> {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: "yellow" } }).gif().toBuffer();
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
  test("jpeg/png 原样直通，不经过 sharp 转码", async () => {
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

  test("gif 转码为 png（只取第一帧，sharp 默认行为）", async () => {
    const result = await prepareVisionImage(await tinyGif());
    expect(result?.mime).toBe("image/png");
    expect(result && sniffImageFormatOfResult(result.bytes)).toBe("png");
  });

  test("不支持/无法识别的格式返回 null", async () => {
    expect(await prepareVisionImage(new TextEncoder().encode("garbage"))).toBeNull();
  });
});

function sniffImageFormatOfResult(bytes: Uint8Array): string {
  return sniffImageFormat(bytes);
}
