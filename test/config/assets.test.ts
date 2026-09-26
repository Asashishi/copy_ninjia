import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { assetConfigCache } from "../../packages/cache/main/assets";
import {
  adoptAssetConfig,
  ensureAssetConfig,
  getAssetConfig,
  loadAssetConfig,
  parseAssetConfig,
} from "../../packages/config/assets";
import { ASSETS_CONFIG_PATH, RUNTIME_DATA_ROOT } from "../../packages/consts/paths";
import {
  BOT_DEFAULT_AVATAR_URL,
  DEFAULT_ASSET_CONFIG,
  FORTUNE_THUMBNAIL_URL,
  GAG_THUMBNAIL_URL,
  PROBABILITY_THUMBNAIL_URL,
  RANDOM_H_IMAGE_DIR,
} from "../../packages/consts/ui/assets";
import type { AssetConfig } from "../../packages/types/config";

/** 以固定来源路径解码 assets 文档。 */
function parse(value: unknown): AssetConfig {
  return parseAssetConfig(value, "assets.json");
}

afterEach(() => {
  assetConfigCache.current = DEFAULT_ASSET_CONFIG;
});

describe("parseAssetConfig", () => {
  test("空对象即五项都取内置缺省，缺省目录按运行时数据根解析", () => {
    expect(RANDOM_H_IMAGE_DIR).toBe("./h_image");
    expect(parse({})).toEqual({
      randomHImageDirectory: join(RUNTIME_DATA_ROOT, "h_image"),
      fortuneThumbnailUrl: FORTUNE_THUMBNAIL_URL,
      probabilityThumbnailUrl: PROBABILITY_THUMBNAIL_URL,
      gagThumbnailUrl: GAG_THUMBNAIL_URL,
      botDefaultAvatarUrl: BOT_DEFAULT_AVATAR_URL,
    });
    expect(parse({})).toEqual(DEFAULT_ASSET_CONFIG);
  });

  test("五项各自落到对应字段，没写的保持缺省", () => {
    // 四条直链互不相同：两张运势缩略图的内置常量逐字节相同，用常量断言看不出串位。
    expect(parse({
      fortune_thumbnail_url: "https://cdn.example/fortune.png",
      probability_thumbnail_url: "https://cdn.example/probability.png",
      bot_default_avatar_url: "http://assets.internal/face.jpg",
    })).toEqual({
      randomHImageDirectory: DEFAULT_ASSET_CONFIG.randomHImageDirectory,
      fortuneThumbnailUrl: "https://cdn.example/fortune.png",
      probabilityThumbnailUrl: "https://cdn.example/probability.png",
      gagThumbnailUrl: GAG_THUMBNAIL_URL,
      botDefaultAvatarUrl: "http://assets.internal/face.jpg",
    });
  });

  test("随机图片目录：相对路径按数据根解析，绝对路径原样使用", () => {
    expect(parse({ random_h_image_dir: "./gallery/daily" }).randomHImageDirectory)
      .toBe(join(RUNTIME_DATA_ROOT, "gallery", "daily"));
    expect(parse({ random_h_image_dir: "../shared/images" }).randomHImageDirectory)
      .toBe(join(RUNTIME_DATA_ROOT, "..", "shared", "images"));
    expect(parse({ random_h_image_dir: "/srv/pictures" }).randomHImageDirectory).toBe("/srv/pictures");
  });

  test("随机图片目录只收绝对路径或 ./、../ 开头的显式相对路径", () => {
    for (const value of ["images", "images/daily", "~/pictures", ".images", "./img\u0000s"]) {
      expect(() => parse({ random_h_image_dir: value })).toThrow(
        "assets.json: $.random_h_image_dir must be an absolute path or a relative path starting with ./ or ../, without NUL."
      );
    }
    for (const value of ["", "   ", 42, null]) {
      expect(() => parse({ random_h_image_dir: value })).toThrow(
        "assets.json: $.random_h_image_dir must be a non-empty string."
      );
    }
  });

  test("首尾空白按规范化去掉，不算配置错误", () => {
    const config: AssetConfig = parse({
      random_h_image_dir: "  ./gallery \n",
      gag_thumbnail_url: "\thttps://cdn.example/g.png  ",
    });
    expect(config.randomHImageDirectory).toBe(join(RUNTIME_DATA_ROOT, "gallery"));
    expect(config.gagThumbnailUrl).toBe("https://cdn.example/g.png");
  });

  test("读回的是归一化后的地址：内部换行与空格不会带着进内存", () => {
    const config: AssetConfig = parse({
      fortune_thumbnail_url: "https://cdn.example/a\nb.png",
      probability_thumbnail_url: "https://cdn.example/a b.png",
      bot_default_avatar_url: "HTTP://ASSETS.INTERNAL/face.jpg",
    });
    expect(config.fortuneThumbnailUrl).toBe("https://cdn.example/ab.png");
    expect(config.probabilityThumbnailUrl).toBe("https://cdn.example/a%20b.png");
    expect(config.botDefaultAvatarUrl).toBe("http://assets.internal/face.jpg");
  });

  test("只有默认头像允许明文 http，三张缩略图必须是 https", () => {
    for (const key of ["fortune_thumbnail_url", "probability_thumbnail_url", "gag_thumbnail_url"]) {
      expect(() => parse({ [key]: "http://cdn.example/f.png" }))
        .toThrow(`assets.json: $.${key} must be an absolute https URL.`);
    }
    expect(() => parse({ bot_default_avatar_url: "file:///etc/passwd" }))
      .toThrow("assets.json: $.bot_default_avatar_url must be an absolute http or https URL.");
  });

  test("直链写坏时拒绝整份文件，诊断不回显原值", () => {
    expect(() => parse({ fortune_thumbnail_url: "drive.google.com/uc?id=secret" }))
      .toThrow("assets.json: $.fortune_thumbnail_url must be an absolute https URL.");
    try {
      parse({ fortune_thumbnail_url: "drive.google.com/uc?id=secret" });
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain("secret");
    }
    for (const bad of ["", "  ", 1, null]) {
      expect(() => parse({ probability_thumbnail_url: bad })).toThrow(
        "assets.json: $.probability_thumbnail_url must be a non-empty string."
      );
    }
  });

  test("顶层必须是对象，未知键拒绝整份文件", () => {
    for (const value of [null, [], "x", 1]) {
      expect(() => parse(value)).toThrow("assets.json: $ must be an object.");
    }
    expect(() => parse({ fortuneThumbnailUrl: "https://cdn.example/f.png" }))
      .toThrow("assets.json: $.fortuneThumbnailUrl must be absent (not part of the current assets schema).");
  });

  test("内置缺省直链本身能通过同一道校验且归一化后不变", () => {
    expect(parse({
      fortune_thumbnail_url: FORTUNE_THUMBNAIL_URL,
      probability_thumbnail_url: PROBABILITY_THUMBNAIL_URL,
      gag_thumbnail_url: GAG_THUMBNAIL_URL,
      bot_default_avatar_url: BOT_DEFAULT_AVATAR_URL,
    })).toEqual(DEFAULT_ASSET_CONFIG);
  });
});

describe("素材快照的加载与接管", () => {
  test("holder 初值即内置缺省", () => {
    expect(getAssetConfig()).toBe(DEFAULT_ASSET_CONFIG);
  });

  test("ensureAssetConfig 读默认路径并接管；非法 JSON 拒绝且不改 holder", async () => {
    try {
      await Bun.write(ASSETS_CONFIG_PATH, JSON.stringify({ gag_thumbnail_url: "https://cdn.example/g.png" }));
      await ensureAssetConfig();
      expect(getAssetConfig().gagThumbnailUrl).toBe("https://cdn.example/g.png");

      adoptAssetConfig(DEFAULT_ASSET_CONFIG);
      await Bun.write(ASSETS_CONFIG_PATH, "{");
      await expect(loadAssetConfig()).rejects.toThrow(`${ASSETS_CONFIG_PATH}: $ must be a readable valid JSON document.`);
      await expect(ensureAssetConfig()).rejects.toThrow("must be a readable valid JSON document");
      expect(getAssetConfig()).toBe(DEFAULT_ASSET_CONFIG);
    } finally {
      await Bun.file(ASSETS_CONFIG_PATH).delete().catch((): undefined => undefined);
    }
  });
});
