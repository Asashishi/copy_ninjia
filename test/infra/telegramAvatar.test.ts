import { describe, expect, test } from "bun:test";
import {
  extractAvatarUrlFromProfileHtml,
  extractPublicUsername,
  normalizePublicUsername,
} from "../../src/infra/telegram/avatar";

describe("Telegram 公开头像解析", () => {
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
        '<img src="https://cdn.example/unrelated.jpg"><img src="https://cdn.example/avatar.jpg" class="photo tgme_page_photo_image current">'
      )
    ).toBe("https://cdn.example/avatar.jpg");
    expect(
      extractAvatarUrlFromProfileHtml(
        "<IMG SRC = 'https://cdn.example/avatar.jpg?size=1&amp;crop=1' CLASS = 'photo TGME_PAGE_PHOTO_IMAGE current'>"
      )
    ).toBe("https://cdn.example/avatar.jpg?size=1&crop=1");
    expect(extractAvatarUrlFromProfileHtml('<img class="tgme_page_photo_image" src="http://cdn.example/avatar.jpg">')).toBeUndefined();
    expect(extractAvatarUrlFromProfileHtml('<img class="not_tgme_page_photo_image" src="https://cdn.example/avatar.jpg">')).toBeUndefined();
    expect(extractAvatarUrlFromProfileHtml('<img class="other" src="https://cdn.example/avatar.jpg">')).toBeUndefined();
  });

  test("头像 class 优先于页面 meta 图片", () => {
    const html = `
      <meta property="og:url" content="https://t.me/CopyNinjiaBot">
      <meta property="og:image" content="https://cdn.example/meta.jpg">
      <img class="tgme_page_photo_image" src="https://cdn.example/class.jpg">
    `;
    expect(extractAvatarUrlFromProfileHtml(html, "CopyNinjiaBot")).toBe("https://cdn.example/class.jpg");
  });

  test("class 缺失时按优先级读取已验证页面的 og:image 或 twitter:image", () => {
    const ogHtml = `
      <META CONTENT = 'tg://resolve?domain=CopyNinjiaBot' PROPERTY = 'AL:IOS:URL'>
      <meta name="twitter:image" content="https://cdn.example/twitter.jpg">
      <meta content="https://cdn.example/og.jpg?size=1&amp;crop=1" property="og:image">
    `;
    expect(extractAvatarUrlFromProfileHtml(ogHtml, "@copyninjiabot")).toBe("https://cdn.example/og.jpg?size=1&crop=1");

    const twitterHtml = `
      <link href="https://telegram.me/CopyNinjiaBot/" rel="alternate CANONICAL">
      <meta content="https://cdn.example/twitter.jpg" name="Twitter:Image">
    `;
    expect(extractAvatarUrlFromProfileHtml(twitterHtml, "CopyNinjiaBot")).toBe("https://cdn.example/twitter.jpg");
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
});
