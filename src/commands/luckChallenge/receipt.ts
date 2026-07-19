import { luckCacheState, luckReceiptSecretState } from "../../cache/luckChallenge";
import {
  createLuckReceipt,
  LUCK_RECEIPT_DISPLAY_PREFIX,
  unwrapLuckReceiptLine,
  verifyLuckReceipt,
} from "../../libs/luckReceipt";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";
import { ensureLuckCacheFreshForToday, promotePendingDraw } from "./cache";

export interface SignedLuckResult {
  text: string;
  receiptOffset: number;
  receiptLength: number;
}

/** 在正文末尾附加可见「防伪标记: 」与 spoiler 协议载荷。 */
export function signLuckResultText(bodyText: string, cacheKey: string): SignedLuckResult {
  const secret: LuckReceiptSecret | null = luckReceiptSecretState.current;
  if (!secret) throw new Error("Daily luck receipt secret is not initialized");
  const receipt: string = createLuckReceipt(secret, cacheKey);
  const displayLine: string = `${LUCK_RECEIPT_DISPLAY_PREFIX}${receipt}`;
  return {
    text: `${bodyText}\n${displayLine}`,
    receiptOffset: bodyText.length + 1 + LUCK_RECEIPT_DISPLAY_PREFIX.length,
    receiptLength: receipt.length,
  };
}

/** 从消息末行验证自描述 HMAC 回执并把对应 pending 抽签转正。 */
export async function confirmLuckDraw(messageText: string | undefined): Promise<void> {
  if (typeof messageText !== "string") return;
  await ensureLuckCacheFreshForToday();

  const receiptLine: string | undefined = messageText.split("\n").at(-1);
  if (!receiptLine) return;
  const receipt: string = unwrapLuckReceiptLine(receiptLine);
  const secret: LuckReceiptSecret | null = luckReceiptSecretState.current;
  if (!secret) return;
  const cacheKey: string | undefined = verifyLuckReceipt(receipt, luckCacheState.dayKey, secret);
  if (!cacheKey) return;
  // 验签通过即证明该回执是用当天密钥签发的：即便进程内已跨过零点、pending
  // 已被清空，也允许用当天密钥重建派生（见 promotePendingDraw 的参数注释）。
  promotePendingDraw(cacheKey, true);
}
