import { createPrivateKey } from "node:crypto";
import { GOOGLE_AUTH_FILE_PATH } from "../consts/paths";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { isPlainRecord } from "../libs/record";
import type { GoogleServiceAccountKey } from "../types/config";

/** SDK 消费的可选字符串字段，缺省不影响其它存在字段的严格校验。 */
function validateOptionalString(value: Record<string, unknown>, path: string, field: string): void {
  if (Object.hasOwn(value, field) &&
    (typeof value[field] !== "string" || value[field].trim().length === 0)) {
    invalidInput(path, `$.${field}`, "a non-empty string");
  }
}

/** 解析翻译 SDK 的服务账号凭据；只报告字段期望，不回显密钥或底层解析错误。 */
export function parseGoogleServiceAccountKey(
  value: unknown,
  path: string = GOOGLE_AUTH_FILE_PATH
): GoogleServiceAccountKey {
  if (!isPlainRecord(value)) invalidInput(path, "$", "a Google service account JSON object");
  if (Object.hasOwn(value, "type") && value.type !== "service_account") {
    invalidInput(path, "$.type", '"service_account"');
  }
  if (typeof value.client_email !== "string" || value.client_email.trim().length === 0) {
    invalidInput(path, "$.client_email", "a non-empty string");
  }
  if (typeof value.private_key !== "string" || value.private_key.trim().length === 0) {
    invalidInput(path, "$.private_key", "a parseable non-empty PEM private key");
  }
  try {
    createPrivateKey(value.private_key);
  } catch (_error: unknown) {
    invalidInput(path, "$.private_key", "a parseable non-empty PEM private key");
  }
  validateOptionalString(value, path, "private_key_id");
  validateOptionalString(value, path, "project_id");
  validateOptionalString(value, path, "quota_project_id");
  validateOptionalString(value, path, "universe_domain");
  return value as unknown as GoogleServiceAccountKey;
}

/** 启动阶段读取并严格解析服务账号文件；外部连接时序见 docs/cn/04-invariants.md。 */
export async function validateGoogleServiceAccountKey(
  path: string = GOOGLE_AUTH_FILE_PATH
): Promise<void> {
  parseGoogleServiceAccountKey(await readJsonInput(path), path);
}
