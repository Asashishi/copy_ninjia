/** 回复文本过滤的完整键帽表情序列。 */
export const KEYCAP_SEQUENCE: RegExp = /[0-9#*]️?⃣/gu;

/** 回复文本表情序列中的修饰符、变体选择符与连接符字符集。 */
export const EMOJI_ATTACHMENT: string = "\\p{Emoji_Modifier}\\uFE0F\\u200D";

/** 回复文本区域指示符字符集，用于识别旗帜序列。 */
export const REGIONAL_INDICATOR: string = "\\p{Regional_Indicator}";
