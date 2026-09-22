/** 生成只供隔离测试使用的 RSA 服务账号文档，不读取任何部署凭据。 */
export async function googleAuthFixture(): Promise<string> {
  const key: CryptoKeyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2_048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const bytes: Uint8Array = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
  const pem: string = `-----BEGIN PRIVATE KEY-----\n${bytes.toBase64().match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ type: "service_account", client_email: "migration@example.invalid", private_key: pem, project_id: "migration-test" }, null, 2) + "\n";
}
