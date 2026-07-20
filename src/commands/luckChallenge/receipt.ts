import type { MessageEntity } from "@grammyjs/types";
import { luckCacheState, luckReceiptSecretState } from "../../cache/luckChallenge";
import {
  LUCK_RECEIPT_DISPLAY_PREFIX,
  LUCK_RECEIPT_LINK_PREFIX,
} from "../../consts/luckReceipt";
import {
  createLuckReceipt,
  hashLuckReceipt,
  isLuckReceiptHash,
  unwrapLuckReceiptLine,
  verifyLuckReceipt,
} from "../../libs/luckReceipt";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";
import { ensureLuckCacheFreshForToday, promotePendingDraw } from "./cache";

export interface SignedLuckResult {
  text: string;
  receiptOffset: number;
  receiptLength: number;
  receiptUrl: string;
}

/** 正文只展示定长 SHA-256；自描述签名回执放在同范围的 text_link 元数据中。 */
export function signLuckResultText(bodyText: string, cacheKey: string): SignedLuckResult {
  const secret: LuckReceiptSecret | null = luckReceiptSecretState.current;
  if (!secret) throw new Error("Daily luck receipt secret is not initialized");
  const receipt: string = createLuckReceipt(secret, cacheKey);
  const receiptHash: string = hashLuckReceipt(receipt);
  const displayLine: string = `${LUCK_RECEIPT_DISPLAY_PREFIX}${receiptHash}`;
  return {
    text: `${bodyText}\n${displayLine}`,
    receiptOffset: bodyText.length + 1 + LUCK_RECEIPT_DISPLAY_PREFIX.length,
    receiptLength: receiptHash.length,
    receiptUrl: `${LUCK_RECEIPT_LINK_PREFIX}${receipt}`,
  };
}

function receiptFromLinkEntity(
  receiptHash: string,
  receiptOffset: number,
  entities: readonly MessageEntity[] | undefined
): string | undefined {
  const link: MessageEntity | undefined = entities?.find((entity) =>
    entity.type === "text_link" &&
    entity.offset === receiptOffset &&
    entity.length === receiptHash.length
  );
  if (link?.type !== "text_link" || !link.url.startsWith(LUCK_RECEIPT_LINK_PREFIX)) return undefined;
  const receipt: string = link.url.slice(LUCK_RECEIPT_LINK_PREFIX.length);
  return hashLuckReceipt(receipt) === receiptHash ? receipt : undefined;
}

/** 从消息末行与实体元数据验证 HMAC 回执，并把对应 pending 抽签转正。 */
export async function confirmLuckDraw(
  messageText: string | undefined,
  entities?: readonly MessageEntity[]
): Promise<void> {
  if (typeof messageText !== "string") return;
  await ensureLuckCacheFreshForToday();

  const lastLineBreak: number = messageText.lastIndexOf("\n");
  if (lastLineBreak < 0) return;
  const receiptLine: string = messageText.slice(lastLineBreak + 1);
  if (!receiptLine) return;
  const marker: string = unwrapLuckReceiptLine(receiptLine);
  let receipt: string | undefined;
  if (isLuckReceiptHash(marker)) {
    if (!receiptLine.startsWith(LUCK_RECEIPT_DISPLAY_PREFIX)) return;
    receipt = receiptFromLinkEntity(
      marker,
      lastLineBreak + 1 + LUCK_RECEIPT_DISPLAY_PREFIX.length,
      entities
    );
  } else {
    receipt = marker;
  }
  if (!receipt) return;
  const secret: LuckReceiptSecret | null = luckReceiptSecretState.current;
  if (!secret) return;
  const cacheKey: string | undefined = verifyLuckReceipt(receipt, luckCacheState.dayKey, secret);
  if (!cacheKey) return;
  // 验签通过即证明该回执是用当天密钥签发的：即便进程内已跨过零点、pending
  // 已被清空，也允许用当天密钥重建派生（见 promotePendingDraw 的参数注释）。
  promotePendingDraw(cacheKey, true);
}
