import { expect, test } from "bun:test";
import { decodeBase64Payload } from "../../../../packages/aiChat/ai/utils/base64Payload";

test.each([
  "Zh==", "Zm9=", "Zg", "Zg=", "Zg===", "====", "AA=A", "=AAA", "AA==AAAA",
  "AA-A", "AA_A", "A\tAA", "A\nAA", "A\rAA", "A AA", "A\fAA", "A\vAA",
  "A\u00a0AA", "A\u2003AA", "A\u2028AA", "A\ufeffAA", "!AAA", "AAA!",
])("拒绝非规范载荷 %j", (encoded) => {
  expect(decodeBase64Payload({ encoded, maxEncodedChars: 128, maxBytes: 128 }))
    .toEqual({ ok: false, reason: "payload is not canonical base64" });
});

test.each(["Zg==", "Zm8=", "Zm9v", "+/8="])("接纳标准字母表与合法尾部位 %s", (encoded) => {
  const result = decodeBase64Payload({ encoded, maxEncodedChars: encoded.length, maxBytes: 3 });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.bytes.toBase64()).toBe(encoded);
});

test("编码上限先于格式检查，解码字节上限独立判定", () => {
  expect(decodeBase64Payload({ encoded: "!AAA", maxEncodedChars: 3, maxBytes: 3 }))
    .toEqual({ ok: false, reason: "encoded payload exceeds the size limit" });
  expect(decodeBase64Payload({ encoded: "Zm9v", maxEncodedChars: 4, maxBytes: 2 }))
    .toEqual({ ok: false, reason: "decoded payload is empty or exceeds the size limit" });
  expect(decodeBase64Payload({ encoded: "Zm9v", maxEncodedChars: 4, maxBytes: 3 }).ok).toBe(true);
  expect(decodeBase64Payload({ encoded: "Zm9v", maxEncodedChars: 5, maxBytes: 4 }).ok).toBe(true);
  expect(decodeBase64Payload({ encoded: "", maxEncodedChars: 0, maxBytes: 0 }))
    .toEqual({ ok: false, reason: "empty payload" });
});
