import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { LUCK_DAY_PATTERN, LUCK_RECEIPT_SECRET_PATTERN } from "../../consts/luckReceipt";
import { LUCK_RECEIPT_SECRET_PATH } from "../../consts/paths";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { atomicWriteTextSync } from "../../libs/atomicFile";
import { invalidInput, readJsonInput } from "../../libs/inputValidation";
import { isCanonicalDateKey } from "../../libs/time";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";

export interface LuckSecretFileIO {
  generateKey: () => Buffer;
  writeText: (path: string, content: string, mode: number) => void;
  chmod: (path: string, mode: number) => void;
}

const DEFAULT_IO: LuckSecretFileIO = {
  generateKey: (): Buffer => randomBytes(32),
  writeText: atomicWriteTextSync,
  chmod: chmodSync,
};

function decodeLuckReceiptSecret(value: unknown, path: string): LuckReceiptSecret {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain an object`);
  }
  const raw: Record<string, unknown> = value as Record<string, unknown>;
  const keys: string[] = Object.keys(raw).sort();
  if (keys.join(",") !== "day,key,version") throw new Error(`${path} has unknown or missing fields`);
  if (raw.version !== 1) throw new Error(`${path}.version must be 1`);
  if (
    typeof raw.day !== "string" ||
    !LUCK_DAY_PATTERN.test(raw.day) ||
    !isCanonicalDateKey(raw.day)
  ) throw new Error(`${path}.day is invalid`);
  if (typeof raw.key !== "string" || !LUCK_RECEIPT_SECRET_PATTERN.test(raw.key)) {
    throw new Error(`${path}.key is invalid`);
  }
  const decoded: Buffer = Buffer.from(raw.key, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== raw.key) {
    throw new Error(`${path}.key is not canonical base64url`);
  }
  return { version: 1, day: raw.day, key: raw.key };
}

function newSecret(day: string, path: string, io: LuckSecretFileIO): LuckReceiptSecret {
  const generated: Buffer = io.generateKey();
  if (generated.length !== 32) throw new Error("Luck receipt key generator must return exactly 32 bytes");
  const secret: LuckReceiptSecret = { version: 1, day, key: generated.toString("base64url") };
  io.writeText(path, `${JSON.stringify(secret, null, 2)}\n`, PERSISTED_FILE_MODE);
  return secret;
}

/** 恢复日级运势密钥所需的目标日期、已确认结果数与可替换 I/O。 */
export interface RecoverLuckReceiptSecretParams {
  day: string;
  confirmedResultCount: number;
  path?: string;
  io?: LuckSecretFileIO;
}

/**
 * 已有确认结果时，密钥缺失或属于旧日代表备份不一致。此时生成新密钥会让
 * 尚未确认的同日预览静默变化，必须保留现场并要求人工恢复一致备份。
 */
function assertSecretCanBeCreated(
  confirmedResultCount: number,
  path: string
): void {
  if (confirmedResultCount === 0) return;
  return invalidInput(path, "$", "present for the same day as the confirmed luck state");
}

/**
 * 加载当天密钥；仅在当天尚无确认结果时允许首次创建或从旧日原子轮换。
 * 损坏、未来日期、字段异常及“已有结果但密钥缺失/过期”一律拒绝，绝不
 * 静默覆盖导致当天尚未确认的预览结果改变。
 */
export function recoverLuckReceiptSecret(
  {
    day,
    confirmedResultCount,
    path = LUCK_RECEIPT_SECRET_PATH,
    io = DEFAULT_IO,
  }: RecoverLuckReceiptSecretParams
): LuckReceiptSecret {
  if (!LUCK_DAY_PATTERN.test(day) || !isCanonicalDateKey(day)) {
    throw new Error("Luck receipt target day must be a canonical YYYY-MM-DD date.");
  }
  if (!Number.isSafeInteger(confirmedResultCount) || confirmedResultCount < 0) {
    throw new Error(`Invalid confirmed luck result count for ${day}: ${confirmedResultCount}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    assertSecretCanBeCreated(confirmedResultCount, path);
    return newSecret(day, path, io);
  }
  if ((statSync(path).mode & 0o777) !== PERSISTED_FILE_MODE) io.chmod(path, PERSISTED_FILE_MODE);

  let secret: LuckReceiptSecret;
  try {
    secret = decodeLuckReceiptSecret(readJsonInput(path), path);
  } catch {
    return invalidInput(path, "$", "the current version=1 luck receipt secret schema");
  }
  if (secret.day > day) {
    return invalidInput(path, "$.day", "no later than the current Tokyo day");
  }
  if (secret.day < day) {
    assertSecretCanBeCreated(confirmedResultCount, path);
    return newSecret(day, path, io);
  }
  return secret;
}
