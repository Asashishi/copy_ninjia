import type { BotCommand } from "grammy/types";
import type { CommandTargetMessages, ToggleCommandTexts } from "../../../types/commands";
import { CHAT_QA_MAX_PER_CHAT } from "../../qa";
import { STATE_MANAGED_CHAT_LIMIT } from "../../storage";
import { TRANSLATE_CHAT_USER_LIMIT } from "../../translate";

/** Telegram 聊天框展示的命令菜单。 */
export const BOT_COMMANDS: readonly Readonly<BotCommand>[] = [
  { command: "copy", description: "让本天才复读；reverse 倒序 / nya 加喵~ / stop 停止，回复 TA 或加 @username 指定目标，连这都要点菜单吗，杂鱼♡" },
  { command: "translate", description: `ja 日语 / cn 简体中文 / en 美式英语 / uk 乌克兰语 / ru 俄语；回复目标或加 @username，每群最多 ${TRANSLATE_CHAT_USER_LIMIT} 人，list 看清单，stop 停全群、加目标停单人，enable/disable 开关功能，杂鱼看好参数♡` },
  { command: "icon", description: "用 steal 偷目标头像，回复 TA 或加 @username；reset 换回本天才原装脸，连自己的头像都拿不出手吗，杂鱼♡" },
  { command: "wed", description: "让本天才随机抽取群友老婆；支持确认、换一只和移除，再发 /wed 可重抽♡" },
  // Telegram 菜单只接受英文命令名；/x 展示中文动作的用法并终止分派，不进入消息兜底。
  { command: "x", description: "把 x 换成任意 1~2 个中文字直接发，如 /咬、/贴贴；回复 TA 或加 @username 指定目标，笨蛋♡" },
  { command: "block", description: "把目标写进永久黑名单并在所有托管群封禁，之后再进群也秒踢；支持回复、@username 或用户 id，仅持有 isCanBlock 的身份配用，杂鱼别乱碰♡" },
  { command: "unblock", description: "把目标移出永久黑名单并解除所有托管群封禁；支持回复、@username、用户 id 或频道负数 id，仅持有 isCanUnBlock 的身份配用，笨蛋♡" },
  { command: "prompt", description: "用 config/remove 配置或移除本天才在本群的 AI 提示词；需要 isCanConfigAiPrompt，杂鱼别乱改♡" },
  { command: "ai_chat", description: "用 enable/disable 开关本群 AI 闲聊，只有获授权者配使唤本天才，杂鱼别乱按♡" },
  { command: "clear_context", description: "把本天才在这个群攒下的 AI 上下文记忆全忘光，内存里的和存档里的一起清，之后从零重新记；不带参数，只有超级管理员配下这种命令，杂鱼别乱按♡" },
  { command: "ad_detect", description: "用 enable/disable 开关本群广告检测；命中就拉黑并全群封禁删消息，只有获授权者配碰，杂鱼♡" },
  { command: "flood_control", description: "用 enable/disable 开关本群防刷屏禁言，只有获授权者配碰，刷屏杂鱼可别手抖哦♡" },
  { command: "antiraid", description: "用 enable/disable 开关本群入群验证与防冲群私密模式，只有获授权者配碰，关掉就没人替你拦僵尸了哦杂鱼♡" },
  { command: "bot_status", description: "查看本机进程、全局模型能力、Telegram 出站、本群权限、提示词配置与已开启功能，连本天才会什么都记不住吗，笨蛋♡" },
  { command: "mood", description: "query 偷看本群 AI 当前心情，群成员都能问；switch 重抽心情，只有获授权者配左右本天才，杂鱼别得意♡" },
  { command: "init", description: "用 enable/disable 开关本群机器人监听/初始化，只有超级管理员配决定本天才管不管，杂鱼♡" },
  { command: "quiet", description: "让本天才安静 1~15 分钟，默认 3 分钟；嫌吵就自己说清楚呀，笨蛋♡" },
  { command: "unquiet", description: "提前解除 /quiet，让本天才重新开口；这么快就想我了吗，杂鱼♡" },
  { command: "mute", description: "禁言目标一段时间，时长必填如 10m/2h/1d（1 分钟~365 天，到点恢复）；支持回复、@username 或用户 id，仅持有 isCanMute 的身份配用，杂鱼♡" },
  { command: "unmute", description: "提前解除目标禁言；支持回复、@username 或用户 id，仅持有 isCanUnMute 的身份配用，连等到期都做不到吗，杂鱼♡" },
  { command: "gag", description: "限制用户或频道的文字发言 5/10/15 分钟，默认 5 分钟，按群内入口提示发言；回复目标、@username 或身份 id 指定目标，需要 isCanGag，杂鱼♡" },
  { command: "ungag", description: "定向解除目标 gag；必须回复、写 @username 或用户/频道 id，同样需要 isCanGag，笨蛋♡" },
  { command: "batch_kick", description: "踢出本群滚动时间窗内加入的人，如 30m/2h/1d；只踢不拉黑，仅超级管理员配用，杂鱼围观就好♡" },
  { command: "permission", description: "用 help 看说明、query 查权限，所有杂鱼都能用；修改权限仅限超级管理员，杂鱼别乱碰♡" },
  { command: "qa", description: `set 开表单登记问答（最多 ${CHAT_QA_MAX_PER_CHAT} 条），remove <问题> 删除，均需 isCanControllQaPermission；query [问题] 查一条或全部，群成员都能看，杂鱼♡` },
  { command: "white", description: "新增或删除白名单用户/频道；isCanWhiteOther 只能代加默认权限，删除仍只有超级管理员配碰，杂鱼别乱伸手♡" },
];

