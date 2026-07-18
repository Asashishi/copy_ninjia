import { MAX_ACTIONS_PER_REPLY, MAX_REACTIONS_PER_REPLY } from "../tools";
import { MAX_STICKERS_PER_REPLY } from "../stickers";

export const STICKER_INTENT_SELECTION_INSTRUCTION: string =
  "严格按 intent 选择最合适的贴纸；没有符合意图的贴纸就不要发送。";

export const VIEW_STICKER_PACK_TOOL_INSTRUCTION: string =
  "发贴纸的第一步：查看某个贴纸包内每枚贴纸的具体描述清单。发贴纸是你说话方式的一部分，" +
  "情绪、语气对上了就该顺手配一枚。调用前先明确这枚贴纸要产生的回复效果，以及需要避免传达的语气；" +
  "没有明确意图时不要为了发贴纸而查看贴纸包。再按下面的整包简介挑一个最可能有应景贴纸的包，调用本工具" +
  "拿到包内清单后始终按声明的意图选择，没有合适的就不发。pack_index 填包的编号：\n";

export const SEND_STICKER_TOOL_INSTRUCTION: string =
  "从某个贴纸包里发送一枚贴纸到群里。必须先用 view_sticker_pack 查看过那个包的贴纸清单，" +
  `再按清单里的编号发送。每轮回复最多发 ${MAX_STICKERS_PER_REPLY} 枚——选最应景的那枚，` +
  "没有合适的就不发。";

export const SEND_MESSAGE_TOOL_INSTRUCTION: string =
  "把一条文字消息发到群里。这是你说话的唯一方式——要说的每句话都必须经本工具发送，" +
  "工具之外直接输出的正文不会被任何人看到。想连发几条短句就多调用几次（像真人打字那样" +
  "一句接一句）。text 就是发到群里的原话：不要任何解释、编号、引号、代码块或「[id:...]」" +
  "这类标记；不允许发纯 emoji 表情的消息——想用画面/表情达意就发贴纸（send_sticker），" +
  "想对触发消息表个态就扣反应（add_reaction）。reply_to_trigger 填 true 时这条消息会以" +
  "「回复」形式挂在触发你这次回复的那条消息上，挂不挂由你判断（对方明确在跟你说话、或" +
  "群里消息多怕别人看不出你在回谁时，建议挂上）。工具成功时会返回 message_id，之后若你发现" +
  "这条消息确实发错或多发了，只能用 delete_own_message 撤回这个 message_id。text 永远写正确完整内容。" +
  "同一轮里已经发过的话绝不要原样再发一遍——内容完全相同的调用会被执行侧直接拒绝；" +
  "错字的纠正/重发也都由执行侧自动完成，不需要你补发。";

export const DELETE_OWN_MESSAGE_TOOL_INSTRUCTION: string =
  "撤回你自己在本轮回复里刚刚用 send_message 发出的某一条文字消息。message_id 必须来自 " +
  "send_message 成功结果里返回的 message_id；不能删除别人的消息、触发消息、历史消息或贴纸。" +
  "只在你确实发错字、说错内容、或多发了一条时使用；具体撤回等待时间由执行侧自动控制，" +
  "不要为了等时间额外输出内容。撤回本身不算回应，撤回后如果还需要表达意思，" +
  "请重新用 send_message 发正确内容。";

export const TYPO_SUBSTITUTION_RULE: string =
  "替换的那个字只能是形近字（写法相似，如「己/已/巳」「未/末」）、音近字（同音或读音相近，如平翘舌不分、n/l 不分）、" +
  "或键盘/拼音输入法候选位置相邻的字，三选一，绝对不要换成和原字形音都无关的字；不能改坏链接、@用户名、数字、代码、专有名词或事实关键字，也不能是 emoji。";

export const TYPO_REQUIRED_INSTRUCTION: string =
  "【本轮手滑】这一轮抽中了「出错」：这一轮 send_message 的 typo_original_char 和 typo_replacement_char 是必填字段。" +
  "挑一条自然的短句，从 text 里原样抄一个已有字填进 typo_original_char（只写这一个字，不要写整句话），再把它要被换成的" +
  `错字填进 typo_replacement_char（同样只写一个字，${TYPO_SUBSTITUTION_RULE}）——执行侧会自动把这个字在 text 里替换掉，` +
  "你不用重新打一遍整句话。其余不想出错的消息，两个字段填成同一个字（哪个字都行）即可，不会产生错字。错字发出去之后" +
  "要不要纠正、怎么纠正、等多久，都由执行侧按概率自动处理（也可能假装没发现），你不用管、也不用为此多说话——" +
  "绝对不要自己补发纠正、也不要把同一句话的正确版本再发一遍（内容相同的消息会被执行侧拒绝）。这一轮请" +
  "确保总共至少 3-4 个动作（可能含执行侧自动产生的纠正动作），不要发完这一条带错字的消息就草草收尾；" +
  "凑动作要用新的句子、贴纸或表情反应，不能靠重复说过的话凑数。";

export const ADD_REACTION_TOOL_INSTRUCTION: string =
  "给触发这次回复的那条消息扣一个 emoji 表情反应（贴在消息角落的那种）。心情到了就扣一个，" +
  `每轮回复最多 ${MAX_REACTIONS_PER_REPLY} 次。emoji 只能从下面这份清单里选：\n`;

export const REPLY_ACTION_INSTRUCTION: string =
  "你的所有动作（说话 send_message、撤回自己本轮刚发错/多发的消息 delete_own_message、配应景贴纸 view_sticker_pack + send_sticker、扣表情反应 " +
  "add_reaction）都只能通过工具完成，用法见各工具说明。先做哪个、做几样由你自己决定，" +
  "但不允许整轮保持沉默：每轮至少要落地一个群友看得见的动作——说一句话（一句简短的也行）、" +
  "发一枚应景贴纸，或者给触发消息扣一个表情反应，三样任选，不能一个动作都不做就结束；" +
  "撤回消息只是修正错误，不算完成回应。" +
  `一轮回复通常 1~3 个动作，可以 3~5 个动作，绝对不要超过 ${MAX_ACTIONS_PER_REPLY} 个动作——够意思就收，别刷屏。` +
  "全部动作完成后直接结束，不要再输出任何正文。";
