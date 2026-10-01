import { describe, expect, test } from "bun:test";
import { REDACTED_SECRET, REDACTED_URL } from "../../packages/consts/redaction";
import { redactSecretsInText, redactUrlForLog } from "../../packages/libs/redaction";

describe("日志敏感值脱敏", () => {
  test("会清除 Bun fetch Error 的 path/message/stack 中完整 token，且忽略空 secret", () => {
    const token = "123456789:very-sensitive-bot-token";
    const serializedError = JSON.stringify({
      name: "SystemError",
      message: `failed to fetch bot${token}`,
      stack: `fetch https://api.telegram.org/file/bot${token}/photos/file.jpg`,
      path: `https://api.telegram.org/file/bot${token}/photos/file.jpg`,
    });

    const redacted = redactSecretsInText(serializedError, ["", token]);
    expect(redacted).not.toContain(token);
    expect(redacted.match(new RegExp(`\\${REDACTED_SECRET}`, "g"))?.length).toBe(3);
    expect(JSON.parse(redacted).path).toContain(`bot${REDACTED_SECRET}`);
  });
});

describe("日志中的地址收敛", () => {
  test("只留 origin 与 pathname：预签名参数不落进 logs/", () => {
    // 地址标签与统一日志边界均移除部署素材 URL 的查询串。
    const presigned = "https://bucket.example/faces/bot.png?X-Amz-Signature=deadbeefcafe&X-Amz-Expires=600";

    expect(redactUrlForLog(presigned)).toBe("https://bucket.example/faces/bot.png");
  });

  test("fragment 与 userinfo 同样不出现在结果里", () => {
    expect(redactUrlForLog("https://user:pass@cdn.example/face.jpg#frag")).toBe("https://cdn.example/face.jpg");
  });

  test("普通直链原样保留，诊断信息不丢", () => {
    expect(redactUrlForLog("http://10.0.0.2:8080/assets/face.jpg")).toBe("http://10.0.0.2:8080/assets/face.jpg");
  });

  test("解析不了时给占位符而不是原串——原串同样可能带密钥", () => {
    expect(redactUrlForLog("cdn.example/face.jpg?sig=secret")).toBe(REDACTED_URL);
  });
});
