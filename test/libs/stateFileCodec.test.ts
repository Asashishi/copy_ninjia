import { describe, expect, test } from "bun:test";
import { decodeStateFile } from "../../packages/libs/stateFileCodec";
import {
  BOT_DEFAULT_AVATAR_URL,
  FORTUNE_THUMBNAIL_URL,
  GAG_THUMBNAIL_URL,
  PROBABILITY_THUMBNAIL_URL,
} from "../../packages/consts/ui/assets";

describe("decodeStateFile", () => {
  test("恢复完整的当前状态", () => {
    expect(decodeStateFile({
      chats: {
        "-1001": {
          isInitEnabled: true,
          lockdown: {
            phase: "active",
            intentId: 1,
            originalPermissions: { can_send_messages: true, can_invite_users: false },
            announced: true,
            expiresAt: 2_000_000,
          },
        },
      },
      global: { copy: { copiedUser: null, lastCopyTime: 1_000_000 } },
    })).toEqual({
      chats: {
        "-1001": {
          quietUntil: undefined,
          lockdown: {
            phase: "active",
            intentId: 1,
            originalPermissions: { can_send_messages: true, can_invite_users: false },
            announced: true,
            expiresAt: 2_000_000,
          },
          isAIChatEnabled: undefined,
          isJATranslationEnabled: undefined,
          isAdDetectEnabled: undefined,
          isFloodControlEnabled: undefined,
          isInitEnabled: true,
          botIsAdmin: undefined,
          title: undefined,
          isProxySendEnabled: undefined,
        },
      },
      global: { copy: { copiedUser: null, lastCopyTime: 1_000_000 }, assets: {} },
    });
  });

  test("存在但损坏的 lockdown 会拒绝整个文件", () => {
    expect(() => decodeStateFile({
      chats: {
        "-1001": {
          lockdown: { originalPermissions: {}, expiresAt: "later" },
        },
      },
      global: { copy: { copiedUser: null } },
    })).toThrow("state.chats.-1001.lockdown");
  });

  test("lockdown 当前格式要求 phase、正数 intentId 和 announced", () => {
    expect(() => decodeStateFile({
      chats: {
        "-1001": {
          lockdown: { intentId: 1, originalPermissions: {}, expiresAt: 2_000 },
        },
      },
      global: { copy: { copiedUser: null } },
    })).toThrow("state.chats.-1001.lockdown.phase is required");
    expect(() => decodeStateFile({
      chats: {
        "-1001": {
          lockdown: { phase: "active", announced: true, originalPermissions: {}, expiresAt: 2_000 },
        },
      },
      global: { copy: { copiedUser: null } },
    })).toThrow("state.chats.-1001.lockdown.intentId must be a positive safe integer");
    expect(() => decodeStateFile({
      chats: {
        "-1001": {
          lockdown: { phase: "active", intentId: 0, announced: true, originalPermissions: {}, expiresAt: 2_000 },
        },
      },
      global: { copy: { copiedUser: null } },
    })).toThrow("state.chats.-1001.lockdown.intentId must be a positive safe integer");
    expect(() => decodeStateFile({
      chats: {
        "-1001": {
          lockdown: { phase: "active", intentId: 1, originalPermissions: {}, expiresAt: 2_000 },
        },
      },
      global: { copy: { copiedUser: null } },
    })).toThrow("state.chats.-1001.lockdown.announced is required and must be a boolean");
    expect(() => decodeStateFile({
      chats: {
        "-1001": {
          lockdown: { phase: "applying", intentId: 1, announced: true, originalPermissions: {}, expiresAt: 2_000 },
        },
      },
      global: { copy: { copiedUser: null } },
    })).toThrow("state.chats.-1001.lockdown.announced must be false while phase is applying");
  });

  test("lockdown reconciling 状态可严格往返", () => {
    expect(decodeStateFile({
      chats: {
        "-1001": {
          lockdown: {
            phase: "reconciling",
            intentId: 2,
            announced: false,
            originalPermissions: { can_invite_users: true },
            expiresAt: 3_000,
          },
        },
      },
      global: { copy: { copiedUser: null } },
    }).chats["-1001"]?.lockdown).toEqual({
      phase: "reconciling",
      intentId: 2,
      announced: false,
      originalPermissions: { can_invite_users: true },
      expiresAt: 3_000,
    });
  });

  test("空 ChatPermissions 合法，但未知字段和非 boolean 仍拒绝", () => {
    expect(decodeStateFile({
      chats: { "-1001": { lockdown: { phase: "active", intentId: 1, announced: true, originalPermissions: {}, expiresAt: 2_000 } } },
      global: { copy: { copiedUser: null } },
    }).chats["-1001"]?.lockdown?.originalPermissions).toEqual({});
    expect(() => decodeStateFile({
      chats: { "-1001": { lockdown: { phase: "active", intentId: 1, announced: true, originalPermissions: { can_fly: true }, expiresAt: 2_000 } } },
      global: { copy: { copiedUser: null } },
    })).toThrow("can_fly");
    expect(() => decodeStateFile({
      chats: { "-1001": { lockdown: { phase: "active", intentId: 1, announced: true, originalPermissions: { can_invite_users: "yes" }, expiresAt: 2_000 } } },
      global: { copy: { copiedUser: null } },
    })).toThrow("can_invite_users");
  });

  test("未知字段、错误类型和失配的复读组合均拒绝", () => {
    expect(() => decodeStateFile({ chats: {}, global: { copy: { copiedUser: null } }, version: 1 })).toThrow("state.version");
    expect(() => decodeStateFile({ chats: { nope: {} }, global: { copy: { copiedUser: null } } })).toThrow("invalid chat id");
    expect(() => decodeStateFile({
      chats: {},
      global: { copy: { copiedUser: null, copyChatId: -1001 } },
    })).toThrow("without copiedUser");
  });

  test("多个活动中转目标拒绝加载，不能静默选取第一个", () => {
    expect(() => decodeStateFile({
      chats: {
        "-1001": { isProxySendEnabled: true },
        "-1002": { isProxySendEnabled: true },
      },
      global: { copy: { copiedUser: null } },
    })).toThrow("multiple active proxy send targets: -1001, -1002");
  });

  test("防刷屏开关按当前字段严格解码，缺省保持关闭", () => {
    expect(decodeStateFile({
      chats: { "-1001": { isFloodControlEnabled: true } },
      global: { copy: { copiedUser: null } },
    }).chats["-1001"]?.isFloodControlEnabled).toBe(true);
    expect(() => decodeStateFile({
      chats: { "-1001": { isFloodControlEnabled: "yes" } },
      global: { copy: { copiedUser: null } },
    })).toThrow("state.chats.-1001.isFloodControlEnabled must be a boolean");
  });

  test("旧 model 块不再属于状态 schema，必须迁移到 config/agent.json", () => {
    expect(() => decodeStateFile({
      chats: {},
      global: { copy: { copiedUser: null }, model: { image: "openai" } },
    })).toThrow("state.global.model is not part of the current state schema");
  });

  test("素材块整块缺省 = 四项都没设过：既有 state.json 不必补空对象", () => {
    const decoded = decodeStateFile({ chats: {}, global: { copy: { copiedUser: null } } });
    expect(decoded.global.assets).toEqual({
      fortuneThumbnailUrl: undefined,
      probabilityThumbnailUrl: undefined,
      gagThumbnailUrl: undefined,
      botDefaultAvatarUrl: undefined,
    });
  });

  test("四条素材直链原样读回，且各自独立", () => {
    const decoded = decodeStateFile({
      chats: {},
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
    const decoded = decodeStateFile({
      chats: {},
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
    const decoded = decodeStateFile({
      chats: {},
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
    const decoded = decodeStateFile({
      chats: {},
      global: {
        copy: { copiedUser: null },
        assets: { botDefaultAvatarUrl: "http://assets.internal/face.jpg" },
      },
    });
    expect(decoded.global.assets.botDefaultAvatarUrl).toBe("http://assets.internal/face.jpg");
    for (const key of ["fortuneThumbnailUrl", "probabilityThumbnailUrl", "gagThumbnailUrl"]) {
      expect(() => decodeStateFile({
        chats: {},
        global: { copy: { copiedUser: null }, assets: { [key]: "http://cdn.example/f.png" } },
      })).toThrow(`state.global.assets.${key} must use https`);
    }
  });

  test("补齐用的四个内置常量本身必须通过同一道校验", () => {
    // 补齐直接把常量赋进 globalAssetState，绕过解码期校验；而每次 save 都会对含
    // 这四项的快照再跑一次 decodeStateFile 自检。常量写坏的代价不是「图不显示」，
    // 而是此后每一次落盘都 reject——`/copy`、`/quiet`、权限变更全部存不下去。
    const decoded = decodeStateFile({
      chats: {},
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
    expect(() => decodeStateFile({
      chats: {},
      global: { copy: { copiedUser: null }, assets: { fortuneThumbnailUrl: "drive.google.com/uc?id=x" } },
    })).toThrow("state.global.assets.fortuneThumbnailUrl must be an absolute https URL");
    expect(() => decodeStateFile({
      chats: {},
      global: { copy: { copiedUser: null }, assets: { botDefaultAvatarUrl: "file:///etc/passwd" } },
    })).toThrow("state.global.assets.botDefaultAvatarUrl must use http or https");
    for (const bad of ["", "   ", 1, null]) {
      expect(() => decodeStateFile({
        chats: {},
        global: { copy: { copiedUser: null }, assets: { probabilityThumbnailUrl: bad } },
      })).toThrow("state.global.assets.probabilityThumbnailUrl must be a non-empty string");
    }
  });

  test("素材块的未知键拒绝整份状态——拼错的键被无声忽略最危险", () => {
    expect(() => decodeStateFile({
      chats: {},
      global: { copy: { copiedUser: null }, assets: { fortuneThumbUrl: "https://cdn.example/f.png" } },
    })).toThrow("state.global.assets.fortuneThumbUrl is not part of the current state schema");
  });

  test("global 块的未知键与缺失 copy 都拒绝整份状态", () => {
    expect(() => decodeStateFile({
      chats: {},
      global: { copy: { copiedUser: null }, mood: "happy" },
    })).toThrow("state.global.mood is not part of the current state schema");
    expect(() => decodeStateFile({ chats: {}, global: {} })).toThrow("state.global.copy is required");
  });

  test("旧结构（顶层 globalCopy / imageProvider / chatProvider）当场拒绝，不静默读成空", () => {
    // 结构变更只做手工迁移：兼容分支会让复读状态被静默读成空，而群里看不出区别。
    expect(() => decodeStateFile({
      chats: {},
      globalCopy: { copiedUser: null, lastCopyTime: 1_000_000 },
    })).toThrow("state.globalCopy is not part of the current state schema");
    expect(() => decodeStateFile({
      chats: {},
      global: { copy: { copiedUser: null } },
      imageProvider: "gemini",
    })).toThrow("state.imageProvider is not part of the current state schema");
    expect(() => decodeStateFile({ chats: {} })).toThrow("state.global is required");
  });

  test("旧版功能开关字段拒绝加载，避免新旧命名混用", () => {
    for (const legacyField of ["isUseAIChat", "isInit", "isUseProxySend"]) {
      expect(() => decodeStateFile({
        chats: { "-1001": { [legacyField]: true } },
        global: { copy: { copiedUser: null } },
      })).toThrow(`state.chats.-1001.${legacyField}`);
    }
  });
});
