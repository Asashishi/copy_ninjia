/**
 * restoreDefaultProfilePhoto：把机器人头像换回 BOT_DEFAULT_AVATAR_URL 那张。
 *
 * 重点守五条：
 * 1. **跟随重定向**：地址是部署配置的一部分，而图床与对象存储的直链先跳一次到存储
 *    域名是常态（内置缺省那条 Drive 链接即是）。/copy、/steal_icon 那三条的
 *    `redirect: "error"`（见 telegramAvatar / telegram.copyAvatar 两份用例）归
 *    Telegram 自有资产域 allowlist 那条约束管，与这一条不是一回事。
 * 2. 响应仍走有界读取，第三方响应撑不爆内存。
 * 3. 上传前认一遍字节签名：Drive 在配额超限/病毒扫描警告时会以 HTTP 200 返回
 *    一张 HTML 插页，不挡住它就等于把 HTML 当图片交给 Telegram。
 * 4. 瞬时失败按 AVATAR_FETCH_MAX_ATTEMPTS 重试，确定性失败立刻放弃——确定性
 *    拒绝白烧三次头像接口调用，正好可能撞上重试本想规避的 flood 限制。
 * 5. 失败日志点名地址但不带查询串：这一项是部署方配的，可能是预签名地址。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { GrammyError } from "grammy";
import {
  AVATAR_FETCH_MAX_ATTEMPTS,
  AVATAR_MAX_DOWNLOAD_BYTES,
} from "../../packages/consts/telegram";
import { BOT_DEFAULT_AVATAR_URL } from "../../packages/consts/ui/assets";

const loggerErrorMock = mock((..._args: unknown[]): void => {});
mock.module("../../packages/infra/logger", () => ({
  logger: {
    log: mock((..._args: unknown[]): void => {}),
    info: mock((..._args: unknown[]): void => {}),
    warn: mock((..._args: unknown[]): void => {}),
    error: loggerErrorMock,
  },
}));

const realFetch = globalThis.fetch;
const { bot } = await import("../../packages/infra/telegram/mainClient");
const { restoreDefaultProfilePhoto } = await import("../../packages/infra/telegram/avatar");

const setMyProfilePhotoMock = mock(async (..._args: unknown[]): Promise<boolean> => true);
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];
const fetchCalls: { url: string; init: FetchInit }[] = [];

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** 让 fetch 按给定的响应序列逐次返回；用完后复用最后一个。 */
function stubFetch(responses: readonly (() => Response)[]): void {
  let index: number = 0;
  globalThis.fetch = (async (input: FetchInput, init: FetchInit): Promise<Response> => {
    fetchCalls.push({ url: urlOf(input), init });
    const make: () => Response = responses[Math.min(index, responses.length - 1)]!;
    index++;
    return make();
  }) as typeof fetch;
}

/** 合法 PNG 的 8 字节签名，后面补几字节凑成一份「像样的」载荷。 */
const PNG_BYTES: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);

function imageResponse(bytes: Uint8Array = PNG_BYTES): Response {
  return new Response(bytes, { status: 200 });
}

