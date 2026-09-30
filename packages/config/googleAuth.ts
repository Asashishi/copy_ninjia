import { createPrivateKey } from "node:crypto";
import { GOOGLE_AUTH_FILE_PATH } from "../consts/paths";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { isPlainRecord } from "../libs/record";
import type { GoogleServiceAccountKey } from "../types/config";

/**
 * SDK 消费的可选字符串字段：缺省不影响其它存在字段的严格校验；存在时按去掉首尾空白后
 * 非空校验，并把 key 里的值换成去空白后的值。
 */
function normalizeOptionalString(key: Record<string, unknown>, path: string, field: string): void {
  if (!Object.hasOwn(key, field)) return;
  const value: unknown = key[field];
  const text: string = typeof value === "string" ? value.trim() : "";
  if (text.length === 0) invalidInput(path, `$.${field}`, "a non-empty string");
  key[field] = text;
}

/**
 * 解析翻译 SDK 的服务账号凭据；已知字符串字段去掉首尾空白后校验并返回去空白后的值。
 * private_key 的首尾换行属于 PEM 格式本身，按原文交给 SDK；其余字段原样保留。只报告字段
 * 期望，不回显密钥或底层解析错误。
 */
export function parseGoogleServiceAccountKey(
  value: unknown,
  path: string = GOOGLE_AUTH_FILE_PATH
): GoogleServiceAccountKey {
  if (!isPlainRecord(value)) invalidInput(path, "$", "a Google service account JSON object");
  const key: Record<string, unknown> = { ...value };
  if (Object.hasOwn(key, "type")) {
    if (typeof key.type !== "string" || key.type.trim() !== "service_account") {
      invalidInput(path, "$.type", '"service_account"');
    }
    key.type = "service_account";
  }
  const clientEmail: string = typeof key.client_email === "string" ? key.client_email.trim() : "";
  if (clientEmail.length === 0) invalidInput(path, "$.client_email", "a non-empty string");
  key.client_email = clientEmail;
  if (typeof key.private_key !== "string" || key.private_key.trim().length === 0) {
    invalidInput(path, "$.private_key", "a parseable non-empty PEM private key");
  }
  let keyType: string | undefined;
  try {
    keyType = createPrivateKey(key.private_key).asymmetricKeyType;
  } catch (_error: unknown) {
    invalidInput(path, "$.private_key", "a parseable non-empty PEM private key");
  }
  if (keyType !== "rsa") invalidInput(path, "$.private_key", "an RSA PEM private key for RS256");
  normalizeOptionalString(key, path, "private_key_id");
  normalizeOptionalString(key, path, "project_id");
  normalizeOptionalString(key, path, "quota_project_id");
  normalizeOptionalString(key, path, "universe_domain");
  return key as unknown as GoogleServiceAccountKey;
}

/** 启动阶段读取并严格解析服务账号文件；外部连接时序见 docs/cn/04-invariants.md。 */
export async function validateGoogleServiceAccountKey(
  path: string = GOOGLE_AUTH_FILE_PATH
): Promise<GoogleServiceAccountKey> {
  return parseGoogleServiceAccountKey(await readJsonInput(path), path);
}
