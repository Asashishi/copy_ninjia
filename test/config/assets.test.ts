import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assetConfigCache } from "../../packages/cache/main/assets";
import {
  adoptAssetConfig,
  ensureAssetConfig,
  getAssetConfig,
  loadAssetConfig,
  parseAssetConfig,
} from "../../packages/config/assets";
import { ASSETS_CONFIG_PATH, RUNTIME_DATA_ROOT } from "../../packages/consts/paths";
import { AVATAR_MAX_DOWNLOAD_BYTES } from "../../packages/consts/telegram";
import {
  ASSET_CONFIG_GROUPS,
  ASSET_ONLY_PATH_GROUP,
  ASSET_ONLY_URL_GROUP,
  ASSET_ONLY_URL_KEYS,
  ASSET_PATH_OR_URL_GROUP,
  BOT_DEFAULT_AVATAR_FIELD,
  BOT_DEFAULT_AVATAR_URL,
  DEFAULT_ASSET_CONFIG,
  FORTUNE_THUMBNAIL_URL,
  GAG_THUMBNAIL_URL,
  PROBABILITY_THUMBNAIL_URL,
  RANDOM_H_IMAGE_DIR,
  RANDOM_H_IMAGE_DIR_FIELD,
} from "../../packages/consts/ui/assets";
import type { AssetConfig } from "../../packages/types/config";

/** 默认头像既不是直链也不是显式本机路径时的诊断。 */
const AVATAR_SOURCE_ERROR: string = `assets.json: ${BOT_DEFAULT_AVATAR_FIELD} must be an absolute http or https URL, ` +
  "an absolute path, or a relative path starting with ./ or ../, without NUL.";

/** 三张缩略图的字段名。 */
const THUMBNAIL_KEYS: readonly string[] = [...ASSET_ONLY_URL_KEYS];

/** 以固定来源路径解码 assets 文档。 */
function parse(value: unknown): AssetConfig {
  return parseAssetConfig(value, "assets.json");
}

/** 只含 onlyPath 组的文档。 */
function onlyPath(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { [ASSET_ONLY_PATH_GROUP]: fields };
}

/** 只含 pathOrUrl 组的文档。 */
function pathOrUrl(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { [ASSET_PATH_OR_URL_GROUP]: fields };
}

/** 只含 onlyUrl 组的文档。 */
function onlyUrl(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return { [ASSET_ONLY_URL_GROUP]: fields };
}

/** onlyUrl 组内字段的诊断路径。 */
function onlyUrlField(key: string): string {
  return `$.${ASSET_ONLY_URL_GROUP}.${key}`;
}

afterEach(() => {
  assetConfigCache.current = DEFAULT_ASSET_CONFIG;
});

