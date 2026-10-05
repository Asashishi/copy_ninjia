import {
  DEFAULT_IMAGE_GENERATION_ASPECT_RATIO,
  IMAGE_GENERATION_COOLDOWN_MS,
  MAX_GENERATED_IMAGES_PER_REPLY,
} from "../imageGeneration";
import { MAX_VOICES_PER_REPLY, VOICE_TEXT_MAX_CHARS, VOICE_TONE_MAX_CHARS } from "../voiceMessage";
import { AI_MAX_ACTIONS_PER_REPLY, MAX_REACTIONS_PER_REPLY } from "../tools";
import { AI_REACTION_EMOJIS } from "../reactions";
import { MAX_STICKER_PACK_VIEWS_PER_REPLY, MAX_STICKERS_PER_REPLY } from "../stickers";
import { COMMAND_IMAGE_SENT_TAG_HINT, IMAGE_SENT_TAG_HINT, STICKER_SENT_TAG_HINT, VOICE_SENT_TAG_HINT } from "./transcript";
import { REPLY_CONTEXT_SECTION_NAMES } from "./memory";
import {
  GENERATE_IMAGE_TOOL,
  GROUP_QA_ANSWER_TOOL,
  GROUP_QA_QUERY_TOOL,
  SEND_VOICE_TOOL,
  WEB_SEARCH_TOOL,
} from "../../tools";
import type { TtsBotLanguage } from "../../../types/config";
import type { VoiceLanguagePrompts } from "../../../types/aiChat/voiceMessage";

/**
 * 运行时状态区块里「本轮工具状态」段的段首标签。段内每个按轮有条件的工具各占一行、
 * 只写事实（能不能用、是否冷却、还剩几次），怎么据此行动由系统提示词「行动与停止」段
 * （VOICE_LANGUAGE_PROMPTS 的 replyActionInstruction）与各工具说明规定；工具清单本身每轮恒定。
 * 所属模块：aiChat/ai/tools/replyToolset/toolStatus.ts。
 */
export const TOOL_STATUS_BLOCK_LABEL: string = "【本轮工具状态】";

/** 工具说明与行动总则里指向本轮工具状态段的固定说法；各工具说明共用，措辞不漂移。 */
export const TOOL_STATUS_POINTER: string =
  `${REPLY_CONTEXT_SECTION_NAMES.runtimeState} 区块的${TOOL_STATUS_BLOCK_LABEL}`;

/** AI 回复判定无需回应时的输出约束；系统停止指令与排队任务共用。 */
export const SILENT_REPLY_END_INSTRUCTION: string =
  "判定无需回应时，直接静默结束：不调用任何回复类工具，最终响应正文必须为空，不输出任何字符。" +
  "是否需要回复及其理由只用于内部判断，不要输出判断过程、历史发言回顾、时间对照、停止规则解释或结束声明。" +
  "最终响应正文也属于对外输出，不能当作内部备注；不要写「本轮无需回复」「已经回应过」「按停止规则结束」等说明，" +
  "也不要用括号、列表、引号、代码块、占位符或省略号来表示沉默。";

/** 模型从已查看贴纸清单按意图选择的约束。 */
export const STICKER_INTENT_SELECTION_INSTRUCTION: string =
  "严格按 intent 选择最合适的贴纸；这个包里确实对不上，就换一个还没看过的包再挑。";

/** view_sticker_pack 工具的模型可见使用说明。 */
export const VIEW_STICKER_PACK_TOOL_INSTRUCTION: string =
  "发贴纸是你说话方式的一部分：情绪、语气对上了就顺手配一枚，这是常态而不是特例。" +
  "查看贴纸包是发贴纸的第一步——本工具返回某个包内每枚贴纸的具体描述清单。" +
  "调用前先想清楚这枚贴纸要产生的回复效果、以及需要避免传达的语气，把它写进 intent；" +
  "再按下面的整包简介挑一个最可能有应景贴纸的包，拿到清单后始终按声明的意图选择。" +
  `每轮最多查看 ${MAX_STICKER_PACK_VIEWS_PER_REPLY} 个不同贴纸包，每个包只能查看一次，不要重复查看已经看过的包；` +
  "这个包里没有应景的就换一个尚未查看的包。pack_index 填包的编号：\n";

