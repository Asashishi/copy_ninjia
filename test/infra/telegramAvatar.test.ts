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

  test("只提取头像标签中的 HTTPS 图片地址", () => {
    expect(
      extractAvatarUrlFromProfileHtml(
        '<img src="https://cdn.example/unrelated.jpg"><img src="https://cdn.example/avatar.jpg" class="photo tgme_page_photo_image current">'
      )
    ).toBe("https://cdn.example/avatar.jpg");
    expect(extractAvatarUrlFromProfileHtml('<img class="tgme_page_photo_image" src="http://cdn.example/avatar.jpg">')).toBeUndefined();
    expect(extractAvatarUrlFromProfileHtml('<img class="other" src="https://cdn.example/avatar.jpg">')).toBeUndefined();
  });
});
