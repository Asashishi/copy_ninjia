import { describe, expect, test } from "bun:test";
import { decodeStateFile } from "../../packages/libs/stateFileCodec";
import {
  BOT_DEFAULT_AVATAR_URL,
  FORTUNE_THUMBNAIL_URL,
  GAG_THUMBNAIL_URL,
  PROBABILITY_THUMBNAIL_URL,
} from "../../packages/consts/ui/assets";

/** 以固定来源路径解码 state 文档。 */
function decode(value: unknown): ReturnType<typeof decodeStateFile> {
  return decodeStateFile(value, "state.json");
}

describe("decodeStateFile", () => {
  test("恢复完整的 global 状态", () => {
    expect(decode({
      global: { copy: { copiedUser: null, lastCopyTime: 1_000_000 } },
    })).toEqual({
      global: { copy: { copiedUser: null, lastCopyTime: 1_000_000 }, assets: {} },
    });
  });

  test("旧 chats 顶层必须手工迁移，不保留兼容分支", () => {
    expect(() => decode({
      chats: { "-1001": { isInitEnabled: true } },
      global: { copy: { copiedUser: null } },
    })).toThrow("state.chats must be absent (not part of the current state schema)");
  });

  test("未知字段和失配的复读组合均拒绝", () => {
    expect(() => decode({ global: { copy: { copiedUser: null } }, version: 1 }))
      .toThrow("state.version");
    expect(() => decode({
      global: { copy: { copiedUser: null, copyChatId: -1001 } },
    })).toThrow("free of copyMode and copyChatId when copiedUser is null");
  });

  test("复读状态的 copyChatId 只接受 Telegram 群或频道负 ID", () => {
    expect(() => decode({
      global: {
        copy: {
          copiedUser: { id: 42, first_name: "目标" },
          copyChatId: 1001,
        },
      },
    })).toThrow("state.global.copy.copyChatId must be a negative safe integer");
    expect(() => decode({
      global: {
        copy: { copiedUser: { id: 42, first_name: "目标" }, copyChatId: -1001 },
      },
    })).not.toThrow();
  });

  test("旧 model 块不再属于状态 schema，必须迁移到 config/agent.json", () => {
    expect(() => decode({
      global: { copy: { copiedUser: null }, model: { image: "openai" } },
    })).toThrow("state.global.model must be absent (not part of the current state schema)");
  });

  test("素材块整块缺省 = 五项都没设过：既有 state.json 不必补空对象", () => {
    const decoded = decode({ global: { copy: { copiedUser: null } } });
    expect(decoded.global.assets).toEqual({
      fortuneThumbnailUrl: undefined,
      probabilityThumbnailUrl: undefined,
      gagThumbnailUrl: undefined,
      botDefaultAvatarUrl: undefined,
      randomHImageDir: undefined,
    });
  });

  test("随机图片目录收下去掉首尾空白的路径，空串、NUL 与非字符串拒绝", () => {
    const decoded = decode({
      global: { copy: { copiedUser: null }, assets: { randomHImageDir: "  ./images/daily  " } },
    });
    expect(decoded.global.assets.randomHImageDir).toBe("./images/daily");
    for (const value of ["", "   ", "./img\u0000s", 42]) {
      expect(() => decode({
        global: { copy: { copiedUser: null }, assets: { randomHImageDir: value } },
      })).toThrow("state.global.assets.randomHImageDir must be a non-empty path string");
    }
  });

  test("随机图片目录只收绝对路径或 ./、../ 开头的显式相对路径", () => {
    for (const value of ["/srv/pictures", "./images", "../shared/images"]) {
      const decoded = decode({
        global: { copy: { copiedUser: null }, assets: { randomHImageDir: value } },
      });
      expect(decoded.global.assets.randomHImageDir).toBe(value);
    }
    for (const value of ["images", "images/daily", "~/pictures", ".images"]) {
      expect(() => decode({
        global: { copy: { copiedUser: null }, assets: { randomHImageDir: value } },
      })).toThrow("state.global.assets.randomHImageDir must be an absolute path or a relative path starting with ./ or ../");
    }
  });

  test("四条素材直链原样读回，且各自独立", () => {
    const decoded = decode({
      global: {
        copy: { copiedUser: null },
        assets: {
          fortuneThumbnailUrl: "https://cdn.example/fortune.png",
          gagThumbnailUrl: "https://cdn.example/gag.png",
          botDefaultAvatarUrl: "http://assets.internal/face.jpg",
        },
      },
    });
    expect(decoded.global.assets.fortuneThumbnailUrl).toBe("https://cdn.example/fortune.png");
    expect(decoded.global.assets.gagThumbnailUrl).toBe("https://cdn.example/gag.png");
    expect(decoded.global.assets.botDefaultAvatarUrl).toBe("http://assets.internal/face.jpg");
    // 没写的那一项保持缺省，由代码常量兜底，不是「沿用另一项」。
    expect(decoded.global.assets.probabilityThumbnailUrl).toBeUndefined();
  });

  test("直链两端空白被去掉，不把带空格的地址存进内存再发给 Telegram", () => {
    const decoded = decode({
      global: {
        copy: { copiedUser: null },
        assets: { fortuneThumbnailUrl: "  https://cdn.example/f.png  " },
      },
    });
    expect(decoded.global.assets.fortuneThumbnailUrl).toBe("https://cdn.example/f.png");
  });

  test("读回的是归一化后的地址：内部换行/空格不会带着进内存", () => {
    // trim 只管首尾；URL 构造器会吃掉字符串**内部**的 tab/LF/CR 并给空格做百分号
    // 编码。留着原串等于让一个 Telegram 不认的地址通过校验，再把整个
    // answerInlineQuery 载荷带崩——而这些字符在 JSON 里肉眼不可见。
    const decoded = decode({
      global: {
        copy: { copiedUser: null },
        assets: {
          fortuneThumbnailUrl: "https://cdn.example/a\nb.png",
          probabilityThumbnailUrl: "https://cdn.example/a b.png",
          botDefaultAvatarUrl: "HTTP://ASSETS.INTERNAL/face.jpg",
        },
      },
    });
    expect(decoded.global.assets.fortuneThumbnailUrl).toBe("https://cdn.example/ab.png");
    expect(decoded.global.assets.probabilityThumbnailUrl).toBe("https://cdn.example/a%20b.png");
    expect(decoded.global.assets.botDefaultAvatarUrl).toBe("http://assets.internal/face.jpg");
  });

  test("只有默认头像允许明文 http，三张缩略图必须是 https", () => {
    // 头像是本进程自己抓的，明文与否是配置者的决定；缩略图交给 Telegram 客户端去取。
    const decoded = decode({
      global: {
        copy: { copiedUser: null },
        assets: { botDefaultAvatarUrl: "http://assets.internal/face.jpg" },
      },
    });
    expect(decoded.global.assets.botDefaultAvatarUrl).toBe("http://assets.internal/face.jpg");
    for (const key of ["fortuneThumbnailUrl", "probabilityThumbnailUrl", "gagThumbnailUrl"]) {
      expect(() => decode({
        global: { copy: { copiedUser: null }, assets: { [key]: "http://cdn.example/f.png" } },
      })).toThrow(`state.global.assets.${key} must be an https URL`);
    }
  });

  test("补齐用的四个内置常量本身必须通过同一道校验", () => {
    // 补齐直接把常量赋进 globalAssetState，绕过解码期校验；而每次 save 都会对含
    // 这四项的快照再跑一次 decodeStateFile 自检。常量写坏的代价不是「图不显示」，
    // 而是此后每一次落盘都 reject——`/copy`、`/quiet`、权限变更全部存不下去。
    const decoded = decode({
      global: {
        copy: { copiedUser: null },
        assets: {
          fortuneThumbnailUrl: FORTUNE_THUMBNAIL_URL,
          probabilityThumbnailUrl: PROBABILITY_THUMBNAIL_URL,
          gagThumbnailUrl: GAG_THUMBNAIL_URL,
          botDefaultAvatarUrl: BOT_DEFAULT_AVATAR_URL,
        },
      },
    });
    // 归一化后必须与常量逐字相同，否则补齐写下的值与自检读回的值会不一致。
    expect(decoded.global.assets.fortuneThumbnailUrl).toBe(FORTUNE_THUMBNAIL_URL);
    expect(decoded.global.assets.probabilityThumbnailUrl).toBe(PROBABILITY_THUMBNAIL_URL);
    expect(decoded.global.assets.gagThumbnailUrl).toBe(GAG_THUMBNAIL_URL);
    expect(decoded.global.assets.botDefaultAvatarUrl).toBe(BOT_DEFAULT_AVATAR_URL);
  });

  test("素材直链写坏时拒绝整份状态，不静默退回内置常量", () => {
    // 少写 scheme 是最常见的手误，而 Telegram 只会静默不显示这张图——与「图挂了」
    // 在群里看不出区别，只能在加载期说破。
    expect(() => decode({
      global: { copy: { copiedUser: null }, assets: { fortuneThumbnailUrl: "drive.google.com/uc?id=x" } },
    })).toThrow("state.global.assets.fortuneThumbnailUrl must be an absolute https URL");
    expect(() => decode({
      global: { copy: { copiedUser: null }, assets: { botDefaultAvatarUrl: "file:///etc/passwd" } },
    })).toThrow("state.global.assets.botDefaultAvatarUrl must be an http or https URL");
    for (const bad of ["", "   ", 1, null]) {
      expect(() => decode({
        global: { copy: { copiedUser: null }, assets: { probabilityThumbnailUrl: bad } },
      })).toThrow("state.global.assets.probabilityThumbnailUrl must be a non-empty string");
    }
  });

  test("素材块的未知键拒绝整份状态——拼错的键被无声忽略最危险", () => {
    expect(() => decode({
      global: { copy: { copiedUser: null }, assets: { fortuneThumbUrl: "https://cdn.example/f.png" } },
    })).toThrow("state.global.assets.fortuneThumbUrl must be absent (not part of the current state schema)");
  });

  test("global 块的未知键与缺失 copy 都拒绝整份状态", () => {
    expect(() => decode({
      global: { copy: { copiedUser: null }, mood: "happy" },
    })).toThrow("state.global.mood must be absent (not part of the current state schema)");
    expect(() => decode({ global: {} })).toThrow("state.global.copy must be present");
  });

  test("旧结构（顶层 globalCopy / imageProvider / chatProvider）当场拒绝，不静默读成空", () => {
    // 结构变更只做手工迁移：兼容分支会让复读状态被静默读成空，而群里看不出区别。
    expect(() => decode({
      globalCopy: { copiedUser: null, lastCopyTime: 1_000_000 },
    })).toThrow("state.globalCopy must be absent (not part of the current state schema)");
    expect(() => decode({
      global: { copy: { copiedUser: null } },
      imageProvider: "gemini",
    })).toThrow("state.imageProvider must be absent (not part of the current state schema)");
    expect(() => decode({})).toThrow("state.global must be present");
  });
});

test("旧图库键即使与新键并存也拒绝，缺省新键仍合法", () => {
  for (const assets of [{ randomImageDir: "./images" }, { randomImageDir: "./images", randomHImageDir: "./h_image" }]) {
    expect(() => decode({ global: { copy: { copiedUser: null }, assets } })).toThrow("randomImageDir must be absent (not part of the current state schema)");
  }
  expect(decode({ global: { copy: { copiedUser: null } } }).global.assets.randomHImageDir).toBeUndefined();
});