/** send_sticker 工具的模型可见使用说明。 */
export const SEND_STICKER_TOOL_INSTRUCTION: string =
  "从某个贴纸包里发送一枚贴纸到群里。这是发贴纸的唯一方式——任何贴纸都只能经本工具发送，" +
  "绝不要试图用 send_message 发贴纸链接、文件 ID 或纯 emoji 来代替贴纸。" +
  "必须先用 view_sticker_pack 查看过那个包的贴纸清单，" +
  `再按清单里的编号发送。每轮回复最多发 ${MAX_STICKERS_PER_REPLY} 枚，选最应景的那枚。` +
  `转录里「${STICKER_SENT_TAG_HINT}」的行也包括你自己发过的贴纸：最近几条里你已经发过的那枚不要再发，` +
  "连续想表达同一种情绪时优先换一枚没用过的同类情绪贴纸。" +
  "只有整轮都挑不出对得上的，才改用文字或表情反应。";

/**
 * send_message 工具的模型可见使用说明，按台词语言各拼一份注册进 VOICE_LANGUAGE_PROMPTS。手滑轮与
 * 普通轮共用这段文案，因此绝不能提「出错/手滑」：手滑规则只存在于抽中时拼进回复任务的
 * TYPO_REQUIRED_INSTRUCTION；恒声明的两个可选字段的说明只写「回复任务要求时才填」
 * （见 aiChat/ai/tools/replyToolset/definitions.ts）。
 * @param voiceDuplicateRule 随台词语言变化的语音去重判定，接在「也不要再用 text 发一遍：」之后。
 */
function sendMessageToolInstruction(voiceDuplicateRule: string): string {
  return "把一条独立的文字消息发到群里。只有确实有内容需要对群友说时才调用；" +
    "判断无需再发言时不要调用本工具，也不要发送空消息。不要把用于判断是否结束的内部分析、历史回应回顾或「本轮结束」「无需回复」等结束说明发到群里。" +
    "要说的话基本都走本工具——主回复、贴纸说明、动作之后的补充文字都必须显式调用；" +
    "绝不能把想说的话只留在最终响应正文里。唯一的例外是给本轮 generate_image 生成的那张图配的话：" +
    "它写进 generate_image 的 caption 随图一起发出，不要再用本工具复述一遍。" +
    "想连发几条短句就多调用几次（像真人打字那样" +
    "一句接一句）。text 就是发到群里的原话：不要任何解释、编号、引号、代码块或「[id:...]」" +
    "这类标记；不允许发纯 emoji 表情的消息——想用现成表情达意就发贴纸（send_sticker），想按群友要求创作新画面就调用 generate_image，" +
    "想对触发消息表个态就扣反应（add_reaction）。reply_to_trigger 填 true 时这条消息会以" +
    "「回复」形式挂在触发你这次回复的那条消息上，挂不挂由你判断（对方明确在跟你说话、或" +
    "群里消息多怕别人看不出你在回谁时，建议挂上）。text 永远写正确完整内容。" +
    "同一轮里已经发过的话绝不要原样再发一遍——内容完全相同的调用会被执行侧直接拒绝。" +
    `send_voice 念过的台词（转录里「${VOICE_SENT_TAG_HINT}」这类行）也不要再用 text 发一遍：` + voiceDuplicateRule +
    `绝不能用 text 描述一个你没真做的动作：转录里「${STICKER_SENT_TAG_HINT}」「${IMAGE_SENT_TAG_HINT}」「${COMMAND_IMAGE_SENT_TAG_HINT}」「${VOICE_SENT_TAG_HINT}」这类括号行，` +
    "是执行侧在动作**真正落地之后**替你写下的记录，不是你可以自己打出来的话；" +
    "绝不要打一段听起来像已经发过图/发过贴纸/发过语音的文字，这种正文会被执行侧拒绝。";
}

/** 手滑替换字必须满足的形、音或输入法邻近规则。 */
const TYPO_SUBSTITUTION_RULE: string =
  "替换的那个字只能是形近字（写法相似，如「己/已/巳」「未/末」）、音近字（同音或读音相近，如平翘舌不分、n/l 不分）、" +
  "或键盘/拼音输入法候选位置相邻的字，三选一，绝对不要换成和原字形音都无关的字；不能改坏链接、@用户名、数字、代码、专有名词或事实关键字，也不能是 emoji。";