/** Drive 在配额超限/病毒扫描警告时返回的那种 HTML 插页：HTTP 200，正文是网页。 */
function interstitialResponse(): Response {
  return new Response("<!DOCTYPE html><html><body>Quota exceeded</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

beforeEach(() => {
  globalThis.fetch = realFetch;
  fetchCalls.length = 0;
  loggerErrorMock.mockClear();
  setMyProfilePhotoMock.mockClear();
  setMyProfilePhotoMock.mockImplementation(async (): Promise<boolean> => true);
  // @ts-expect-error 测试替身：只替换本用例真正会调用的那一个 API。
  bot.api.setMyProfilePhoto = setMyProfilePhotoMock;
});

describe("默认头像的取图口径", () => {
  test("传入的直链原样使用——部署方可用 state.global.assets 换脸", async () => {
    // 目标 URL 由主线程从 state 取好后传进来（见 copy/avatarQueue.ts），本模块
    // 被两条 Worker 一并 import，不能自己去读只属于主线程的 state 内存。
    const configured: string = "https://cdn.example/custom-face.jpg";
    stubFetch([(): Response => imageResponse()]);

    await expect(restoreDefaultProfilePhoto(configured)).resolves.toBe(true);
    expect(fetchCalls[0]!.url).toBe(configured);
  });

  test("请求跟随重定向：内置缺省那条 Drive 链接就会先跳一次", async () => {
    stubFetch([(): Response => imageResponse()]);

    await expect(restoreDefaultProfilePhoto(BOT_DEFAULT_AVATAR_URL)).resolves.toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(BOT_DEFAULT_AVATAR_URL);
    // 逼配置者自己解析出跳转终点，只会把一个必然踩到的坑变成必须写进文档的注意
    // 事项。下面两道检查（有界读取 + 字节签名）防的是「拿回来的不是图片」，与跳
    // 不跳转无关。
    expect(fetchCalls[0]!.init?.redirect).toBe("follow");
    expect(setMyProfilePhotoMock).toHaveBeenCalledTimes(1);
  });

  test("取到的字节原样交给 setMyProfilePhoto", async () => {
    stubFetch([(): Response => imageResponse(JPEG_BYTES)]);

    await expect(restoreDefaultProfilePhoto(BOT_DEFAULT_AVATAR_URL)).resolves.toBe(true);
    const [payload] = setMyProfilePhotoMock.mock.calls[0] as [{ type: string; photo: unknown }];
    expect(payload.type).toBe("static");
  });
});

describe("上传前的字节校验", () => {
  test("Drive 的 HTML 插页（HTTP 200）不当图片上传，且不重试", async () => {
    stubFetch([(): Response => interstitialResponse()]);

    await expect(restoreDefaultProfilePhoto(BOT_DEFAULT_AVATAR_URL)).resolves.toBe(false);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    // 配额/病毒扫描插页重试多少次都是同一张，白烧头像接口的额度。
    expect(fetchCalls).toHaveLength(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("did not return a JPEG or PNG image (sniffed=unknown")
    );
  });

  test("零长响应体同样视为失败：有界读取会把它报成 ok", async () => {
    stubFetch([(): Response => new Response(null, { status: 200 })]);

    await expect(restoreDefaultProfilePhoto(BOT_DEFAULT_AVATAR_URL)).resolves.toBe(false);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("bytes=0"));
  });

  test("WebP 之类 Telegram 不收的静态图也在本地就挡掉", async () => {
    // 字节数组而不是带 NUL 的字符串字面量：写成字符串会让整个文件被 git 判成二进制，
    // diff/blame 全失效，本文件覆盖的换脸路径就再也进不了代码审查。
    const webp: Uint8Array = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    ]);
    stubFetch([(): Response => imageResponse(webp)]);

    await expect(restoreDefaultProfilePhoto(BOT_DEFAULT_AVATAR_URL)).resolves.toBe(false);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("sniffed=webp"));
  });
});

