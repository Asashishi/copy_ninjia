import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { LUCK_RECEIPT_SECRET_PATH } from "../../consts/paths";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO";
import { atomicWriteTextSync } from "../../libs/atomicFile";
import type { LuckReceiptSecret } from "../../types";

const DAY_PATTERN: RegExp = /^\d{4}-\d{2}-\d{2}$/;
const SECRET_PATTERN: RegExp = /^[A-Za-z0-9_-]{43}$/;

export interface LuckSecretFileIO {
  generateKey: () => Buffer;
  writeText: (path: string, content: string, mode: number) => void;
  chmod: (path: string, mode: number) => void;
}

const DEFAULT_IO: LuckSecretFileIO = {
  generateKey: () => randomBytes(32),
  writeText: atomicWriteTextSync,
  chmod: chmodSync,
};

function decodeLuckReceiptSecret(value: unknown, path: string): LuckReceiptSecret {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain an object`);
  }
  const raw = value as Record<string, unknown>;
  const keys: string[] = Object.keys(raw).sort();
  if (keys.join(",") !== "day,key,version") throw new Error(`${path} has unknown or missing fields`);
  if (raw.version !== 1) throw new Error(`${path}.version must be 1`);
  if (typeof raw.day !== "string" || !DAY_PATTERN.test(raw.day)) throw new Error(`${path}.day is invalid`);
  if (typeof raw.key !== "string" || !SECRET_PATTERN.test(raw.key)) throw new Error(`${path}.key is invalid`);
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

/**
 * 加载当天密钥；不存在时首次创建，文件属于过去日期时原子轮换。损坏、未来
 * 日期或字段异常一律拒绝，绝不静默覆盖导致当天未确认结果改变。
 */
export function recoverLuckReceiptSecret(
  today: string,
  path: string = LUCK_RECEIPT_SECRET_PATH,
  io: LuckSecretFileIO = DEFAULT_IO
): LuckReceiptSecret {
  if (!DAY_PATTERN.test(today)) throw new Error(`Invalid Tokyo day for luck receipt secret: ${today}`);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) return newSecret(today, path, io);
  if ((statSync(path).mode & 0o777) !== PERSISTED_FILE_MODE) io.chmod(path, PERSISTED_FILE_MODE);

  let secret: LuckReceiptSecret;
  try {
    secret = decodeLuckReceiptSecret(JSON.parse(readFileSync(path, "utf8")), path);
  } catch (error: unknown) {
    throw new Error(`Luck receipt secret file is invalid; repair ${path} manually.`, { cause: error });
  }
  if (secret.day > today) {
    throw new Error(`Luck receipt secret file is from future day ${secret.day}; refusing to replace it for ${today}.`);
  }
  if (secret.day < today) return newSecret(today, path, io);
  return secret;
}
