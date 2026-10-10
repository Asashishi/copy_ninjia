/**
 * restoreDefaultProfilePhoto：把机器人头像换回默认来源（直链或本机文件）那张。
 *
 * 直链来源覆盖：
 * 1. 跟随重定向：地址是部署配置的一部分，图床与对象存储的直链先跳一次到存储域名是常态。
 *    /copy、/icon steal 那几条的 `redirect: "error"`（见 telegramAvatar / telegram.copyAvatar 两份用例）
 *    归 Telegram 自有资产域 allowlist 约束管，与这一条无关。
 * 2. 响应仍走有界读取。
 * 3. 上传前认一遍字节签名：JPEG/PNG 按静态头像、MP4 按动态头像上传；HTTP 200 返回的 HTML 插页
 *    （如 Drive 的配额超限/病毒扫描警告页）不交给 Telegram。
 * 4. 瞬时失败按 AVATAR_FETCH_MAX_ATTEMPTS 重试，确定性失败立刻放弃。
 * 5. 失败日志点名地址但不带查询串（地址可能是预签名地址）。
 *
 * 本机文件来源同样有界读取、上传前认字节签名；读不到、超限与签名不符都是确定性失败。
 */

import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loggerStub } from "../helpers/loggerMock";
import { GrammyError } from "grammy";
import type { InputFile } from "grammy";
import {
  AVATAR_FETCH_MAX_ATTEMPTS,
  BOT_PROFILE_PHOTO_MAX_BYTES,
  DEFAULT_AVATAR_EXPECTED_FORM,
  DEFAULT_AVATAR_FETCH_TIMEOUT_MS,
  DEFAULT_AVATAR_MAX_READ_BYTES,
} from "../../packages/consts/telegram";
import { RUNTIME_DATA_ROOT } from "../../packages/consts/paths";
import { BOT_DEFAULT_AVATAR_URL, DEFAULT_ASSET_CONFIG } from "../../packages/consts/ui/assets";
import type { DefaultAvatarSource } from "../../packages/types/config";
import { MP4_BYTES, ftypBox, moovBox, mp4OfSize, trakBox } from "../helpers/mp4";

const loggerErrorMock = mock((..._args: unknown[]): void => {});
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ error: loggerErrorMock }),
}));

const realFetch = globalThis.fetch;
const { bot } = await import("../../packages/infra/telegram/mainClient");
const { restoreDefaultProfilePhoto } = await import("../../packages/infra/telegram/avatar/restore");

/** 内置缺省来源：指向 BOT_DEFAULT_AVATAR_URL 的直链。 */
const DEFAULT_SOURCE: DefaultAvatarSource = DEFAULT_ASSET_CONFIG.botDefaultAvatar;
/** 本机文件来源的夹具目录，放在测试进程独占的数据根下。 */
const FIXTURE_DIR: string = join(RUNTIME_DATA_ROOT, "avatar-restore-fixtures");

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

/** 合法 PNG 的字节签名，后面补几字节凑成一份「像样的」载荷。 */
const PNG_BYTES: Uint8Array = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG_BYTES: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);

function imageResponse(bytes: Uint8Array = PNG_BYTES): Response {
  return new Response(bytes, { status: 200 });
}

/** 分块流出 DEFAULT_AVATAR_MAX_READ_BYTES + 1 字节的响应：各块复用同一段缓冲，不一次分配整段响应体。 */
function oversizedResponse(): Response {
  const chunk: Uint8Array = new Uint8Array(1024 * 1024);
  let remaining: number = DEFAULT_AVATAR_MAX_READ_BYTES + 1;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const size: number = Math.min(remaining, chunk.length);
      controller.enqueue(chunk.subarray(0, size));
      remaining -= size;
    },
  }), { status: 200 });
}