describe("失败分类", () => {
  test("非 2xx 属瞬时失败，按上限重试后放弃", async () => {
    stubFetch([(): Response => new Response("nope", { status: 503 })]);

    await expect(restoreDefaultProfilePhoto(BOT_DEFAULT_AVATAR_URL)).resolves.toBe(false);
    expect(fetchCalls).toHaveLength(AVATAR_FETCH_MAX_ATTEMPTS);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("Failed to download the default avatar (503)"));
  });

  test("首次失败、重试成功时最终仍算复原成功", async () => {
    stubFetch([
      (): Response => new Response("nope", { status: 500 }),
      (): Response => imageResponse(),
    ]);

    await expect(restoreDefaultProfilePhoto(BOT_DEFAULT_AVATAR_URL)).resolves.toBe(true);
    expect(fetchCalls).toHaveLength(2);
  });

  test("超限是确定性失败：立刻放弃，不浪费剩余重试次数", async () => {
    stubFetch([(): Response => imageResponse(new Uint8Array(AVATAR_MAX_DOWNLOAD_BYTES + 1))]);

    await expect(restoreDefaultProfilePhoto(BOT_DEFAULT_AVATAR_URL)).resolves.toBe(false);
    expect(fetchCalls).toHaveLength(1);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("exceeded the download limit"));
  });

  test("setMyProfilePhoto 抛瞬时错误时记日志并按上限重试", async () => {
    stubFetch([(): Response => imageResponse()]);
    setMyProfilePhotoMock.mockImplementation(async (): Promise<boolean> => {
      throw new Error("flood wait");
    });

    await expect(restoreDefaultProfilePhoto(BOT_DEFAULT_AVATAR_URL)).resolves.toBe(false);
    expect(setMyProfilePhotoMock).toHaveBeenCalledTimes(AVATAR_FETCH_MAX_ATTEMPTS);
  });

  test("Telegram 的 400 是对这张图本身的判定：只试一次就放弃", async () => {
    stubFetch([(): Response => imageResponse()]);
    setMyProfilePhotoMock.mockImplementation(async (): Promise<boolean> => {
      throw new GrammyError(
        "Bad Request: PHOTO_CROP_SIZE_SMALL",
        { ok: false, error_code: 400, description: "Bad Request: PHOTO_CROP_SIZE_SMALL" },
        "setMyProfilePhoto",
        {}
      );
    });

    await expect(restoreDefaultProfilePhoto(BOT_DEFAULT_AVATAR_URL)).resolves.toBe(false);
    // 换几次都一样，重试只会白烧换头像的限流额度。
    expect(setMyProfilePhotoMock).toHaveBeenCalledTimes(1);
  });

  test("调用方已取消时立刻返回，不发请求", async () => {
    stubFetch([(): Response => imageResponse()]);
    const controller: AbortController = new AbortController();
    controller.abort();

    await expect(restoreDefaultProfilePhoto(BOT_DEFAULT_AVATAR_URL, controller.signal)).resolves.toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("失败日志的地址脱敏", () => {
  /** 本次运行里所有 logger.error 参数拼成一段，用于整体断言。 */
  function loggedText(): string {
    return loggerErrorMock.mock.calls.flat().map((arg: unknown): string => String(arg)).join(" ");
  }

  const PRESIGNED: string = "https://bucket.example/faces/bot.png?X-Amz-Signature=deadbeefcafe&X-Amz-Expires=600";

  test("取图用完整地址，日志只留 origin + pathname", async () => {
    // 部署方可以把这一项配成 S3/OSS 预签名地址，而 logs/<day>.json 的 mode 是
    // 0644 且属于备份对象；libs/redaction.ts 的 redactSecretsInText 只脱敏已登记
    // 的 env 密钥、不看 query，所以签名要在拼日志时就去掉。
    stubFetch([(): Response => interstitialResponse()]);

    await expect(restoreDefaultProfilePhoto(PRESIGNED)).resolves.toBe(false);
    // 签名不能被顺手削掉：削掉了这张图根本取不回来。
    expect(fetchCalls[0]!.url).toBe(PRESIGNED);
    expect(loggedText()).toContain("https://bucket.example/faces/bot.png");
    expect(loggedText()).not.toContain("X-Amz-Signature");
  });

  test("四条失败分支一条都不漏（非 2xx、超限、非图片、上传抛错）", async () => {
    const cases: readonly (() => Response)[] = [
      (): Response => new Response("nope", { status: 503 }),
      (): Response => interstitialResponse(),
      (): Response => imageResponse(new Uint8Array(AVATAR_MAX_DOWNLOAD_BYTES + 1)),
      (): Response => imageResponse(),
    ];
    setMyProfilePhotoMock.mockImplementation(async (): Promise<boolean> => {
      throw new Error("flood wait");
    });

    for (const make of cases) {
      loggerErrorMock.mockClear();
      stubFetch([make]);
      await expect(restoreDefaultProfilePhoto(PRESIGNED)).resolves.toBe(false);
      expect(loggerErrorMock).toHaveBeenCalled();
      expect(loggedText()).not.toContain("X-Amz-Signature");
    }
  });
});
