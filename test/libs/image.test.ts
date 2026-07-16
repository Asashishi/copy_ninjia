import { describe, expect, mock, test } from "bun:test";
import sharp from "sharp";

/**
 * libs/image.ts 经 infra/logger -> infra/diskIO，后者在模块顶层就会
 * `new Worker(...)`：单测里绝不能让它真的跑起来（理由同
 * test/commands/luckChallenge.test.ts 的模块头注释），先 mock 掉再动态 import。
 */
mock.module("../../src/infra/diskIO", () => ({
  postDiskIO: mock((..._args: unknown[]): void => {}),
  onDiskIORespawn: mock((..._args: unknown[]): void => {}),
  relayLogMessage: mock((..._args: unknown[]): void => {}),
}));

const { prepareVisionImage, sniffImageFormat } = await import("../../src/libs/image");

async function tinyPng(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
}
async function tinyJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } }).jpeg().toBuffer();
}
async function tinyWebp(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: "green" } }).webp().toBuffer();
}
async function tinyGif(): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 3, background: "yellow" } }).gif().toBuffer();
}

describe("libs/image sniffImageFormat", () => {
  test("识别 png/jpeg/webp/gif 的文件头魔数", async () => {
    expect(sniffImageFormat(await tinyPng())).toBe("png");
    expect(sniffImageFormat(await tinyJpeg())).toBe("jpeg");
    expect(sniffImageFormat(await tinyWebp())).toBe("webp");
    expect(sniffImageFormat(await tinyGif())).toBe("gif");
  });

  test("不认识的字节返回 unknown", () => {
    expect(sniffImageFormat(Buffer.from("not an image, just text"))).toBe("unknown");
    expect(sniffImageFormat(Buffer.alloc(0))).toBe("unknown");
    expect(sniffImageFormat(Buffer.from([0x01, 0x02]))).toBe("unknown");
  });
});

describe("libs/image prepareVisionImage", () => {
  test("jpeg/png 原样直通，不经过 sharp 转码", async () => {
    const jpeg: Buffer = await tinyJpeg();
    const jpegResult = await prepareVisionImage(jpeg);
    expect(jpegResult?.mime).toBe("image/jpeg");
    expect(jpegResult?.bytes).toBe(jpeg); // 同一个引用，说明没有走转码分支

    const png: Buffer = await tinyPng();
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
    expect(await prepareVisionImage(Buffer.from("garbage"))).toBeNull();
  });
});

function sniffImageFormatOfResult(bytes: Buffer): string {
  return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "png" : "not-png";
}
