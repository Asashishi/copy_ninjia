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

test("可解析的 EC 与 Ed25519 密钥不满足 RS256", (): void => {
  const keys = [
    generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey,
    generateKeyPairSync("ed25519").privateKey,
  ];
  for (const key of keys) {
    const pem: string = key.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => parseGoogleServiceAccountKey({ ...minimal, private_key: pem }, source))
      .toThrow(`${source}: $.private_key must be an RSA PEM private key for RS256.`);
  }
});

test("RSA-PSS 算法标识的 PEM 不作为 RS256 凭据接受", (): void => {
  const der: Buffer = Buffer.from(privateKey.replace(/-----[^-]+-----|\s/gu, ""), "base64");
  const rsaOid: Buffer = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
  const offset: number = der.indexOf(rsaOid);
  expect(offset).toBeGreaterThan(0);
  // 相同 RSA 私钥材料使用 id-RSASSA-PSS 算法标识；Bun 不支持时在解析阶段拒绝。
  der[offset + rsaOid.length - 1] = 0x0a;
  const pem: string = `-----BEGIN PRIVATE KEY-----\n${der.toString("base64")}\n-----END PRIVATE KEY-----`;
  expect(() => parseGoogleServiceAccountKey({ ...minimal, private_key: pem }, source)).toThrow(`${source}: $.private_key must be`);
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
