import type { TranslateLanguage } from "../types/translate";
import type { CommandTargetMessages, ToggleCommandTexts } from "../types/commands";

/** 翻译模块每群的同时翻译人数上限；按可见身份 ID 去重，不淘汰活动目标。 */
export const TRANSLATE_CHAT_USER_LIMIT: number = 5;

/** 翻译模块的语言标签；命令回执和列表覆盖所有支持正则判断的方向。 */
export const TRANSLATE_LANGUAGE_LABELS: Readonly<Record<TranslateLanguage, string>> = {
  ja: "日语",
  cn: "简体中文",
  en: "美式英语",
  uk: "乌克兰语",
  ru: "俄语",
};

/** Google Translation 的目标代码；en 显式使用美国地区变体。 */
export const TRANSLATE_LANGUAGE_CODES: Readonly<Record<TranslateLanguage, string>> = {
  ja: "ja",
  cn: "zh-CN",
  en: "en-US",
  uk: "uk",
  ru: "ru",
};

/** /translate list 的 JSON 缩进；列表固定使用两空格。 */
export const TRANSLATE_LIST_JSON_INDENT: number = 2;

/** /translate list 的代码块语言；由 Telegram pre 实体标识 JSON。 */
export const TRANSLATE_LIST_JSON_LANGUAGE: string = "json";

/** Google Translation 支持地区变体的内置模型，供美式英语方向使用。 */
export const TRANSLATE_REGIONAL_MODEL: string = "general/translation-llm";

/** /translate 的参数结构；方向后只留目标参数给共享身份解析器校验。 */
export const TRANSLATE_ARGUMENT_PATTERN: RegExp = /^(ja|cn|en|uk|ru)(?:\s+([\s\S]+))?$/u;

/** /translate stop 的参数结构；可选用户名或 ID 交给共享目标解析器。 */
export const TRANSLATE_STOP_ARGUMENT_PATTERN: RegExp = /^stop(?:\s+([\s\S]+))?$/u;

/** 日语同语种判定需要假名证据；纯汉字不据此判为日语。 */
export const TRANSLATE_JAPANESE_EVIDENCE: RegExp = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** 日语同语种文本只接受汉字、假名及中性符号；混入其它文字仍请求翻译。 */
export const TRANSLATE_JAPANESE_TEXT: RegExp = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{N}\p{P}\p{S}\s\u200d\p{Variation_Selector}]+$/u;

/** 英语同语种判定需要 ASCII 字母证据。 */
export const TRANSLATE_ENGLISH_EVIDENCE: RegExp = /[A-Za-z]/u;

/** 英语同语种文本只接受 ASCII 字母及中性符号；非拉丁文字和重音字母不跳过翻译。 */
export const TRANSLATE_ENGLISH_TEXT: RegExp = /^[A-Za-z\p{N}\p{P}\p{S}\s\u200d\p{Variation_Selector}]+$/u;

/** 简体中文同语种判定需要汉字证据。 */
export const TRANSLATE_CHINESE_EVIDENCE: RegExp = /\p{Script=Han}/u;

/** 中文文字形态；简繁字形由 TRANSLATE_TRADITIONAL_HAN 另行判定。 */
export const TRANSLATE_CHINESE_TEXT: RegExp = /^[\p{Script=Han}\p{N}\p{P}\p{S}\s\u200d\p{Variation_Selector}]+$/u;

/** 乌克兰语同语种判定需要本语种字母证据；不把其它西里尔字母视为证据。 */
export const TRANSLATE_UKRAINIAN_EVIDENCE: RegExp = /[А-ЩЬЮЯЄІЇҐа-щьюяєіїґ]/u;

/** 乌克兰语文本只接受本语种字母、撇号及中性符号；排除俄语的 ё、ъ、ы、э。 */
export const TRANSLATE_UKRAINIAN_TEXT: RegExp = /^[А-ЩЬЮЯЄІЇҐа-щьюяєіїґ\u02bc\p{N}\p{P}\p{S}\s\u200d\p{Variation_Selector}]+$/u;