/** 黑白名单冷读失败、本次命令放弃执行时的提示。 */
export const IDENTITY_POLICY_UNAVAILABLE_TEXT: string = "呜……黑白名单暂时读不出来，本次一个人都没动，稍后再试吧♡";

/** 权限看板读取失败时的临时提示。 */
export const IDENTITY_POLICY_QUERY_UNAVAILABLE_TEXT: string = "呜……权限暂时读不出来，稍后再查吧♡";

/** `/ai_chat enable|disable` 的全部文案。 */
export const AI_CHAT_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (mockerLabel: string): string =>
    `就 ${mockerLabel} 也想管本天才要不要闲聊？哪来的资格呀，笨蛋♡`,
  usage: `笨蛋，要 /ai_chat enable 还是 /ai_chat disable，说清楚呀♡`,
  enabled: `哼，那本天才就赏脸在这个群闲聊几句吧，杂鱼们好好珍惜♡`,
  disabled: `本天才不想再理你们这群杂鱼了，闲聊到此为止♡`,
  alreadyEnabled: `笨蛋，本天才本来就在这个群陪你们闲聊呀，还要本天才答应几次？♡`,
  alreadyDisabled: `本天才本来就没在这个群闲聊呀，笨蛋要关什么呢♡`,
};

/** `/ad_detect enable|disable` 的全部文案。 */
export const AD_DETECT_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (mockerLabel: string): string =>
    `就 ${mockerLabel} 也想管本天才抓不抓广告？哪来的资格呀，笨蛋♡`,
  usage: `笨蛋，要 /ad_detect enable 还是 /ad_detect disable，说清楚呀♡`,
  enabled: `哼，本天才这就盯着这个群的广告，敢发的杂鱼一个都别想留下♡`,
  disabled: `不抓广告了，随便你们刷吧，本天才可懒得管♡`,
  alreadyEnabled: `笨蛋，本天才本来就盯着这个群的广告呢，还要本天才多长几只眼睛吗？♡`,
  alreadyDisabled: `本天才本来就没在抓这个群的广告呀，笨蛋要关什么呢♡`,
};

/** `/flood_control enable|disable` 的全部文案。 */
export const FLOOD_CONTROL_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (mockerLabel: string): string =>
    `就 ${mockerLabel} 也想管本天才抓不抓刷屏？哪来的资格呀，笨蛋♡`,
  usage: `笨蛋，要 /flood_control enable 还是 /flood_control disable，说清楚呀♡`,
  enabled: `哼，本天才开始盯着这个群的刷屏杂鱼了，刷太快就等着被按住吧♡`,
  disabled: `防刷屏关掉了，随便你们吵吧，本天才懒得管♡`,
  alreadyEnabled: `笨蛋，本天才本来就盯着这个群的刷屏杂鱼呢，急什么呀♡`,
  alreadyDisabled: `防刷屏本来就是关着的呀，笨蛋要关几次才甘心♡`,
};

