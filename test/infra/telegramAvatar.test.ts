import { afterEach, describe, expect, mock, test } from "bun:test";
import { AVATAR_FETCH_MAX_ATTEMPTS } from "../../packages/consts/telegram";
import { runAvatarFetchAttempts } from "../../packages/infra/telegram/avatar/shared";
import type {
  AvatarFetchAttemptsOutcome,
  AvatarOperationAttemptResult,
} from "../../packages/infra/telegram/avatar/shared";
import {
  extractAvatarUrlFromProfileHtml,
  extractPublicUsername,
  fetchAvatarFromWebProfile,
  normalizePublicUsername,
} from "../../packages/infra/telegram/avatar/webProfile";

const realFetch: typeof fetch = globalThis.fetch;

afterEach((): void => {
  globalThis.fetch = realFetch;
});

describe("Telegram 公开头像解析", () => {
  const telegramCdnUrl: string = "https://cdn1.telesco.pe";

  test("规范化公开用户名并拒绝空值", () => {
    expect(normalizePublicUsername("  @@CopyNinjiaBot ")).toBe("CopyNinjiaBot");
    expect(normalizePublicUsername(" @@@ ")).toBeUndefined();
    expect(normalizePublicUsername(undefined)).toBeUndefined();
  });

  test("优先读取 username，并从 active_usernames 兜底", () => {
    expect(extractPublicUsername({ username: " primary ", active_usernames: ["backup"] })).toBe("primary");
    expect(extractPublicUsername({ username: "@@", active_usernames: [42, " @backup "] })).toBe("backup");
    expect(extractPublicUsername({ active_usernames: [null, ""] })).toBeUndefined();
    expect(extractPublicUsername(null)).toBeUndefined();
  });

  test("按 class token 提取头像，并兼容单双引号、属性顺序、大小写和 HTML entity", () => {
    expect(
      extractAvatarUrlFromProfileHtml(
        `<img src="https://cdn.example/unrelated.jpg"><img src="${telegramCdnUrl}/avatar.jpg" class="photo tgme_page_photo_image current">`
      )
    ).toBe(`${telegramCdnUrl}/avatar.jpg`);
    expect(
      extractAvatarUrlFromProfileHtml(
        `<IMG SRC = '${telegramCdnUrl}/avatar.jpg?size=1&amp;crop=1' CLASS = 'photo TGME_PAGE_PHOTO_IMAGE current'>`
      )
    ).toBe(`${telegramCdnUrl}/avatar.jpg?size=1&crop=1`);
    expect(extractAvatarUrlFromProfileHtml('<img class="tgme_page_photo_image" src="http://cdn.example/avatar.jpg">')).toBeUndefined();
    expect(extractAvatarUrlFromProfileHtml('<img class="not_tgme_page_photo_image" src="https://cdn.example/avatar.jpg">')).toBeUndefined();
    expect(extractAvatarUrlFromProfileHtml('<img class="other" src="https://cdn.example/avatar.jpg">')).toBeUndefined();
    expect(extractAvatarUrlFromProfileHtml('<img class="tgme_page_photo_image" src="https://eviltelegram.org/avatar.jpg">')).toBeUndefined();
    expect(extractAvatarUrlFromProfileHtml('<img class="tgme_page_photo_image" src="https://cdn-telegram.org.evil.example/avatar.jpg">')).toBeUndefined();
    expect(extractAvatarUrlFromProfileHtml('<img class="tgme_page_photo_image" src="https://cdn4.cdn-telegram.org:444/avatar.jpg">')).toBeUndefined();
  });

  test("头像 class 优先于页面 meta 图片", () => {
    const html = `
      <meta property="og:url" content="https://t.me/CopyNinjiaBot">
      <meta property="og:image" content="${telegramCdnUrl}/meta.jpg">
      <img class="tgme_page_photo_image" src="${telegramCdnUrl}/class.jpg">
    `;
    expect(extractAvatarUrlFromProfileHtml(html, "CopyNinjiaBot")).toBe(`${telegramCdnUrl}/class.jpg`);
  });

  test("class 缺失时按优先级读取已验证页面的 og:image 或 twitter:image", () => {
    const ogHtml = `
      <META CONTENT = 'tg://resolve?domain=CopyNinjiaBot' PROPERTY = 'AL:IOS:URL'>
      <meta name="twitter:image" content="${telegramCdnUrl}/twitter.jpg">
      <meta content="${telegramCdnUrl}/og.jpg?size=1&amp;crop=1" property="og:image">
    `;
    expect(extractAvatarUrlFromProfileHtml(ogHtml, "@copyninjiabot")).toBe(`${telegramCdnUrl}/og.jpg?size=1&crop=1`);

    const twitterHtml = `
      <link href="https://telegram.me/CopyNinjiaBot/" rel="alternate CANONICAL">
      <meta content="${telegramCdnUrl}/twitter.jpg" name="Twitter:Image">
    `;
    expect(extractAvatarUrlFromProfileHtml(twitterHtml, "CopyNinjiaBot")).toBe(`${telegramCdnUrl}/twitter.jpg`);
  });

  test("拒绝没有匹配页面身份的非头像 meta 图片和挑战页", () => {
    const unrelatedOg = `
      <meta property="al:android:url" content="tg://resolve?domain=AnotherBot">
      <meta property="og:image" content="https://cdn.example/unrelated.jpg">
    `;
    expect(extractAvatarUrlFromProfileHtml(unrelatedOg, "CopyNinjiaBot")).toBeUndefined();
    expect(
      extractAvatarUrlFromProfileHtml(
        '<meta property="og:image" content="https://telegram.org/img/t_logo.png"><title>Checking your browser</title>',
        "CopyNinjiaBot"
      )
    ).toBeUndefined();
    expect(
      extractAvatarUrlFromProfileHtml(
        '<meta property="og:url" content="https://evil.example/CopyNinjiaBot"><meta property="og:image" content="https://cdn.example/avatar.jpg">',
        "CopyNinjiaBot"
      )
    ).toBeUndefined();
    expect(
      extractAvatarUrlFromProfileHtml(
        '<meta property="al:ios:url" content="tg://resolve?domain=CopyNinjiaBot&amp;start=challenge"><meta property="og:image" content="https://cdn.example/avatar.jpg">',
        "CopyNinjiaBot"
      )
    ).toBeUndefined();
  });

  test("meta 回退仍拒绝非 HTTPS 或带凭证的图片地址", () => {
    const identity = '<meta property="og:url" content="https://t.me/CopyNinjiaBot">';
    expect(
      extractAvatarUrlFromProfileHtml(`${identity}<meta property="og:image" content="http://cdn.example/avatar.jpg">`, "CopyNinjiaBot")
    ).toBeUndefined();
    expect(
      extractAvatarUrlFromProfileHtml(`${identity}<meta property="og:image" content="https://user:pass@cdn.example/avatar.jpg">`, "CopyNinjiaBot")
    ).toBeUndefined();
  });

  test("公开主页与头像下载都拒绝自动重定向，且保留原字节上限链路", async () => {
    const fetchCalls: { input: string; init: RequestInit | undefined }[] = [];
    const avatarBytes: Uint8Array = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = mock(async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => {
      fetchCalls.push({ input: String(input), init });
      if (fetchCalls.length === 1) {
        return new Response(
          `<img class="tgme_page_photo_image" src="${telegramCdnUrl}/avatar.jpg">`
        );
      }
      return new Response(avatarBytes);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchAvatarFromWebProfile("CopyNinjiaBot")).resolves.toEqual(avatarBytes);
    expect(fetchCalls.map((call): string => call.input)).toEqual([
      "https://telegram.me/CopyNinjiaBot",
      `${telegramCdnUrl}/avatar.jpg`,
    ]);
    expect(fetchCalls.every((call): boolean => call.init?.redirect === "error")).toBeTrue();
    expect(fetchCalls.every((call): boolean => call.init?.signal instanceof AbortSignal)).toBeTrue();
  });
});

describe("头像操作的有界重试", () => {
  interface ScriptedAttempts {
    readonly attempt: (attemptNumber: number) => Promise<AvatarOperationAttemptResult>;
    readonly seen: number[];
  }

  function scriptedAttempts(results: readonly AvatarOperationAttemptResult[]): ScriptedAttempts {
    const seen: number[] = [];
    return {
      seen,
      attempt: async (attemptNumber: number): Promise<AvatarOperationAttemptResult> => {
        seen.push(attemptNumber);
        return results[attemptNumber - 1] ?? "transient-failure";
      },
    };
  }

  test("瞬时失败后重试，成功即停并按从 1 开始的序号调用", async () => {
    const { attempt, seen }: ScriptedAttempts = scriptedAttempts(["transient-failure", "ok"]);

    await expect(runAvatarFetchAttempts(attempt)).resolves.toBe("ok");
    expect(seen).toEqual([1, 2]);
  });

  test("确定性失败不再重试", async () => {
    const { attempt, seen }: ScriptedAttempts = scriptedAttempts(["permanent-failure", "ok"]);

    await expect(runAvatarFetchAttempts(attempt)).resolves.toBe("failed");
    expect(seen).toEqual([1]);
  });

  test("瞬时失败持续到上限后返回 failed", async () => {
    const { attempt, seen }: ScriptedAttempts = scriptedAttempts([]);

    await expect(runAvatarFetchAttempts(attempt)).resolves.toBe("failed");
    expect(seen).toHaveLength(AVATAR_FETCH_MAX_ATTEMPTS);
  });

  test("尝试开始前已取消时返回 aborted，不再调用下一次尝试", async () => {
    const preAborted: AbortController = new AbortController();
    preAborted.abort();
    const idle: ScriptedAttempts = scriptedAttempts(["ok"]);

    await expect(runAvatarFetchAttempts(idle.attempt, preAborted.signal)).resolves.toBe("aborted");
    expect(idle.seen).toEqual([]);

    const midway: AbortController = new AbortController();
    const seen: number[] = [];
    const outcome: Promise<AvatarFetchAttemptsOutcome> = runAvatarFetchAttempts(
      async (attemptNumber: number): Promise<AvatarOperationAttemptResult> => {
        seen.push(attemptNumber);
        midway.abort();
        return "transient-failure";
      },
      midway.signal
    );

    await expect(outcome).resolves.toBe("aborted");
    expect(seen).toEqual([1]);
  });
});