/** 俄语同语种判定需要本语种字母证据，包含大小写 Ё。 */
export const TRANSLATE_RUSSIAN_EVIDENCE: RegExp = /[А-Яа-яЁё]/u;

/** 俄语文本只接受本语种字母及中性符号；乌克兰语的 є、і、ї、ґ 仍需翻译。 */
export const TRANSLATE_RUSSIAN_TEXT: RegExp = /^[А-Яа-яЁё\p{N}\p{P}\p{S}\s\u200d\p{Variation_Selector}]+$/u;

/** 无字母或汉字的数字、标点和表情原样复制，不请求翻译。 */
export const TRANSLATE_NEUTRAL_TEXT: RegExp = /^[\p{N}\p{P}\p{S}\s\u200d\p{Variation_Selector}]*$/u;

/** /translate 参数错误统一提示；群内由 sendCommandMessage 清理。 */
export const TRANSLATE_USAGE_TEXT: string =
  `笨蛋，本天才只处理文字消息。回复目标后用 /translate ja|cn|en|uk|ru，或 /translate ja|cn|en|uk|ru @username；ja 日语，cn 简体中文，en 美式英语，uk 乌克兰语，ru 俄语。每群最多 ${TRANSLATE_CHAT_USER_LIMIT} 人，查看语言用 /translate list；直接用 /translate stop 停止全群，回复目标或用 /translate stop @username/id 停止单人，功能开关用 /translate enable|disable♡`;

/** 翻译会话容量已满时拒绝新增，既有会话不受影响。 */
export const TRANSLATE_CAPACITY_TEXT: string = "翻译群数已满啦，先在不用翻译的群 /translate stop，再来开启，笨蛋♡";

/** 本群翻译人数已满时拒绝新增；提示通过停止单人释放名额。 */
export const TRANSLATE_CHAT_CAPACITY_TEXT: string = `本群已经有 ${TRANSLATE_CHAT_USER_LIMIT} 个杂鱼等本天才翻译啦，回复目标用 /translate stop 腾个位置再来♡`;

/** `/translate stop` 不带目标时的全群停止回执；所属模块：翻译命令。 */
export const TRANSLATE_STOP_ALL_TEXT: string = "本群所有杂鱼的翻译都停止啦，需要时再来求本天才♡";

/** 本群翻译开关关闭时拒绝设置方向；所属模块：翻译命令。 */
export const TRANSLATE_DISABLED_TEXT: string =
  "本群翻译功能还没开启，找有翻译管理权限的人 /translate enable 一下吧♡";

/** /translate 开关文案；使用现有翻译功能授权，不占用 copy 冷却。 */
export const TRANSLATE_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (label: string): string => `就 ${label} 也想管本天才要不要翻译？没这项权限呀，笨蛋♡`,
  usage: TRANSLATE_USAGE_TEXT,
  enabled: "本天才已开启本群翻译，用 /translate ja|cn|en|uk|ru 选方向和目标吧♡",
  disabled: "本群翻译功能已关闭，杂鱼需要时再来开启♡",
  alreadyEnabled: "本群翻译功能本来就开着啦，用 /translate ja|cn|en|uk|ru 开始吧♡",
  alreadyDisabled: "本群翻译功能本来就关着啦，笨蛋♡",
};

/** /translate 的目标解析文案；目标冲突、自身目标和非法参数由共享解析边界拒绝。 */
export const TRANSLATE_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: TRANSLATE_USAGE_TEXT,
  invalidUsername: (argument: string): string => `笨蛋，${argument} 不是合法用户名。${TRANSLATE_USAGE_TEXT}`,
  unknownUsername: (username: string): string => `本天才还不认识 @${username}，先让 TA 发言，或回复 TA 的消息指定翻译目标♡`,
  conflictingTarget: (argument: string): string => `回复目标和 ${argument} 不一致，只留一个翻译目标，笨蛋♡`,
  selfTarget: "本天才不能把自己设成翻译目标呀，笨蛋♡",
};
