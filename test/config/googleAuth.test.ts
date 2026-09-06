import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { parseGoogleServiceAccountKey } from "../../packages/config/googleAuth";
import type { GoogleServiceAccountKey } from "../../packages/types/config";

const privateKey: string = generateKeyPairSync("rsa", {
  modulusLength: 2_048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const minimal: Readonly<{ client_email: string; private_key: string }> = {
  client_email: "bot@example.iam.gserviceaccount.com",
  private_key: privateKey,
};
const source: string = "/fixture/g-auth.json";

test("最小凭据缺省 type，完整服务账号元数据均无损保留", (): void => {
  expect(parseGoogleServiceAccountKey(minimal, source)).toBe(minimal);
  const full: GoogleServiceAccountKey & Readonly<{ client_id: string; auth_uri: string }> = {
    ...minimal, type: "service_account", private_key_id: "key", project_id: "project",
    quota_project_id: "quota", universe_domain: "googleapis.com", client_id: "123", auth_uri: "https://accounts.google.com/o/oauth2/auth",
  };
  expect(parseGoogleServiceAccountKey(full, source)).toBe(full);
});

const assertReadonly = (): void => {
  const parsed: GoogleServiceAccountKey = parseGoogleServiceAccountKey(minimal, source);
  // @ts-expect-error 部署解析结果对调用方只读。
  parsed.private_key = "changed";
};
void assertReadonly;

for (const field of ["private_key_id", "project_id", "quota_project_id", "universe_domain"]) {
  for (const value of [null, false, 123, {}, [], "", "   "]) {
    test(`${field} 存在时严格校验类型与空值`, (): void => {
      expect((): GoogleServiceAccountKey => parseGoogleServiceAccountKey({ ...minimal, [field]: value }, source))
        .toThrow(`${source}: $.${field} must be a non-empty string.`);
    });
  }
}

test("错误只包含路径、字段与期望，不包含密钥或错误类型原值", (): void => {
  expect((): GoogleServiceAccountKey => parseGoogleServiceAccountKey({ ...minimal, type: "private_marker" }, source))
    .toThrow(`${source}: $.type must be "service_account".`);
  expect((): GoogleServiceAccountKey => parseGoogleServiceAccountKey({ ...minimal, private_key: "private_marker" }, source))
    .toThrow(`${source}: $.private_key must be a parseable non-empty PEM private key.`);
});