/** HTTP 200 返回的 HTML 插页（如 Drive 的配额超限/病毒扫描警告页）：正文是网页。 */
function interstitialResponse(): Response {
  return new Response("<!DOCTYPE html><html><body>Quota exceeded</body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

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
  test("传入的直链原样使用——部署方可用 config/dynamic/assets.json 换脸", async () => {
    // 来源由 copy/avatarQueue.ts 从主线程素材快照取好后传进来，本模块不读取素材快照。
    const configured: string = "https://cdn.example/custom-face.jpg";
    stubFetch([(): Response => imageResponse()]);

    await expect(restoreDefaultProfilePhoto({ kind: "url", url: configured })).resolves.toBe(true);
    expect(fetchCalls[0]!.url).toBe(configured);
  });

  test("内置缺省来源就是 BOT_DEFAULT_AVATAR_URL 直链", () => {
    expect(DEFAULT_SOURCE).toEqual({ kind: "url", url: BOT_DEFAULT_AVATAR_URL });
  });

  test("请求跟随重定向：内置缺省那条 Drive 链接就会先跳一次", async () => {
    stubFetch([(): Response => imageResponse()]);

    await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE)).resolves.toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(BOT_DEFAULT_AVATAR_URL);
    // 请求用 redirect: "follow"；有界读取与字节签名两道检查与跳转无关。
    expect(fetchCalls[0]!.init?.redirect).toBe("follow");
    expect(setMyProfilePhotoMock).toHaveBeenCalledTimes(1);
  });

  test("取到的字节原样交给 setMyProfilePhoto", async () => {
    stubFetch([(): Response => imageResponse(JPEG_BYTES)]);

    await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE)).resolves.toBe(true);
    const [payload] = setMyProfilePhotoMock.mock.calls[0] as [{ type: string; photo: InputFile }];
    expect(payload.type).toBe("static");
    expect(await payload.photo.toRaw()).toEqual(JPEG_BYTES);
  });

  test("直链下载按 DEFAULT_AVATAR_FETCH_TIMEOUT_MS 计时", async () => {
    const timeoutSpy = spyOn(AbortSignal, "timeout");
    stubFetch([(): Response => imageResponse(MP4_BYTES)]);
    try {
      await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE)).resolves.toBe(true);
      expect(timeoutSpy.mock.calls).toEqual([[DEFAULT_AVATAR_FETCH_TIMEOUT_MS]]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  test("直链返回 MP4 时按动态头像上传，字节原样交出", async () => {
    stubFetch([(): Response => imageResponse(MP4_BYTES)]);

    await expect(restoreDefaultProfilePhoto({ kind: "url", url: "https://cdn.example/face.mp4" })).resolves.toBe(true);
    const [payload] = setMyProfilePhotoMock.mock.calls[0] as [Record<string, unknown>];
    expect(payload.type).toBe("animated");
    expect(payload).not.toHaveProperty("photo");
    expect(payload).not.toHaveProperty("main_frame_timestamp");
    expect(await (payload.animation as InputFile).toRaw()).toEqual(MP4_BYTES);
  });
});

