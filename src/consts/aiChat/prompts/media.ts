import { IMAGE_DESCRIPTION_MAX_CHARS, SHORT_MEDIA_DESCRIPTION_MAX_CHARS } from "../media";
import { STICKER_PACK_SUMMARY_MAX_CHARS } from "../stickers";

function descriptionOutputRule(maxChars: number): string {
  return `不超过 ${maxChars} 字，只输出描述本身，不要任何前缀或解释，也不要用引号把整段描述包起来。`;
}

/** 图片视觉描述模型的固定任务提示。 */
export const IMAGE_DESCRIPTION_PROMPT: string =
  "这是中文群聊里有人发的一张图片。请用中文简要描述它：是什么内容、图里有什么文字、想表达什么；" +
  `若是表情包/梗图/截图，请点出梗点和情绪。${descriptionOutputRule(IMAGE_DESCRIPTION_MAX_CHARS)}`;

/** 贴纸视觉描述模型的固定任务提示。 */
export const STICKER_DESCRIPTION_PROMPT: string =
  "这是中文群聊场景用到的一枚贴纸（表情包）。请用中文描述它，最优先的任务是把画面里出现的文字" +
  "一字不差地原样抄录出来、放进「」里（中英文、品牌名、代码符号都照抄，不要改写、意译或省略——" +
  "文字是这类贴纸的灵魂，抄错一个字含义就变了；画面没有文字才可以不提）。" +
  "例外：若画面里是大段代码或长文，只原样抄录其中承载梗点的关键短句——优先抄中文的吐槽/标语/结论，" +
  "代码和英文报错本身不要抄，用一句话概括是什么（如「一段 Rust 借用检查报错的代码」）即可，" +
  "别让抄录挤掉画面描述。" +
  "抄录之后，再简述角色/形象是谁或什么、动作表情、整体想表达的情绪或语气。不要特意的描述为什么动漫什么游戏的人物, 正常描述特征即可" +
  descriptionOutputRule(SHORT_MEDIA_DESCRIPTION_MAX_CHARS);

/** GIF 首帧视觉描述模型的固定任务提示。 */
export const ANIMATION_DESCRIPTION_PROMPT: string =
  "这是中文群聊里发的一个动图（GIF）的封面帧画面（不是完整动图，只是第一帧）。请用中文简要描述这一帧看到的内容、" +
  `画面里的文字（如有）、大致想表达的情绪或梗。${descriptionOutputRule(SHORT_MEDIA_DESCRIPTION_MAX_CHARS)}`;

/** 根据逐枚描述生成整包贴纸导览的固定任务提示。 */
export const STICKER_PACK_SUMMARY_PROMPT: string =
  "以下是一个 Telegram 贴纸包里每枚贴纸的画面描述（每行一条，行首可能带这枚贴纸自带的情绪 emoji）。" +
  "请用中文为这一整个贴纸包写一段精准的导览简介，读者是要「按情绪/梗挑贴纸」的人，看完简介就能判断该不该进这个包找。必须具体写清：" +
  "主要角色/形象（叫得出名字就点名）；整体画风；包的核心梗或反复出现的文字句式（有固定模板就原样引用）；" +
  "涵盖哪些情绪和场景——用「嘲讽、得意、撒娇、无语……」这样的枚举尽量列全，不要泛泛说「多种情绪」。" +
  "不写空话套话（比如「适合日常聊天使用」这种没有区分度的话一律不要）。" +
  `必须写成一段连贯的话，严禁分点、换行或任何 Markdown 记号（*、**、#、- 等）。不超过 ${STICKER_PACK_SUMMARY_MAX_CHARS} 字——超字会被截断，请把角色、核心梗和情绪清单放在前半段说完。只输出简介本身，不要任何前缀或解释。`;
