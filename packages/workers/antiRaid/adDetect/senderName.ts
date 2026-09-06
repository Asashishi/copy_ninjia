import { AD_DETECT_SENDER_NAME_MAX_CHARS } from "../../../consts/antiRaid/adDetect";
import { sanitizeInline, truncateInline } from "../../../libs/text";
import type { TelegramIdentityMetadata } from "../../../types/identityPolicy";

/** 从现有候选元数据取得当次姓名；只生成送检数据，不读取 owner 或查询 Telegram。 */
export function formatAdSenderName(meta: Readonly<TelegramIdentityMetadata>): string {
  const firstName: string = truncateInline(sanitizeInline(meta.firstName), AD_DETECT_SENDER_NAME_MAX_CHARS);
  const lastName: string = truncateInline(sanitizeInline(meta.lastName), AD_DETECT_SENDER_NAME_MAX_CHARS);
  if (firstName.length === 0) return lastName;
  return lastName.length === 0 ? firstName : `${firstName} ${lastName}`;
}
