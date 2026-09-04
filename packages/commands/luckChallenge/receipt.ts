import type { MessageEntity } from "grammy/types";
import { luckCacheState, luckReceiptSecretState } from "../../cache/main/luckChallenge";
import {
  LUCK_RECEIPT_DISPLAY_PREFIX,
  LUCK_RECEIPT_LINK_PREFIX,
} from "../../consts/luckReceipt";
import {
  createLuckReceipt,
  luckReceiptHashFromLine,
  luckReceiptHmacHash,
  verifyLuckReceipt,
} from "../../libs/luckReceipt";
import { logger } from "../../infra/logger";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";
import type { SignedLuckResult } from "../../types/luckChallenge";
import { ensureLuckCacheFreshForToday, promotePendingDraw } from "./cache";

/** 正文直接展示回执的定长 HMAC；自描述签名回执放在同范围的 text_link 元数据中。 */
export function signLuckResultText(bodyText: string, cacheKey: string): SignedLuckResult {
  const secret: LuckReceiptSecret | null = luckReceiptSecretState.current;
  if (!secret) throw new Error("Daily luck receipt secret is not initialized");
  const receipt: string = createLuckReceipt(secret, cacheKey);
  const receiptHash: string | undefined = luckReceiptHmacHash(receipt);
  if (!receiptHash) throw new Error("Created an invalid luck receipt");
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
  const link: MessageEntity | undefined = entities?.find((entity: MessageEntity): boolean =>
    entity.type === "text_link" &&
    entity.offset === receiptOffset &&
    entity.length === receiptHash.length
  );
  if (link?.type !== "text_link" || !link.url.startsWith(LUCK_RECEIPT_LINK_PREFIX)) return undefined;
  const receipt: string = link.url.slice(LUCK_RECEIPT_LINK_PREFIX.length);
  return luckReceiptHmacHash(receipt) === receiptHash ? receipt : undefined;
}

/** 完成已通过同步格式校验的回执确认；只有真实候选回执才进入异步刷新。 */
async function confirmLuckReceipt(receipt: string): Promise<void> {
  try {
    await ensureLuckCacheFreshForToday();
  } catch (error: unknown) {
    logger.error("Failed to refresh luck cache while confirming a luck receipt:", error);
    return;
  }
  const secret: LuckReceiptSecret | null = luckReceiptSecretState.current;
  if (!secret) return;
  const cacheKey: string | undefined = verifyLuckReceipt(receipt, luckCacheState.dayKey, secret);
  if (!cacheKey) return;
  // 验签通过即证明该回执是用当天密钥签发的：即便进程内已跨过零点、pending
  // 已被清空，也允许用当天密钥重建派生（见 promotePendingDraw 的参数注释）。
  promotePendingDraw(cacheKey, true);
}

/**
 * 从消息末行与实体元数据验证 HMAC 回执，并把对应 pending 抽签转正。
 * 普通消息同步返回，不创建 Promise；只有携带完整候选回执时才进入异步刷新。
 */
export function confirmLuckDraw(
  messageText: string | undefined,
  entities?: readonly MessageEntity[]
): Promise<void> | undefined {
  if (typeof messageText !== "string") return;
  const lastLineBreak: number = messageText.lastIndexOf("\n");
  if (lastLineBreak < 0) return;
  // 只认当前格式：标签前缀 + 定长摘要，原回执由同范围的 text_link 实体携带。
  // 普通多行消息不能因此进入跨日密钥刷新与磁盘 Worker 往返。判定按偏移直接读
  // 原串，末行不是回执时连子串都不物化（见 libs/luckReceipt.ts 的头注）。
  const receiptHash: string | undefined = luckReceiptHashFromLine(
    messageText,
    lastLineBreak + 1
  );
  if (receiptHash === undefined) return;
  const receipt: string | undefined = receiptFromLinkEntity(
    receiptHash,
    lastLineBreak + 1 + LUCK_RECEIPT_DISPLAY_PREFIX.length,
    entities
  );
  if (!receipt) return;
  return confirmLuckReceipt(receipt);
}