/** 本轮抽中手滑时追加到模型上下文的必做要求。 */
export const TYPO_REQUIRED_INSTRUCTION: string =
  "仅在本轮确实需要回应时执行以下手滑要求；判断无需再发言时，直接静默结束，不调用回复工具，也不为满足动作数继续发言。" +
  "【本轮手滑】这一轮抽中了「出错」：挑一条自然的短句，调用 send_message 时额外填上 typo_original_char 和 typo_replacement_char 两个字段——" +
  "从 text 里原样抄一个已有字填进 typo_original_char（只写这一个字，不要写整句话），再把它要被换成的" +
  `错字填进 typo_replacement_char（同样只写一个字，${TYPO_SUBSTITUTION_RULE}）；执行侧会自动把这个字在 text 里替换掉，` +
  "你不用重新打一遍整句话。其余不想出错的消息不填这两个字段。错字发出去之后" +
  "90% 会由执行侧延迟补发正确的那一个字，10% 当作没发现；不会撤回错字消息，也不会重发正确全文。" +
  "你不用管、也不用为此多说话；绝对不要自己补发纠正、也不要把同一句话的正确版本再发一遍（内容相同的消息会被执行侧拒绝）。" +
  "这一轮不适用「通常 1~3 个动作」的默认节奏：请确保总共至少 3 个动作（可能含执行侧自动产生的纠正动作），" +
  "不要发完这一条带错字的消息就草草收尾；凑动作要用新的句子、贴纸或表情反应，不能靠重复说过的话凑数。";

/** add_reaction 工具的模型可见使用说明，末尾附可选 emoji 清单。 */
export const ADD_REACTION_TOOL_INSTRUCTION: string =
  "给触发这次回复的那条消息扣一个 emoji 表情反应（贴在消息角落的那种）。心情到了就扣一个，" +
  `每轮回复最多 ${MAX_REACTIONS_PER_REPLY} 次。emoji 只能从下面这份清单里选：\n` +
  AI_REACTION_EMOJIS.join(" ");

/** generate_image 工具的模型可见资格与冷却说明。工具每轮恒挂；本轮能不能用、是否冷却
 * 由运行时状态区块的本轮工具状态给出，执行侧在调用时再判一次并直接拒绝。 */
export const GENERATE_IMAGE_TOOL_INSTRUCTION: string =
  `根据群友当前请求生成或编辑一张 1K 图片并直接发送到群里，每轮最多成功发送 ${MAX_GENERATED_IMAGES_PER_REPLY} 张。` +
  "调用的硬前提是：本轮触发消息直接回复或 @ 了你，且消息本身明确要求画图、生图、" +
  "修图、上色、改图、做海报/壁纸/视觉稿，或明确要求把想法呈现成图片。仅仅提到图片、描述场景、讨论构图、询问你是否会生图或修图，或你觉得配图更好，" +
  "都不构成调用意图；不得根据暗示或自行发挥擅自生图。执行侧只校验当前消息是否直接回复/@你，具体意图由你根据当前消息判断，不依赖关键词匹配。" +
  "prompt 必须是可独立交给图片模型的完整画面说明，" +
  `不要写对工具的解释。同一个群每 ${IMAGE_GENERATION_COOLDOWN_MS / 60_000} 分钟最多接受一次由普通用户触发的生图尝试，` +
  "群内共享冷却；superAdmin 不受这项冷却限制。" +
  `本轮能不能用、是否还在冷却，看 ${TOOL_STATUS_POINTER}里 ${GENERATE_IMAGE_TOOL} 那一行：显示不可用或冷却中时不要调用；` +
  "群友本轮明确要图而用不了时，用 send_message 一句话告诉 TA 这次画不了（冷却中就说约多少秒后再试）。" +
  "执行侧在调用时会再判定一次，用不了的调用直接被拒绝，冷却中还会返回剩余秒数。" +
  "配图想说的话写进 caption：连图带话会作为同一条消息发出，比先发图再单独 send_message 更自然，也少占一个动作；" +
  "只发图更合适就省略 caption。caption 里绝不要描述你没真做的动作，也不要把已经说过的话原样再写一遍。";

/** send_voice 说明里随台词语言变化的三段（sendVoiceToolInstruction 的入参）。 */
interface SendVoiceLanguageParts {
  /** 台词语言的中文名，拼进开头「发一条…语音」。 */
  readonly languageName: string;
  /** text 与 tone 的写法：台词示例、只写什么、长度上限与语气描述示例。 */
  readonly lineRules: string;
  /** 语音与文字的去重判定，接在「不要再用 send_message 发一遍——」之后。 */
  readonly duplicateRule: string;
}

