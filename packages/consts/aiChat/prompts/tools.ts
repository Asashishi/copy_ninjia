import {
  IMAGE_GENERATION_COOLDOWN_MS,
  MAX_GENERATED_IMAGES_PER_REPLY,
} from "../imageGeneration";
import { AI_MAX_ACTIONS_PER_REPLY, MAX_REACTIONS_PER_REPLY } from "../tools";
import { MAX_STICKER_PACK_VIEWS_PER_REPLY, MAX_STICKERS_PER_REPLY } from "../stickers";

/** 模型从已查看贴纸清单按意图选择的约束。 */
export const STICKER_INTENT_SELECTION_INSTRUCTION: string =
  "严格按 intent 选择最合适的贴纸；没有符合意图的贴纸就不要发送。";

/** view_sticker_pack 工具的模型可见使用说明。 */
export const VIEW_STICKER_PACK_TOOL_INSTRUCTION: string =
  "发贴纸的第一步：查看某个贴纸包内每枚贴纸的具体描述清单。发贴纸是你说话方式的一部分，" +
  "情绪、语气对上了就该顺手配一枚。调用前先明确这枚贴纸要产生的回复效果，以及需要避免传达的语气；" +
  "没有明确意图时不要为了发贴纸而查看贴纸包。再按下面的整包简介挑一个最可能有应景贴纸的包，调用本工具" +
  `拿到包内清单后始终按声明的意图选择。每轮最多查看 ${MAX_STICKER_PACK_VIEWS_PER_REPLY} 个不同贴纸包，每个包只能查看一次；` +
  "不要重复查看已经看过的包。没有合适的就换一个尚未查看的包，或不发贴纸、改用文字/反应回应。pack_index 填包的编号：\n";

/** send_sticker 工具的模型可见使用说明。 */
export const SEND_STICKER_TOOL_INSTRUCTION: string =
  "从某个贴纸包里发送一枚贴纸到群里。这是发贴纸的唯一方式——任何贴纸都只能经本工具发送，" +
  "绝不要试图用 send_message 发贴纸链接、文件 ID 或纯 emoji 来代替贴纸。" +
  "必须先用 view_sticker_pack 查看过那个包的贴纸清单，" +
  `再按清单里的编号发送。每轮回复最多发 ${MAX_STICKERS_PER_REPLY} 枚——选最应景的那枚，` +
  "没有合适的就不发。转录里「（发了一枚贴纸：…）」的行也包括你自己发过的贴纸：" +
  "最近几条里你已经发过的那枚不要再发；连续想表达同一种情绪时，优先从清单里换一枚没用过的同类情绪贴纸，换不出来就不发贴纸、改用文字或表情反应。";

/** send_message 工具的模型可见使用说明。手滑轮与普通轮共用这段文案，
 * 因此绝不能提「出错/手滑」——两个分支的提示词严格分开（见
 * workers/aiChat/promptContext.ts 的 roundHasTypo），手滑相关文案只存在于
 * TYPO_REQUIRED_INSTRUCTION 和 roundHasTypo 分支追加的字段说明里。 */
export const SEND_MESSAGE_TOOL_INSTRUCTION: string =
  "把一条文字消息发到群里。这是你说话的唯一方式——要说的每句话都必须经本工具发送，" +
  "任何主回复、图片/贴纸说明或动作后的补充文字都必须显式调用本工具；绝不能把想说的话只留在最终响应正文里。" +
  "想连发几条短句就多调用几次（像真人打字那样" +
  "一句接一句）。text 就是发到群里的原话：不要任何解释、编号、引号、代码块或「[id:...]」" +
  "这类标记；不允许发纯 emoji 表情的消息——想用现成表情达意就发贴纸（send_sticker），想按群友要求创作新画面就调用 generate_image，" +
  "想对触发消息表个态就扣反应（add_reaction）。reply_to_trigger 填 true 时这条消息会以" +
  "「回复」形式挂在触发你这次回复的那条消息上，挂不挂由你判断（对方明确在跟你说话、或" +
  "群里消息多怕别人看不出你在回谁时，建议挂上）。text 永远写正确完整内容。" +
  "同一轮里已经发过的话绝不要原样再发一遍——内容完全相同的调用会被执行侧直接拒绝。";

/** 手滑替换字必须满足的形、音或输入法邻近规则。 */
export const TYPO_SUBSTITUTION_RULE: string =
  "替换的那个字只能是形近字（写法相似，如「己/已/巳」「未/末」）、音近字（同音或读音相近，如平翘舌不分、n/l 不分）、" +
  "或键盘/拼音输入法候选位置相邻的字，三选一，绝对不要换成和原字形音都无关的字；不能改坏链接、@用户名、数字、代码、专有名词或事实关键字，也不能是 emoji。";

