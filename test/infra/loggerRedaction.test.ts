import { describe, expect, test } from "bun:test";
import { REDACTED_SECRET } from "../../packages/consts/redaction";
import { redactSensitiveFieldsInText } from "../../packages/infra/logger/redaction";

describe("文本内嵌凭据字段的值边界", () => {
  test("引号值里的转义引号不提前结束扫描，密钥尾段不会漏出", () => {
    const text: string =
      "{\"authorization\":\"Bearer upstream-\\\"escaped-secret-1\",\"x-request-id\":\"visible-1\"}";

    const redacted: string = redactSensitiveFieldsInText(text);

    expect(redacted).toBe(`{"authorization":${REDACTED_SECRET},"x-request-id":"visible-1"}`);
    expect(redacted).not.toContain("escaped-secret-1");
  });

  test("容器值内嵌套对象与带转义引号的括号、逗号，整段替换到配平的右括号", () => {
    const text: string =
      "{\"set-cookie\":[{\"value\":\"cookie-\\\"],}secret-2\",\"attrs\":{\"path\":\"/\"}}]," +
      "\"x-request-id\":\"visible-2\"}";

    const redacted: string = redactSensitiveFieldsInText(text);

    expect(redacted).toBe(`{"set-cookie":${REDACTED_SECRET},"x-request-id":"visible-2"}`);
    expect(redacted).not.toContain("secret-2");
  });

  test("非 JSON 的裸值只替换到行尾，下一行诊断保持可读", () => {
    const secret: string = "upstream-bare-secret-3";
    const text: string =
      `upstream: Authorization: Bearer ${secret}\r\nx-request-id: visible-3\npassword=${secret}\nother: 1`;

    const redacted: string = redactSensitiveFieldsInText(text);

    expect(redacted).toBe(
      `upstream: Authorization: ${REDACTED_SECRET}\r\nx-request-id: visible-3\n` +
      `password=${REDACTED_SECRET}\nother: 1`
    );
    expect(redacted).not.toContain(secret);
  });

  test("引号或括号未闭合时脱敏到文本结尾", () => {
    expect(redactSensitiveFieldsInText("token=\"unterminated \\\" secret-4"))
      .toBe(`token=${REDACTED_SECRET}`);
    expect(redactSensitiveFieldsInText("cookie: [{\"name\":\"secret-5\"}, \"tail\""))
      .toBe(`cookie: ${REDACTED_SECRET}`);
  });
});