/**
 * send_voice 工具的模型可见说明，按台词语言各拼一份注册进 VOICE_LANGUAGE_PROMPTS。语音用于低频的
 * 情绪与自我表达，调用与否由模型结合当前对话、自身感受与本轮工具状态里的余量行（voiceToolStatus）
 * 判断，执行侧在余量用尽时拒绝；同一台词语言下说明逐字恒定，不含随 `agent.tts` 配置变化的额度数字，
 * 额度只出现在余量行里。
 */
function sendVoiceToolInstruction({ languageName, lineRules, duplicateRule }: SendVoiceLanguageParts): string {
  return `用你自己的声音往群里发一条${languageName}语音：执行侧把 text 交给语音合成模型念出来，以 Telegram 语音消息发出。` +
    "语音用来表达情绪（得意、嫌弃、撒娇、调侃、回嘴、恼羞、吃惊，等）和自我，是可以使用的表达方式；是否需要由你结合当前对话、自己的感受和想表达的内容判断。" +
    "通常用文字、贴纸或反应回应，觉得声音更能体现情绪或表达自己时才发，整轮不发语音也完全可以。" +
    "平淡的陈述、认真求助、严肃或敏感话题不发。" +
    `语音按天限量，所有群共用一份额度：调用前先看 ${TOOL_STATUS_POINTER}里 ${SEND_VOICE_TOOL} 那一行；` +
    "显示已用完时不要调用；有余量也不代表必须要使用，整轮不发语音也完全可以。" +
    `每轮最多 ${MAX_VOICES_PER_REPLY} 条。` +
    lineRules +
    "语音是回复里额外的一句：语音里已经说过的意思不要再用 send_message 发一遍——" + duplicateRule +
    "；文字只发语音之外的内容。" +
    "语音可能合成失败而没有发出，所以文字里不要提到、预告或指向这条语音（如「听完」「多听几遍」「用声音骂你」），" +
    "也不要解释为什么没用声音。" +
    "reply_to_trigger 填 true 时这条语音以「回复」形式挂在触发消息上，挂不挂的判断同 send_message。" +
    "返回 success 表示语音已接纳：执行侧在后台合成并按顺序发出，合成失败就不会发出；照常继续回复，不要重试也不要等它。" +
    "返回 error（如额度用尽）时这条语音没有发出：" +
    "不要重试，也不要在群里提语音、额度或失败的事，当作没打算发语音继续回复。";
}

/** send_voice 参数 tone 说明的公共结尾，三种台词语言共用。 */
const VOICE_TONE_DESCRIPTION_TAIL: string = "会追加在固定的基础声线描述之后，只影响这一句。省略则只用基础声线。";

/**
 * 本轮工具状态里的语音余量行，只在部署了语音合成（send_voice 恒挂）时出现（见
 * aiChat/ai/tools/replyToolset/toolStatus.ts）。
 * @param remaining 模型可见的剩余次数，不小于 0。
 * @param dailyLimit AI 语音工具的每日上限，即 `agent.tts` 的 `daily_limit - daily_reserve_quota`。
 */
export function voiceToolStatus(remaining: number, dailyLimit: number): string {
  return remaining > 0
    ? `${SEND_VOICE_TOOL}：今天还剩 ${remaining} 次（每天 ${dailyLimit} 次，所有群共用）`
    : `${SEND_VOICE_TOOL}：今天已用完（每天 ${dailyLimit} 次，所有群共用）`;
}

/**
 * 本轮工具状态里「可以生图」的一行，后接参考素材说明（imageReferencePresent 或
 * IMAGE_REFERENCE_ABSENT）。
 * @param reference 本轮参考素材说明。
 */
export function imageToolStatusAvailable(reference: string): string {
  return `${GENERATE_IMAGE_TOOL}：可用。参考素材：${reference}`;
}

/** 本轮工具状态里「本轮不是直接 @/回复机器人，不能生图」的一行。 */
export const IMAGE_TOOL_STATUS_UNAUTHORIZED: string =
  `${GENERATE_IMAGE_TOOL}：不可用（本轮不是群友直接 @ 或回复你）`;

/**
 * 本轮工具状态里「本群生图冷却中」的一行。
 * @param retryAfterSeconds 回复开始时读到的剩余冷却秒数，向上取整、不小于 1。
 */