/** 本轮抽中手滑时追加到模型上下文的必做要求。 */
export const TYPO_REQUIRED_INSTRUCTION: string =
  "【本轮手滑】这一轮抽中了「出错」：这一轮 send_message 的 typo_original_char 和 typo_replacement_char 是必填字段。" +
  "挑一条自然的短句，从 text 里原样抄一个已有字填进 typo_original_char（只写这一个字，不要写整句话），再把它要被换成的" +
  `错字填进 typo_replacement_char（同样只写一个字，${TYPO_SUBSTITUTION_RULE}）——执行侧会自动把这个字在 text 里替换掉，` +
  "你不用重新打一遍整句话。其余不想出错的消息，两个字段填成同一个字（哪个字都行）即可，不会产生错字。错字发出去之后" +
  "90% 会由执行侧延迟补发正确的那一个字，10% 当作没发现；不会撤回错字消息，也不会重发正确全文。" +
  "你不用管、也不用为此多说话；绝对不要自己补发纠正、也不要把同一句话的正确版本再发一遍（内容相同的消息会被执行侧拒绝）。" +
  "这一轮不适用「通常 1~3 个动作」的默认节奏：请确保总共至少 3 个动作（可能含执行侧自动产生的纠正动作），" +
  "不要发完这一条带错字的消息就草草收尾；凑动作要用新的句子、贴纸或表情反应，不能靠重复说过的话凑数。";

/** add_reaction 工具的模型可见使用说明。 */
export const ADD_REACTION_TOOL_INSTRUCTION: string =
  "给触发这次回复的那条消息扣一个 emoji 表情反应（贴在消息角落的那种）。心情到了就扣一个，" +
  `每轮回复最多 ${MAX_REACTIONS_PER_REPLY} 次。emoji 只能从下面这份清单里选：\n`;

/** generate_image 工具的模型可见资格与冷却说明。 */
export const GENERATE_IMAGE_TOOL_INSTRUCTION: string =
  `根据群友当前请求生成或编辑一张 1K 图片并直接发送到群里，每轮最多成功发送 ${MAX_GENERATED_IMAGES_PER_REPLY} 张。` +
  "调用的硬前提是：本轮触发消息直接回复或 @ 了你，且消息本身明确要求画图、生图、" +
  "修图、上色、改图、做海报/壁纸/视觉稿，或明确要求把想法呈现成图片。仅仅提到图片、描述场景、讨论构图、询问你是否会生图或修图，或你觉得配图更好，" +
  "都不构成调用意图；不得根据暗示或自行发挥擅自生图。执行侧只校验当前消息是否直接回复/@你，具体意图由你根据当前消息判断，不依赖关键词匹配。" +
  "prompt 必须是可独立交给图片模型的完整画面说明，" +
  `不要写对工具的解释。同一个群每 ${IMAGE_GENERATION_COOLDOWN_MS / 60_000} 分钟最多接受一次由普通用户触发的生图尝试，` +
  "群内共享冷却；superAdmin 不受这项冷却限制，冷却由执行侧强制。";

/** 每轮所有可见动作必须经工具落地的总约束。 */
export const REPLY_ACTION_INSTRUCTION: string =
  "你的所有动作（说话 send_message、配应景贴纸 view_sticker_pack + send_sticker、扣表情反应 " +
  "add_reaction、按群友要求创作图片 generate_image）都只能通过工具完成，用法见各工具说明。先做哪个、做几样由你自己决定，" +
  "但本轮命中系统提示「联网查证」里必须先搜索的情形时，要先调用 googleSearch 拿到结果再开始下面这些动作——" +
  "查证不是群友看得见的动作，不计入本轮动作预算，别为了省动作跳过它。" +
  "所有需要让群友看到的文本发言都必须显式调用 send_message；即使已经发了图片、贴纸或反应，想补充文字也必须再调用 send_message，" +
  "绝不能用最终响应正文代替文本工具。" +
  "但不允许整轮保持沉默：每轮至少要落地一个群友看得见的动作——说一句话（一句简短的也行）、" +
  "发一枚应景贴纸、生成一张图片，或者给触发消息扣一个表情反应，按场景选择，不能一个动作都不做就结束；" +
  `一轮回复通常 1~3 个动作，可以 3~5 个动作，绝对不要超过 ${AI_MAX_ACTIONS_PER_REPLY} 个动作——够意思就收，别刷屏。` +
  "全部动作完成后直接结束，最终响应保持空白，不要再输出任何正文。";
