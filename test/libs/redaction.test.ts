import { describe, expect, test } from "bun:test";
import { REDACTED_SECRET, redactSecretsInText } from "../../src/libs/redaction";

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