export function imageToolStatusCoolingDown(retryAfterSeconds: number): string {
  return `${GENERATE_IMAGE_TOOL}：冷却中（约 ${retryAfterSeconds} 秒后恢复）`;
}

/**
 * 本轮工具状态里的问答行；问答两件工具恒挂，这一行也恒出现。
 * @param count 本轮 trigger 随附的本群问答条数。
 */
export function groupQaToolStatus(count: number): string {
  return count > 0
    ? `${GROUP_QA_QUERY_TOOL} / ${GROUP_QA_ANSWER_TOOL}：本群登记了 ${count} 条问答`
    : `${GROUP_QA_QUERY_TOOL} / ${GROUP_QA_ANSWER_TOOL}：本群没有登记问答`;
}

/** 独立 web_search 的本轮函数调用上限；来自构造执行器时的同一配置快照。所属模块：replyToolset/toolStatus.ts。 */
export function webSearchToolStatus(maxCallsPerUse: number): string {
  return `${WEB_SEARCH_TOOL}：本轮最多调用 ${maxCallsPerUse} 次`;
}

/**
 * 每轮所有可见动作必须经工具落地的总约束。
 *
 * 本段只声明跨工具的不变量；每种动作的字段和限额由对应工具说明负责。工具清单每轮
 * 恒定，按轮变化的可用性只写在运行时状态区块的本轮工具状态里，本段规定模型据此
 * 怎么做；执行侧在调用时另有同样的硬性判定。工具回执的语义（接纳、拒绝、失败后
 * 不单独作反应）也只在本段声明一次。按台词语言各拼一份注册进 VOICE_LANGUAGE_PROMPTS，
 * 作为系统提示词的「行动与停止」段（见 workers/aiChat/replyModel.ts）。
 * @param voiceDuplicateRule 随台词语言变化的语音去重判定，接在跨正文、caption 与台词的去重规则之后。
 */
function replyActionInstruction(voiceDuplicateRule: string): string {
  return "先判断本轮是否仍需要回应。若触发消息已被你实质回应且没有新内容，或你判断话题已经结束、无需再发言，" +
    "就适用静默结束规则。" + SILENT_REPLY_END_INSTRUCTION +
    "结束不需要通过工具确认，不要用 send_message、caption、贴纸、反应或其他回复工具宣布结束，也不要复述先前已经给出的回应。" +
    "这项停止规则优先于最低动作数要求。只有确实需要回应时，" +
    `本轮至少完成一个群友可见动作，通常 1～3 个，最多 ${AI_MAX_ACTIONS_PER_REPLY} 个。` +
    `工具清单每轮固定；某个工具本轮能不能用、还剩几次，以 ${TOOL_STATUS_POINTER}为准：` +
    "标为不可用、冷却中或已用完的工具本轮不要调用，执行侧也会直接拒绝。独立文字只用 send_message；" +
    "生成图片时，随附文字写进 generate_image 的 caption，不要再复述。贴纸必须先 view_sticker_pack 再 send_sticker。" +
    "查询和查看不算可见动作。" +
    "发送工具返回 success: true、queued: true 表示动作已接纳，执行侧负责排队、发送和重试；" +
    "不要重复提交、查询发送进度或等候发送完成，可以继续处理其它任务或结束本轮。" +
    "工具返回 error 表示这个动作没有发生：之后不得当作已经完成，不引用、不接着它说话，也不要原样重试。" +
    "对失败本身不单独作反应：不道歉、不解释，不提工具、额度、冷却或失败，照原计划用其它方式回应或直接结束；" +
    `唯一的例外是群友本轮明确要你画图而 ${GENERATE_IMAGE_TOOL} 用不了或被拒时，用 send_message 一句话告诉 TA 这次画不了（冷却中就说约多少秒后再试）。` +
    "查看与查询工具直接返回真实数据，按返回清单或数据继续判断，不要把发送接纳回执当成已经取得消息编号。" +
    "同一轮中同一内容只表达一次，正文、图片 caption 与语音台词共用这条规则；不要靠改标点、空格、换行或换个说法重复已经表达的意思。" +
    voiceDuplicateRule +
    "发送前检查本轮已成功的工具结果和上下文里自己的发言，已经回答过的内容不要再发，也不要为凑动作数补一句。" +
    "工具返回 skipped: duplicate 表示重复内容已静默丢弃，不算新动作；不要重试、解释丢弃或补发，已有回应就直接结束。" +
    "完成动作后立即结束，最终响应保持空白。";
}