/** `/antiraid enable|disable` 的全部文案。 */
export const ANTI_RAID_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (mockerLabel: string): string =>
    `就 ${mockerLabel} 也配决定本天才守不守门？哪来的资格呀，笨蛋♡`,
  usage: `笨蛋，要 /antiraid enable 还是 /antiraid disable，说清楚呀♡`,
  enabled: `哼，本天才开始守门了：新来的杂鱼要按按钮验证，冲群的僵尸也别想混进来♡`,
  disabled: `入群验证和防冲群都关掉了，谁都能大摇大摆走进来，出事可别哭着找本天才♡`,
  alreadyEnabled: `笨蛋，本天才本来就守着这个群的门呢，急什么呀♡`,
  alreadyDisabled: `本来就没在守门呀，笨蛋要关几次才甘心♡`,
};

/** `/antiraid disable` 落盘成功、但 Worker 侧运行态没拆干净时的回执。 */
export const ANTI_RAID_DISABLE_TEARDOWN_FAILED_TEXT: string =
  `守门是不守了——不过本天才的守门小弟这会儿不在，已经开着的验证窗口和私密模式` +
  `没能当场收掉，日志里写着呢，杂鱼管理员待会儿再关一次♡`;

/** `/init enable|disable` 的全部文案。 */
export const INIT_TOGGLE_TEXTS: Readonly<ToggleCommandTexts> = {
  rejection: (mockerLabel: string): string =>
    `就 ${mockerLabel} 也想让本天才在这个群干活？哪来的资格呀，笨蛋♡`,
  usage: `笨蛋，要 /init enable 还是 /init disable，说清楚呀♡`,
  enabled: `哼，那本天才就大发慈悲开始搭理这个群了，杂鱼们好好珍惜♡`,
  disabled: `本天才不想再理这个群了，爱干嘛干嘛去吧♡`,
  alreadyEnabled: `笨蛋，本天才本来就在搭理这个群呀，还要本天才答应几次？♡`,
  alreadyDisabled: `本天才本来就没在理这个群呀，笨蛋要关什么呢♡`,
};

/** `/init disable` 已经落盘、但拆运行态失败时的回执。 */
export const INIT_DISABLE_TEARDOWN_FAILED_TEXT: string =
  `本天才不想再理这个群了，爱干嘛干嘛去吧——不过有几样运行态没能拆干净，` +
  `日志里写着呢，杂鱼管理员去看一眼♡`;

/** `/init enable` 在 State 已达群数上限时的拒绝提示。 */
export const INIT_CHAT_LIMIT_TEXT: string =
  `State 最多只能管理 ${STATE_MANAGED_CHAT_LIMIT} 个群，现在已经满了。` +
  `去不再需要的那个群 /init disable，或者把本天才移出那个群，那一格就腾出来了，再回来启用本群。` +
  `只有仍在私密模式里的群腾不出来——那条记录要留到邀请权限恢复为止。`;

/** `/block` 的目标解析提示。 */
export const BLOCK_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: `笨蛋，要么 /block @username 或 /block 用户id，要么回复 TA 的一条消息再 /block，本天才可不会读心术♡`,
  invalidUsername: (rawArgument: string): string => `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是用户 id（得是正整数，群和频道那种负数 id 不算），别拿半截参数糊弄本天才♡`,
  unknownUsername: (rawUsername: string): string => `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息来 /block 吧♡`,
  conflictingTarget: (rawArgument: string): string => `笨蛋，你回复了一条消息、又写了 ${rawArgument}，这是两个目标呀；封人这事本天才可不猜——想封谁就只留一个，要么删掉参数、要么别回复♡`,
  selfTarget: `笨蛋，本天才才不会把自己拉黑呢♡`,
};

/** `/unblock` 的目标解析提示。 */
export const UNBLOCK_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: `笨蛋，要么 /unblock @username 或 /unblock 用户id（频道就给那串负数 id），要么回复 TA 的一条消息再 /unblock，本天才可不会读心术♡`,
  invalidUsername: (rawArgument: string): string => `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是 id（用户是正整数，频道是那串负数），别拿半截参数糊弄本天才♡`,
  unknownUsername: (rawUsername: string): string => `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息来 /unblock 吧♡`,
  conflictingTarget: (rawArgument: string): string => `笨蛋，你回复了一条消息、又写了 ${rawArgument}，这是两个目标呀；想解封谁就只留一个，要么删掉参数、要么别回复♡`,
  selfTarget: `笨蛋，本天才本来就没把自己拉黑呀♡`,
};