describe("上传前的字节校验", () => {
  test("Drive 的 HTML 插页（HTTP 200）不当图片上传，且不重试", async () => {
    stubFetch([(): Response => interstitialResponse()]);

    await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE)).resolves.toBe(false);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    // 配额/病毒扫描插页是确定性失败：不重试。
    expect(fetchCalls).toHaveLength(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.stringContaining(`did not return ${DEFAULT_AVATAR_EXPECTED_FORM} (sniffed=unknown`)
    );
  });

  test("零长响应体同样视为失败：有界读取会把它报成 ok", async () => {
    stubFetch([(): Response => new Response(null, { status: 200 })]);

    await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE)).resolves.toBe(false);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("bytes=0"));
  });

  test("JPEG/PNG 超过 Bot API 图片上限时不上传、不重试", async () => {
    const png: Uint8Array = new Uint8Array(BOT_PROFILE_PHOTO_MAX_BYTES + 1);
    png.set(PNG_BYTES);
    stubFetch([(): Response => imageResponse(png)]);

    await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE)).resolves.toBe(false);
    expect(fetchCalls).toHaveLength(1);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.stringContaining(`did not return ${DEFAULT_AVATAR_EXPECTED_FORM} (sniffed=png, bytes=${png.byteLength})`)
    );
  });

  test("MP4 超过图片上限、不超过其他文件上限时照常按动态头像上传", async () => {
    const mp4: Uint8Array = mp4OfSize(BOT_PROFILE_PHOTO_MAX_BYTES + 1);
    stubFetch([(): Response => imageResponse(mp4)]);

    await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE)).resolves.toBe(true);
    const [payload] = setMyProfilePhotoMock.mock.calls[0] as [{ type: string; animation: InputFile }];
    expect(payload.type).toBe("animated");
    expect(await payload.animation.toRaw()).toEqual(mp4);
  });

  test("MP4 视频轨不是正方形时不上传、不重试，日志写出视频轨尺寸", async () => {
    const parts: readonly Uint8Array[] = [ftypBox({ major: "isom" }), moovBox(trakBox({ width: 1_280, height: 720 }))];
    stubFetch([(): Response => imageResponse(Bun.concatArrayBuffers([...parts], Infinity, true))]);

    await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE)).resolves.toBe(false);
    expect(fetchCalls).toHaveLength(1);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("sniffed=mp4 video tracks 1280x720"));
  });

  test("WebP 之类 Telegram 不收的静态图也在本地就挡掉", async () => {
    // 用字节数组构造夹具，不用带 NUL 的字符串字面量。
    const webp: Uint8Array = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    ]);
    stubFetch([(): Response => imageResponse(webp)]);

    await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE)).resolves.toBe(false);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("sniffed=webp"));
  });
});

describe("失败分类", () => {
  test("非 2xx 属瞬时失败，按上限重试后放弃", async () => {
    stubFetch([(): Response => new Response("nope", { status: 503 })]);

    await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE)).resolves.toBe(false);
    expect(fetchCalls).toHaveLength(AVATAR_FETCH_MAX_ATTEMPTS);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("Failed to download the default avatar (503)"));
  });

  test("首次失败、重试成功时最终仍算复原成功", async () => {
    stubFetch([
      (): Response => new Response("nope", { status: 500 }),
      (): Response => imageResponse(),
    ]);

    await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE)).resolves.toBe(true);
    expect(fetchCalls).toHaveLength(2);
  });

  test("超限是确定性失败：立刻放弃，不浪费剩余重试次数", async () => {
    stubFetch([oversizedResponse]);

    await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE)).resolves.toBe(false);
    expect(fetchCalls).toHaveLength(1);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("exceeded the download limit"));
  });

  test("setMyProfilePhoto 抛瞬时错误时记日志并按上限重试", async () => {
    stubFetch([(): Response => imageResponse()]);
    setMyProfilePhotoMock.mockImplementation(async (): Promise<boolean> => {
      throw new Error("flood wait");
    });

    await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE)).resolves.toBe(false);
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

    await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE)).resolves.toBe(false);
    // 确定性失败不重试。
    expect(setMyProfilePhotoMock).toHaveBeenCalledTimes(1);
  });

  test("调用方已取消时立刻返回，不发请求", async () => {
    stubFetch([(): Response => imageResponse()]);
    const controller: AbortController = new AbortController();
    controller.abort();

    await expect(restoreDefaultProfilePhoto(DEFAULT_SOURCE, controller.signal)).resolves.toBe(false);
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
    // 取图用完整地址（可能是预签名地址），日志只留 origin + pathname：
    // libs/redaction.ts 的 redactSecretsInText 只脱敏已登记的 env 密钥、不看 query，签名在拼日志时去掉。
    stubFetch([(): Response => interstitialResponse()]);

    await expect(restoreDefaultProfilePhoto({ kind: "url", url: PRESIGNED })).resolves.toBe(false);
    // 取图请求保留完整签名。
    expect(fetchCalls[0]!.url).toBe(PRESIGNED);
    expect(loggedText()).toContain("https://bucket.example/faces/bot.png");
    expect(loggedText()).not.toContain("X-Amz-Signature");
  });

  test("四条失败分支一条都不漏（非 2xx、超限、非图片、上传抛错）", async () => {
    const cases: readonly (() => Response)[] = [
      (): Response => new Response("nope", { status: 503 }),
      (): Response => interstitialResponse(),
      oversizedResponse,
      (): Response => imageResponse(),
    ];
    setMyProfilePhotoMock.mockImplementation(async (): Promise<boolean> => {
      throw new Error("flood wait");
    });

    for (const make of cases) {
      loggerErrorMock.mockClear();
      stubFetch([make]);
      await expect(restoreDefaultProfilePhoto({ kind: "url", url: PRESIGNED })).resolves.toBe(false);
      expect(loggerErrorMock).toHaveBeenCalled();
      expect(loggedText()).not.toContain("X-Amz-Signature");
    }
  });
});