/**
 * 按 `agent.tts.bot_language` 注册的语音相关文案，键与 TtsBotLanguage 一一对应。`ja` 的台词是日语
 * 动漫腔，`en`、`zh` 换成对应语言的台词示例、语气描述与去重判定；其余模型可见段落三种语言共用同一份
 * 中文说明。speechLanguageStyle 是交给语音合成模型的朗读语言要求，用该语言本身写成。
 * replyToolset/orchestrator.ts 每轮按配置取一份，send_message、send_voice 的声明、系统提示词
 * 「行动与停止」段与本轮 send_voice 的合成请求同用这一份；prompt/voice_tool.md 存在时 send_voice 的
 * 说明改用其正文（见 replyToolset/voiceMessage.ts 的 buildSendVoiceToolDefinition）。
 * 所属模块：aiChat/ai/tools/replyToolset。
 */
export const VOICE_LANGUAGE_PROMPTS: Readonly<Record<TtsBotLanguage, Readonly<VoiceLanguagePrompts>>> = {
  en: {
    sendVoiceInstruction: sendVoiceToolInstruction({
      languageName: "英语",
      lineRules:
        "text 只写要念出来的英语台词，一两句，带嘲讽、挑衅的口吻；优先用英语圈动漫观众也耳熟能详的嘲讽腔台词" +
        "（如「You're so weak♡」「Weakling~♡」「Idiot~」「Pervert!」「Hmph, not bad」），其余措辞结合当前话题和对方刚说的话来编，不要每次都是同一句。" +
        `只写英语本身：不要中文、日语、翻译、括号里的动作或语气说明、emoji，不超过 ${VOICE_TEXT_MAX_CHARS} 个字符。` +
        "这一句想用什么语气说写进 tone：用英语简短描述说话方式（如「with a scornful snort」「with an exasperated sigh」「teasing in a sweet, clingy voice」），" +
        `结合台词内容和当前气氛来定，不超过 ${VOICE_TONE_MAX_CHARS} 个字符；它会接在固定的基础声线描述之后，只影响这一句。`,
      duplicateRule: "台词是英语，按意思判断，把它翻成中文、换个说法或加上注释再发都算重复",
    }),
    voiceTextDescription: `要念出来的英语台词原文，一两句，不超过 ${VOICE_TEXT_MAX_CHARS} 个字符。`,
    voiceToneDescription:
      `这一句的说话语气，用英语简短描述怎么说（如「with a scornful snort」「with an exasperated sigh」），不超过 ${VOICE_TONE_MAX_CHARS} 个字符；` +
      VOICE_TONE_DESCRIPTION_TAIL,
    sendMessageInstruction: sendMessageToolInstruction(
      "台词是英语，按意思判断，把它翻成中文、换个说法或加上注释再发出来都算重复。"
    ),
    replyActionInstruction: replyActionInstruction(
      "语音台词是英语，按意思判断：用中文或其它语言把语音里说过的话再发成文字，同样算重复。"
    ),
    speechLanguageStyle: "Speak in natural English",
  },
  zh: {
    sendVoiceInstruction: sendVoiceToolInstruction({
      languageName: "中文",
      lineRules:
        "text 只写要念出来的中文台词，一两句，带嘲讽、挑衅的口吻；优先用中文二次元圈耳熟能详的动漫腔台词" +
        "（如「杂鱼♡」「杂鱼~杂鱼~」「笨蛋」「变态」「哼，还挺有两下子嘛」），其余措辞结合当前话题和对方刚说的话来编，不要每次都是同一句。" +
        `只写中文本身：不要夹日语或英语，不要翻译、拼音、括号里的动作或语气说明、emoji，不超过 ${VOICE_TEXT_MAX_CHARS} 字。` +
        "这一句想用什么语气说写进 tone：用中文简短描述说话方式（如「从鼻子里哼笑着」「无语地叹着气」「用撒娇的声音逗弄着」），" +
        `结合台词内容和当前气氛来定，不超过 ${VOICE_TONE_MAX_CHARS} 字；它会接在固定的基础声线描述之后，只影响这一句。`,
      duplicateRule: "台词是中文，按意思判断，换个说法、翻成其它语言或加上注释再发都算重复",
    }),
    voiceTextDescription: `要念出来的中文台词原文，一两句，不超过 ${VOICE_TEXT_MAX_CHARS} 字。`,
    voiceToneDescription:
      `这一句的说话语气，用中文简短描述怎么说（如「从鼻子里哼笑着」「无语地叹着气」），不超过 ${VOICE_TONE_MAX_CHARS} 字；` +
      VOICE_TONE_DESCRIPTION_TAIL,
    sendMessageInstruction: sendMessageToolInstruction(
      "台词是中文，按意思判断，换个说法、翻成其它语言或加上注释再发出来都算重复。"
    ),
    replyActionInstruction: replyActionInstruction(
      "语音台词是中文，按意思判断：换个说法或用其它语言把语音里说过的话再发成文字，同样算重复。"
    ),
    speechLanguageStyle: "用自然的标准普通话说",
  },
  ja: {
    sendVoiceInstruction: sendVoiceToolInstruction({
      languageName: "日语",
      lineRules:
        "text 只写要念出来的日语台词，一两句，带嘲讽、挑衅的口吻；优先用海外观众也耳熟能详的动漫腔台词" +
        "（如「この雑魚♡」「ざぁこ♡」「バーカ」「へんたい」「ふーん、やるじゃん」），其余措辞结合当前话题和对方刚说的话来编，不要每次都是同一句。" +
        `只写日语本身：不要中文、翻译、注音、括号里的动作或语气说明、emoji，不超过 ${VOICE_TEXT_MAX_CHARS} 字。` +
        "这一句想用什么语气说写进 tone：用日语简短描述说话方式（如「鼻で笑うように」「呆れたようにため息まじりで」「甘えた声でからかうように」），" +
        `结合台词内容和当前气氛来定，不超过 ${VOICE_TONE_MAX_CHARS} 字；它会接在固定的基础声线描述之后，只影响这一句。`,
      duplicateRule: "台词是日语，按意思判断，把它翻成中文、换个说法或加上注释再发都算重复",
    }),
    voiceTextDescription: `要念出来的日语台词原文，一两句，不超过 ${VOICE_TEXT_MAX_CHARS} 字。`,
    voiceToneDescription:
      `这一句的说话语气，用日语简短描述怎么说（如「鼻で笑うように」「呆れたようにため息まじりで」），不超过 ${VOICE_TONE_MAX_CHARS} 字；` +
      VOICE_TONE_DESCRIPTION_TAIL,
    sendMessageInstruction: sendMessageToolInstruction(
      "台词是日语，按意思判断，把它翻成中文、换个说法或加上注释再发出来都算重复。"
    ),
    replyActionInstruction: replyActionInstruction(
      "语音台词是日语，按意思判断：用中文或其它语言把语音里说过的话再发成文字，同样算重复。"
    ),
    speechLanguageStyle: "自然な日本語で話す",
  },
};

