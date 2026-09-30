import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LUCK_DAY_PATTERN, LUCK_RECEIPT_SECRET_PATTERN } from "../../consts/luckReceipt";
import { LUCK_RECEIPT_SECRET_PATH } from "../../consts/paths";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { atomicWriteTextSync } from "../../libs/atomicFile";
import { invalidInput, readJsonInput } from "../../libs/inputValidation";
import { inspectOptionalFile } from "../../libs/fileAccess";
import { hasExactKeys, isPlainRecord } from "../../libs/record";
import { isCanonicalDateKey } from "../../libs/time";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";

export interface LuckSecretFileIO {
  generateKey: () => Uint8Array;
  writeText: (path: string, content: string, mode: number) => void;
}

/** 用 Bun 支持的 Web Crypto CSPRNG 完整覆写 32 字节日级密钥。 */
function generateLuckReceiptKey(): Uint8Array {
  const key: Uint8Array = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

const DEFAULT_IO: LuckSecretFileIO = {
  generateKey: generateLuckReceiptKey,
  writeText: atomicWriteTextSync,
};

/** 严格解码 version=1 回执密钥；诊断按字段路径写明期望形态，不回显密钥。 */
function decodeLuckReceiptSecret(value: unknown, path: string): LuckReceiptSecret {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["version", "day", "key"])) {
    return invalidInput(path, "$", "exactly { version, day, key }");
  }
  if (value.version !== 1) return invalidInput(path, "$.version", "1");
  if (
    typeof value.day !== "string" ||
    !LUCK_DAY_PATTERN.test(value.day) ||
    !isCanonicalDateKey(value.day)
  ) return invalidInput(path, "$.day", "a canonical YYYY-MM-DD date");
  const expectedKey: string = "a canonical base64url encoding of 32 bytes";
  if (typeof value.key !== "string" || !LUCK_RECEIPT_SECRET_PATTERN.test(value.key)) {
    return invalidInput(path, "$.key", expectedKey);
  }
  const decoded: Uint8Array = Uint8Array.fromBase64(value.key, { alphabet: "base64url" });
  if (
    decoded.length !== 32 ||
    decoded.toBase64({ alphabet: "base64url", omitPadding: true }) !== value.key
  ) {
    return invalidInput(path, "$.key", expectedKey);
  }
  return { version: 1, day: value.day, key: value.key };
}

function newSecret(day: string, path: string, io: LuckSecretFileIO): LuckReceiptSecret {
  const generated: Uint8Array = io.generateKey();
  if (generated.length !== 32) throw new Error("Luck receipt key generator must return exactly 32 bytes");
  const secret: LuckReceiptSecret = {
    version: 1,
    day,
    key: generated.toBase64({ alphabet: "base64url", omitPadding: true }),
  };
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

export interface LuckSecretRecoveryInspection {
  readonly day: string;
  readonly path: string;
  readonly secret: LuckReceiptSecret | null;
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
export async function inspectLuckReceiptSecret(
  {
    day,
    confirmedResultCount,
    path = LUCK_RECEIPT_SECRET_PATH,
  }: RecoverLuckReceiptSecretParams
): Promise<LuckSecretRecoveryInspection> {
  if (!LUCK_DAY_PATTERN.test(day) || !isCanonicalDateKey(day)) {
    throw new Error("Luck receipt target day must be a canonical YYYY-MM-DD date.");
  }
  if (!Number.isSafeInteger(confirmedResultCount) || confirmedResultCount < 0) {
    throw new Error(`Invalid confirmed luck result count for ${day}: ${confirmedResultCount}`);
  }
  if (!inspectOptionalFile(path)) {
    assertSecretCanBeCreated(confirmedResultCount, path);
    return { day, path, secret: null };
  }

  const secret: LuckReceiptSecret = decodeLuckReceiptSecret(await readJsonInput(path), path);
  if (secret.day > day) {
    return invalidInput(path, "$.day", "no later than the current Tokyo day");
  }
  if (secret.day < day) {
    assertSecretCanBeCreated(confirmedResultCount, path);
    return { day, path, secret: null };
  }
  return { day, path, secret };
}

/** 全域严格 inspect 成功后接管已有密钥，或按首次创建语义生成当天密钥。 */
export function adoptLuckReceiptSecret(
  inspection: LuckSecretRecoveryInspection,
  io: LuckSecretFileIO = DEFAULT_IO
): LuckReceiptSecret {
  if (inspection.secret !== null) return inspection.secret;
  mkdirSync(dirname(inspection.path), { recursive: true });
  return newSecret(inspection.day, inspection.path, io);
}

/** 单领域恢复入口；跨域启动编排使用 inspect/adopt 两阶段 API。 */
export async function recoverLuckReceiptSecret(
  params: RecoverLuckReceiptSecretParams
): Promise<LuckReceiptSecret> {
  return adoptLuckReceiptSecret(
    await inspectLuckReceiptSecret(params),
    params.io ?? DEFAULT_IO
  );
}
