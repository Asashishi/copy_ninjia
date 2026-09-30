import { AD_DETECT_SENDER_NAME_MAX_CHARS } from "../../../consts/antiRaid/adDetect";
import { sanitizeInline, truncateInline } from "../../../libs/text";
import type { TelegramIdentityMetadata } from "../../../types/identityPolicy";

/**
 * 从候选消息自带的 firstName、lastName 生成送检姓名（调用方直接传 AdCandidateMessage）；
 * 纯函数，不读缓存，不查询 Telegram。
 */
export function formatAdSenderName(
  meta: Readonly<Pick<TelegramIdentityMetadata, "firstName" | "lastName">>
): string {
  const firstName: string = truncateInline(sanitizeInline(meta.firstName), AD_DETECT_SENDER_NAME_MAX_CHARS);
  const lastName: string = truncateInline(sanitizeInline(meta.lastName), AD_DETECT_SENDER_NAME_MAX_CHARS);
  if (firstName.length === 0) return lastName;
  return lastName.length === 0 ? firstName : `${firstName} ${lastName}`;
}