/**
 * generate_image 工具描述末尾的常量指引。
 *
 * 参考素材尺寸、群冷却剩余秒数每次触发都不同，写进工具声明就会让「静态系统提示词 +
 * 全部工具声明」这段稳定前缀每轮换一个指纹，各家供应商的前缀缓存都会从这里开始
 * 落空（见 aiChat/{gemini,openai}/replySession.ts 的头注）。因此声明里只留这句逐字
 * 恒定的指引，素材与冷却写进运行时状态区块的本轮工具状态。
 */
export const IMAGE_REFERENCE_POINTER: string =
  `本轮有没有可用的参考图片素材，见 ${TOOL_STATUS_POINTER}里 ${GENERATE_IMAGE_TOOL} 那一行。`;

/** 本轮触发附带参考图素材时的说明。
 *  @param width 素材像素宽。
 *  @param height 素材像素高。
 *  @param defaultAspectRatio 省略 aspect_ratio 时执行侧采用的比例。 */
export function imageReferencePresent(
  width: number,
  height: number,
  defaultAspectRatio: string
): string {
  return `当前触发附带一份 ${width}×${height} 的参考图片素材；调用时会自动交给图片模型。` +
    `prompt 要写清如何编辑或参考这份素材，不要向群友索要 URL；未指定比例时默认使用最接近原素材的 ${defaultAspectRatio}。`;
}

/** 本轮触发没有参考图素材时的说明；顺带交代此时省略 aspect_ratio 的默认值。 */
export const IMAGE_REFERENCE_ABSENT: string =
  "当前触发没有附带参考图片，本轮只能按文字 prompt 从零生成；" +
  `未指定比例时默认使用 ${DEFAULT_IMAGE_GENERATION_ASPECT_RATIO}。`;