describe("本机文件来源", () => {
  /** 在夹具目录写一份文件，返回它的绝对路径来源。 */
  async function fileSource(name: string, bytes: Uint8Array): Promise<DefaultAvatarSource> {
    const path: string = join(FIXTURE_DIR, name);
    await Bun.write(path, bytes);
    return { kind: "path", path };
  }

  /** 本用例里 setMyProfilePhoto 收到的上传载荷。 */
  async function uploadedRaw(): Promise<unknown> {
    const [payload] = setMyProfilePhotoMock.mock.calls[0] as [{ photo: InputFile }];
    return payload.photo.toRaw();
  }

  test("读到的字节原样上传，不发网络请求", async () => {
    stubFetch([(): Response => imageResponse()]);
    const source: DefaultAvatarSource = await fileSource("face.jpg", JPEG_BYTES);

    await expect(restoreDefaultProfilePhoto(source)).resolves.toBe(true);
    expect(fetchCalls).toHaveLength(0);
    expect(setMyProfilePhotoMock).toHaveBeenCalledTimes(1);
    expect(await uploadedRaw()).toEqual(JPEG_BYTES);
  });

  test("文件读不到是确定性失败：只试一次，日志点名路径", async () => {
    const path: string = join(FIXTURE_DIR, "missing.png");

    await expect(restoreDefaultProfilePhoto({ kind: "path", path })).resolves.toBe(false);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(`Failed to read the default avatar file ${path}:`, expect.anything());
  });

  test("超限是确定性失败，不上传", async () => {
    const source: DefaultAvatarSource = await fileSource("huge.png", new Uint8Array(DEFAULT_AVATAR_MAX_READ_BYTES + 1));

    await expect(restoreDefaultProfilePhoto(source)).resolves.toBe(false);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining("exceeds the size limit"));
  });

  test("MP4 文件按动态头像上传", async () => {
    const source: DefaultAvatarSource = await fileSource("face.mp4", MP4_BYTES);

    await expect(restoreDefaultProfilePhoto(source)).resolves.toBe(true);
    const [payload] = setMyProfilePhotoMock.mock.calls[0] as [{ type: string; animation: InputFile }];
    expect(payload.type).toBe("animated");
    expect(await payload.animation.toRaw()).toEqual(MP4_BYTES);
  });

  test("既非 JPEG/PNG 也非 MP4 是确定性失败，不上传", async () => {
    const source: DefaultAvatarSource = await fileSource("face.txt", new TextEncoder().encode("not an image"));

    await expect(restoreDefaultProfilePhoto(source)).resolves.toBe(false);
    expect(setMyProfilePhotoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).toHaveBeenCalledWith(expect.stringContaining(`is not ${DEFAULT_AVATAR_EXPECTED_FORM} (sniffed=unknown`));
  });

  test("上传抛瞬时错误时按上限重试，每次重新读文件", async () => {
    const source: DefaultAvatarSource = await fileSource("retry.png", PNG_BYTES);
    setMyProfilePhotoMock.mockImplementation(async (): Promise<boolean> => {
      throw new Error("flood wait");
    });

    await expect(restoreDefaultProfilePhoto(source)).resolves.toBe(false);
    expect(setMyProfilePhotoMock).toHaveBeenCalledTimes(AVATAR_FETCH_MAX_ATTEMPTS);
  });
});