describe("parseAssetConfig", () => {
  test("空对象、空分组即五项都取内置缺省，缺省目录按运行时数据根解析", () => {
    expect(parse({})).toEqual({
      randomHImageDirectory: resolve(RUNTIME_DATA_ROOT, RANDOM_H_IMAGE_DIR),
      fortuneThumbnailUrl: FORTUNE_THUMBNAIL_URL,
      probabilityThumbnailUrl: PROBABILITY_THUMBNAIL_URL,
      gagThumbnailUrl: GAG_THUMBNAIL_URL,
      botDefaultAvatar: { kind: "url", url: BOT_DEFAULT_AVATAR_URL },
    });
    expect(parse({})).toEqual(DEFAULT_ASSET_CONFIG);
    expect(parse({ ...onlyPath({}), ...pathOrUrl({}), ...onlyUrl({}) })).toEqual(DEFAULT_ASSET_CONFIG);
  });

  test("五项各自落到对应字段，没写的保持缺省", () => {
    // 四条直链互不相同：两张运势缩略图的内置常量逐字节相同，用常量断言看不出串位。
    expect(parse({
      ...pathOrUrl({ bot_default_avatar: "http://assets.internal/face.jpg" }),
      ...onlyUrl({
        fortune_thumbnail_url: "https://cdn.example/fortune.png",
        probability_thumbnail_url: "https://cdn.example/probability.png",
      }),
    })).toEqual({
      randomHImageDirectory: DEFAULT_ASSET_CONFIG.randomHImageDirectory,
      fortuneThumbnailUrl: "https://cdn.example/fortune.png",
      probabilityThumbnailUrl: "https://cdn.example/probability.png",
      gagThumbnailUrl: GAG_THUMBNAIL_URL,
      botDefaultAvatar: { kind: "url", url: "http://assets.internal/face.jpg" },
    });
  });

  test("示例配置能通过严格解析，各项与内置缺省一致", async () => {
    const example: unknown = await Bun.file(join(import.meta.dir, "../../config_example/dynamic/assets.json")).json();
    expect(parse(example)).toEqual(DEFAULT_ASSET_CONFIG);
  });

  test("随机图片目录：相对路径按数据根解析，绝对路径原样使用", () => {
    expect(parse(onlyPath({ random_h_image_dir: "./gallery/daily" })).randomHImageDirectory)
      .toBe(join(RUNTIME_DATA_ROOT, "gallery", "daily"));
    expect(parse(onlyPath({ random_h_image_dir: "../shared/images" })).randomHImageDirectory)
      .toBe(join(RUNTIME_DATA_ROOT, "..", "shared", "images"));
    expect(parse(onlyPath({ random_h_image_dir: "/srv/pictures" })).randomHImageDirectory).toBe("/srv/pictures");
  });

  test("随机图片目录只收绝对路径或 ./、../ 开头的显式相对路径，不收直链", () => {
    for (const value of ["images", "images/daily", "~/pictures", ".images", "./img\u0000s", "https://cdn.example/images"]) {
      expect(() => parse(onlyPath({ random_h_image_dir: value }))).toThrow(
        `assets.json: ${RANDOM_H_IMAGE_DIR_FIELD} must be an absolute path or a relative path starting with ./ or ../, without NUL.`
      );
    }
    for (const value of ["", "   ", 42, null]) {
      expect(() => parse(onlyPath({ random_h_image_dir: value }))).toThrow(
        `assets.json: ${RANDOM_H_IMAGE_DIR_FIELD} must be a non-empty string.`
      );
    }
  });

  test("首尾空白按规范化去掉，不算配置错误", () => {
    const config: AssetConfig = parse({
      ...onlyPath({ random_h_image_dir: "  ./gallery \n" }),
      ...onlyUrl({ gag_thumbnail_url: "\thttps://cdn.example/g.png  " }),
    });
    expect(config.randomHImageDirectory).toBe(join(RUNTIME_DATA_ROOT, "gallery"));
    expect(config.gagThumbnailUrl).toBe("https://cdn.example/g.png");
  });

  test("读回的是归一化后的地址：内部换行与空格不会带着进内存", () => {
    const config: AssetConfig = parse({
      ...pathOrUrl({ bot_default_avatar: "HTTP://ASSETS.INTERNAL/face.jpg" }),
      ...onlyUrl({
        fortune_thumbnail_url: "https://cdn.example/a\nb.png",
        probability_thumbnail_url: "https://cdn.example/a b.png",
      }),
    });
    expect(config.fortuneThumbnailUrl).toBe("https://cdn.example/ab.png");
    expect(config.probabilityThumbnailUrl).toBe("https://cdn.example/a%20b.png");
    expect(config.botDefaultAvatar).toEqual({ kind: "url", url: "http://assets.internal/face.jpg" });
  });

  test("只有默认头像允许明文 http，三张缩略图必须是 https", () => {
    for (const key of THUMBNAIL_KEYS) {
      expect(() => parse(onlyUrl({ [key]: "http://cdn.example/f.png" })))
        .toThrow(`assets.json: ${onlyUrlField(key)} must be an absolute https URL.`);
    }
    expect(() => parse(pathOrUrl({ bot_default_avatar: "file:///etc/passwd" }))).toThrow(AVATAR_SOURCE_ERROR);
  });

  test("默认头像的本机路径：相对路径按数据根解析，绝对路径原样使用", () => {
    expect(parse(pathOrUrl({ bot_default_avatar: "./avatar/face.png" })).botDefaultAvatar)
      .toEqual({ kind: "path", path: join(RUNTIME_DATA_ROOT, "avatar", "face.png") });
    expect(parse(pathOrUrl({ bot_default_avatar: "../shared/face.jpg" })).botDefaultAvatar)
      .toEqual({ kind: "path", path: join(RUNTIME_DATA_ROOT, "..", "shared", "face.jpg") });
    expect(parse(pathOrUrl({ bot_default_avatar: " /srv/faces/bot.png\n" })).botDefaultAvatar)
      .toEqual({ kind: "path", path: "/srv/faces/bot.png" });
  });

  test("默认头像既不是直链也不是显式本机路径时拒绝", () => {
    for (const value of ["face.png", "avatar/face.png", "~/face.png", "./fa\u0000ce.png", "ftp://cdn.example/f.png"]) {
      expect(() => parse(pathOrUrl({ bot_default_avatar: value }))).toThrow(AVATAR_SOURCE_ERROR);
    }
  });

  test("三张缩略图由 Telegram 拉取，不接受本机路径", () => {
    for (const key of THUMBNAIL_KEYS) {
      for (const value of ["./thumb.png", "/srv/thumb.png"]) {
        expect(() => parse(onlyUrl({ [key]: value })))
          .toThrow(`assets.json: ${onlyUrlField(key)} must be an absolute https URL.`);
      }
    }
  });

  test("直链写坏时拒绝整份文件，诊断不回显原值", () => {
    expect(() => parse(onlyUrl({ fortune_thumbnail_url: "drive.google.com/uc?id=secret" })))
      .toThrow(`assets.json: ${onlyUrlField("fortune_thumbnail_url")} must be an absolute https URL.`);
    try {
      parse(onlyUrl({ fortune_thumbnail_url: "drive.google.com/uc?id=secret" }));
    } catch (error: unknown) {
      expect((error as Error).message).not.toContain("secret");
    }
    for (const bad of ["", "  ", 1, null]) {
      expect(() => parse(onlyUrl({ probability_thumbnail_url: bad }))).toThrow(
        `assets.json: ${onlyUrlField("probability_thumbnail_url")} must be a non-empty string.`
      );
    }
  });

  test("顶层与分组都必须是对象", () => {
    for (const value of [null, [], "x", 1]) {
      expect(() => parse(value)).toThrow("assets.json: $ must be an object.");
      for (const group of ASSET_CONFIG_GROUPS) {
        expect(() => parse({ [group]: value })).toThrow(`assets.json: $.${group} must be an object.`);
      }
    }
  });

  test("未知分组、平铺在顶层的字段与放错组的字段都拒绝整份文件", () => {
    expect(() => parse({ fortuneThumbnailUrl: "https://cdn.example/f.png" }))
      .toThrow("assets.json: $.<key> must be absent (not part of the current assets schema).");
    expect(() => parse({ gag_thumbnail_url: "https://cdn.example/g.png" }))
      .toThrow("assets.json: $.<key> must be absent (not part of the current assets schema).");
    expect(() => parse(pathOrUrl({ gag_thumbnail_url: "https://cdn.example/g.png" }))).toThrow(
      `assets.json: $.${ASSET_PATH_OR_URL_GROUP}.<key> must be absent (not part of the current assets schema).`
    );
    expect(() => parse(pathOrUrl({ random_h_image_dir: "./images" }))).toThrow(
      `assets.json: $.${ASSET_PATH_OR_URL_GROUP}.<key> must be absent (not part of the current assets schema).`
    );
    expect(() => parse(onlyPath({ bot_default_avatar: "./face.png" }))).toThrow(
      `assets.json: $.${ASSET_ONLY_PATH_GROUP}.<key> must be absent (not part of the current assets schema).`
    );
    expect(() => parse(pathOrUrl({ bot_default_avatar_url: "https://cdn.example/face.png" }))).toThrow(
      `assets.json: $.${ASSET_PATH_OR_URL_GROUP}.<key> must be absent (not part of the current assets schema).`
    );
    expect(() => parse(onlyUrl({ bot_default_avatar: "https://cdn.example/face.png" })))
      .toThrow(`assets.json: $.${ASSET_ONLY_URL_GROUP}.<key> must be absent (not part of the current assets schema).`);
  });

  test("未知字段名包含敏感文本时，错误只给固定字段路径", () => {
    const secret: string = "private-token-marker";
    try {
      parse(pathOrUrl({ [secret]: "value" }));
      throw new Error("expected rejection");
    } catch (error: unknown) {
      expect((error as Error).message).toContain(`$.${ASSET_PATH_OR_URL_GROUP}.<key>`);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  test("内置缺省直链本身能通过同一道校验且归一化后不变", () => {
    expect(parse({
      ...pathOrUrl({ bot_default_avatar: BOT_DEFAULT_AVATAR_URL }),
      ...onlyUrl({
        fortune_thumbnail_url: FORTUNE_THUMBNAIL_URL,
        probability_thumbnail_url: PROBABILITY_THUMBNAIL_URL,
        gag_thumbnail_url: GAG_THUMBNAIL_URL,
      }),
    })).toEqual(DEFAULT_ASSET_CONFIG);
  });
});

describe("默认头像本机文件的加载期核对", () => {
  /** 夹具目录放在测试进程独占的数据根下。 */
  const FIXTURE_DIR: string = join(RUNTIME_DATA_ROOT, "asset-avatar-fixtures");
  const CONFIG_PATH: string = join(FIXTURE_DIR, "assets.json");
  const PNG_BYTES: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);

  /** 写一份只配默认头像的 assets.json 并加载。 */
  async function loadWithAvatar(avatar: string): Promise<AssetConfig> {
    await Bun.write(CONFIG_PATH, JSON.stringify(pathOrUrl({ bot_default_avatar: avatar })));
    return loadAssetConfig(CONFIG_PATH);
  }

  afterAll(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  test("可读的 JPEG/PNG 普通文件通过，来源为解析后的绝对路径", async () => {
    const path: string = join(FIXTURE_DIR, "face.png");
    await Bun.write(path, PNG_BYTES);
    expect((await loadWithAvatar(path)).botDefaultAvatar).toEqual({ kind: "path", path });
  });

  test("文件不存在或是目录时拒绝", async () => {
    await mkdir(join(FIXTURE_DIR, "a-directory"), { recursive: true });
    for (const path of [join(FIXTURE_DIR, "missing.png"), join(FIXTURE_DIR, "a-directory")]) {
      await expect(loadWithAvatar(path)).rejects.toThrow(
        `${CONFIG_PATH}: ${BOT_DEFAULT_AVATAR_FIELD} must be an existing readable regular file.`
      );
    }
  });

  test("超过下载上限时拒绝", async () => {
    const path: string = join(FIXTURE_DIR, "huge.png");
    const bytes: Uint8Array = new Uint8Array(AVATAR_MAX_DOWNLOAD_BYTES + 1);
    bytes.set(PNG_BYTES);
    await Bun.write(path, bytes);
    await expect(loadWithAvatar(path)).rejects.toThrow(
      `${CONFIG_PATH}: ${BOT_DEFAULT_AVATAR_FIELD} must be a file of at most ${AVATAR_MAX_DOWNLOAD_BYTES} bytes.`
    );
  });

  test("字节签名不是 JPEG/PNG 时拒绝", async () => {
    const path: string = join(FIXTURE_DIR, "face.txt");
    await Bun.write(path, "not an image");
    await expect(loadWithAvatar(path)).rejects.toThrow(
      `${CONFIG_PATH}: ${BOT_DEFAULT_AVATAR_FIELD} must be a JPEG or PNG image file.`
    );
  });

  test("直链来源不在加载期访问网络", async () => {
    expect((await loadWithAvatar("https://cdn.example/face.png")).botDefaultAvatar)
      .toEqual({ kind: "url", url: "https://cdn.example/face.png" });
  });
});

describe("素材快照的加载与接管", () => {
  test("holder 初值即内置缺省", () => {
    expect(getAssetConfig()).toBe(DEFAULT_ASSET_CONFIG);
  });

  test("ensureAssetConfig 读默认路径并接管；非法 JSON 拒绝且不改 holder", async () => {
    try {
      await Bun.write(ASSETS_CONFIG_PATH, JSON.stringify(onlyUrl({ gag_thumbnail_url: "https://cdn.example/g.png" })));
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