/** `/mute` 的目标解析提示。 */
export const MUTE_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: `笨蛋，时长写了倒是把人也说清楚呀：回复 TA 的消息发 /mute 10m，或者用 /mute @username 10m、/mute 用户id 10m，本天才可不会读心术♡`,
  invalidUsername: (rawArgument: string): string => `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是用户 id（得是正整数），别拿半截参数糊弄本天才♡`,
  unknownUsername: (rawUsername: string): string => `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息再来吧♡`,
  conflictingTarget: (rawArgument: string): string => `笨蛋，你回复了一条消息、又写了 ${rawArgument}，这是两个目标呀；想对谁动手就只留一个，要么删掉参数、要么别回复♡`,
  selfTarget: `笨蛋，本天才才不会捂自己的嘴呢♡`,
};

/** `/unmute` 的目标解析提示。 */
export const UNMUTE_TARGET_TEXTS: Readonly<CommandTargetMessages> = {
  missingTarget: `笨蛋，要么 /unmute @username 或 /unmute 用户id，要么回复 TA 的一条消息，本天才可不会读心术♡`,
  invalidUsername: (rawArgument: string): string => `笨蛋，${rawArgument} 既不是完整合法的 Telegram 用户名，也不是用户 id（得是正整数），别拿半截参数糊弄本天才♡`,
  unknownUsername: (rawUsername: string): string => `笨蛋，@${rawUsername} 都还没说过话呢，本天才不认识这号杂鱼，回复 TA 的消息再来吧♡`,
  conflictingTarget: (rawArgument: string): string => `笨蛋，你回复了一条消息、又写了 ${rawArgument}，这是两个目标呀；想对谁动手就只留一个，要么删掉参数、要么别回复♡`,
  selfTarget: `笨蛋，本天才又没被你捂住，拿 /unmute 对着本天才松什么嘴呀♡`,
};

/** 共用同一套目标提示文案的命令名。 */
type SharedTargetTextCommand = "copy" | "copy reverse" | "copy nya" | "icon steal";

/** 为一条命令创建模块级目标提示。 */
function createSharedTargetTexts(command: SharedTargetTextCommand): Readonly<CommandTargetMessages> {
  const commandName: string = `/${command}`;
  return {
    missingTarget: `笨蛋，要么 ${commandName} @username，要么直接回复 TA 的一条消息再 ${commandName}，本天才总得知道杂鱼是谁吧♡`,
    invalidUsername: (rawArgument: string): string =>
      `笨蛋，${rawArgument} 才不是完整合法的 Telegram 用户名呀，要写成 ${commandName} @username，别在后面夹垃圾♡`,
    unknownUsername: (rawUsername: string): string =>
      `笨蛋，@${rawUsername} 都还没说过话呢，本天才要怎么记住这种杂鱼呀，先让 TA 冒个泡，或者直接回复 TA 的消息来 ${commandName} 呀♡`,
    conflictingTarget: (rawArgument: string): string =>
      `笨蛋，你回复了一条消息、又写了 ${rawArgument}，本天才该盯上哪个杂鱼呀？只留一个再来♡`,
    selfTarget: `笨蛋，本天才怎么可能盯上自己呀♡`,
  };
}

/** `/copy` 的目标解析提示。 */
export const COPY_TARGET_TEXTS: Readonly<CommandTargetMessages> = createSharedTargetTexts("copy");

/** `/copy reverse` 的目标解析提示。 */
export const REVERSE_COPY_TARGET_TEXTS: Readonly<CommandTargetMessages> = createSharedTargetTexts("copy reverse");

/** `/copy nya` 的目标解析提示。 */
export const NYA_COPY_TARGET_TEXTS: Readonly<CommandTargetMessages> = createSharedTargetTexts("copy nya");

/** `/icon steal` 的目标解析提示。 */
export const STEAL_ICON_TARGET_TEXTS: Readonly<CommandTargetMessages> =
  createSharedTargetTexts("icon steal");
