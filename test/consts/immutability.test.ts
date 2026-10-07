import {
  BOTH_MENTION_FACTS,
  BOT_MENTION_FACTS,
  NO_MENTION_FACTS,
  OTHER_MENTION_FACTS,
  RANDOM_ECHO_MODES,
} from "../../packages/consts/auto";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { RELEASE_PLATFORMS, RELEASE_REQUIRED_FILES, RELEASE_VERSION_PATTERN } from "../../packages/consts/release";
import { LOGGER_HTTP_URL_PATTERN } from "../../packages/consts/logger";
import { AI_WORKER_JOB_ABORTED, AI_WORKER_JOB_TIMED_OUT, AI_WORKER_JOB_UNAVAILABLE } from "../../packages/consts/aiChat/workerJob";
import { VOICE_LANGUAGE_PROMPTS } from "../../packages/consts/aiChat/prompts/tools";
import { TTS_BOT_LANGUAGES } from "../../packages/consts/aiChat/voiceMessage";
import { REPLY_CONTEXT_SECTION_TEXT } from "../../packages/consts/aiChat/prompts/memory";
import type { PreparedReplyAction, ReplyActionChains, ReplyToolset } from "../../packages/types/aiChat/replies";

function assertReleaseAndLogConstantsReadonly(): void {
  // @ts-expect-error 发行平台表禁止调用方增删。
  RELEASE_PLATFORMS.push("mock-platform");
  // @ts-expect-error 必需入口表禁止调用方增删。
  RELEASE_REQUIRED_FILES.push("mock-entry");
  // @ts-expect-error 版本表达式的游标禁止调用方改写。
  RELEASE_VERSION_PATTERN.lastIndex = 1;
  // @ts-expect-error 日志 URL 表达式的游标禁止调用方改写。
  LOGGER_HTTP_URL_PATTERN.lastIndex = 1;
}
void assertReleaseAndLogConstantsReadonly;

function assertAiPromptAndToolConstantsReadonly(): void {
  // @ts-expect-error 回复上下文的分段文案禁止调用方改写（深层只读）。
  REPLY_CONTEXT_SECTION_TEXT.referenceMemory.header = "mock";
  // @ts-expect-error Gemini 服务端工具配置禁止调用方改写。
  GEMINI_SERVER_TOOL_CONFIG.includeServerSideToolInvocations = true;
}
void assertAiPromptAndToolConstantsReadonly;

function assertDiskIORequestOutcomesReadonly(): void {
  // @ts-expect-error 共用的超时结局禁止调用方改写。
  DISK_IO_REQUEST_TIMED_OUT.ok = true;
  // @ts-expect-error 共用的拒收结局禁止调用方改写。
  DISK_IO_REQUEST_REJECTED.ok = true;
}
void assertDiskIORequestOutcomesReadonly;

function assertAiWorkerJobFailuresReadonly(): void {
  // @ts-expect-error 共用的不可用结局禁止调用方改写。
  AI_WORKER_JOB_UNAVAILABLE.reason = "aborted";
  // @ts-expect-error 共用的取消结局禁止调用方改写。
  AI_WORKER_JOB_ABORTED.reason = "timed out";
  // @ts-expect-error 共用的超时结局禁止调用方改写。
  AI_WORKER_JOB_TIMED_OUT.ok = true;
}
void assertAiWorkerJobFailuresReadonly;

/** 回复工具集、已接纳动作与调用链 owner 是构造后只读的句柄。 */
function assertReplyToolHandlesReadonly(
  toolset: ReplyToolset,
  action: PreparedReplyAction,
  chains: ReplyActionChains
): void {
  // @ts-expect-error 工具声明在整轮内不可替换。
  toolset.functions = [];
  // @ts-expect-error 接纳边界由工具集构造时固定。
  toolset.execute = (): string => "";
  // @ts-expect-error 排空入口不可替换。
  toolset.settle = async (): Promise<void> => {};
  // @ts-expect-error 乐观回执在接纳后不可改写。
  action.result = "";
  // @ts-expect-error 已接纳链的执行函数不可改写。
  action.run = async (): Promise<string> => "";
  // @ts-expect-error 调用链 owner 的入口不可替换。
  chains.start = (): void => {};
}
void assertReplyToolHandlesReadonly;

function assertVoiceLanguagePromptsReadonly(): void {
  // @ts-expect-error 调用方不能替换某种台词语言的整份文案。
  VOICE_LANGUAGE_PROMPTS.ja = VOICE_LANGUAGE_PROMPTS.en;
  // @ts-expect-error 单份文案的工具说明不可修改。
  VOICE_LANGUAGE_PROMPTS.zh.sendVoiceInstruction = "changed";
  // @ts-expect-error 行动段文案不可修改。
  VOICE_LANGUAGE_PROMPTS.en.replyActionInstruction = "changed";
  // @ts-expect-error 朗读语言要求不可修改。
  VOICE_LANGUAGE_PROMPTS.ja.speechLanguageStyle = "changed";
  // @ts-expect-error 台词语言闭集禁止调用方增删。
  TTS_BOT_LANGUAGES.push("ja");
}
void assertVoiceLanguagePromptsReadonly;

function assertAtmosphereReadonly(): void {
  // @ts-expect-error 调用方不能替换风格表。
  ATMOSPHERE_TEXTS.plain = ATMOSPHERE_TEXTS.teasing;
  // @ts-expect-error 普通版菜单元素不可修改。
  ATMOSPHERE_TEXTS.plain.BOT_COMMANDS[0]!.description = "changed";
  // @ts-expect-error 默认版菜单容器不可扩容。
  ATMOSPHERE_TEXTS.teasing.BOT_COMMANDS.push({ command: "extra", description: "changed" });
  // @ts-expect-error 文案格式化函数不可替换。
  ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS.copyAlreadyRunning = (): string => "changed";
  // @ts-expect-error 权限说明表不可修改。
  ATMOSPHERE_TEXTS.plain.WHITELIST_PERMISSION_HELP.isCanMute = "changed";
  // @ts-expect-error 清理上下文权限说明不可修改。
  ATMOSPHERE_TEXTS.plain.WHITELIST_PERMISSION_HELP.isCanClearContext = "changed";
  // @ts-expect-error 嵌套目标提示不可修改。
  ATMOSPHERE_TEXTS.plain.PERMISSION_COMMAND_TEXTS.target.selfTarget = "changed";
  // @ts-expect-error 运势固定评语不可修改。
  ATMOSPHERE_TEXTS.plain.LUCK_TIER_COMMENTS.大吉 = "changed";
  // @ts-expect-error 默认运势固定评语不可修改。
  ATMOSPHERE_TEXTS.teasing.LUCK_TIER_COMMENTS.大吉 = "changed";
}
void assertAtmosphereReadonly;
import { TRANSLATE_LANGUAGE_CODES, TRANSLATE_LANGUAGE_LABELS } from "../../packages/consts/translate";
import { TRANSLATE_TARGET_TEXTS, TRANSLATE_TOGGLE_TEXTS } from "../../packages/consts/atmosphere/teasing/translate";
import { expect, test } from "bun:test";
import {
  DISK_IO_REQUEST_REJECTED,
  DISK_IO_REQUEST_TIMED_OUT,
  DISK_IO_RESPAWN_PRIORITIES,
} from "../../packages/consts/diskIO/common";
import { HOT_PATH_GC_CPU_BUDGETS } from "../../packages/consts/performance";

function assertGcCpuBudgetsReadonly(): void {
  // @ts-expect-error CPU 分档表不允许调用方增删规则。
  HOT_PATH_GC_CPU_BUDGETS.push({ minCpuCount: 1, maxPausePercent: 100 });
  // @ts-expect-error 每档 GC 暂停预算在编译期只读。
  HOT_PATH_GC_CPU_BUDGETS[0]!.maxPausePercent = 100;
  // @ts-expect-error 每档 CPU 下界在编译期只读。
  HOT_PATH_GC_CPU_BUDGETS[0]!.minCpuCount = 1;
}
void assertGcCpuBudgetsReadonly;

function assertTranslateConstantsReadonly(): void {
  // @ts-expect-error 翻译方向代码表由常量模块持有。
  TRANSLATE_LANGUAGE_CODES.en = "en";
  // @ts-expect-error 翻译方向显示表不得由调用方改写。
  TRANSLATE_LANGUAGE_LABELS.cn = "中文";
  // @ts-expect-error 乌克兰语代码不得由调用方改写。
  TRANSLATE_LANGUAGE_CODES.uk = "ua";
  // @ts-expect-error 俄语显示标签不得由调用方改写。
  TRANSLATE_LANGUAGE_LABELS.ru = "changed";
  // @ts-expect-error 翻译命令目标提示只读。
  TRANSLATE_TARGET_TEXTS.missingTarget = "changed";
}
void assertTranslateConstantsReadonly;

function assertWedRecoveryPriorityReadonly(): void {
  // @ts-expect-error 恢复顺序常量不得由调用方改写。
  DISK_IO_RESPAWN_PRIORITIES.WED_MEMBERS = 0;
}
void assertWedRecoveryPriorityReadonly;
import { AD_DETECT_TOGGLE_TEXTS, AI_CHAT_TOGGLE_TEXTS, BLOCK_TARGET_TEXTS, BOT_COMMANDS, COPY_TARGET_TEXTS, FLOOD_CONTROL_TOGGLE_TEXTS, INIT_TOGGLE_TEXTS, MUTE_TARGET_TEXTS, NYA_COPY_TARGET_TEXTS, REVERSE_COPY_TARGET_TEXTS, STEAL_ICON_TARGET_TEXTS, UNBLOCK_TARGET_TEXTS, UNMUTE_TARGET_TEXTS } from "../../packages/consts/atmosphere/teasing/commands";
import { CHAT_TEARDOWN_ORDER } from "../../packages/consts/chatTeardown";
import {
  AGENT_AI_CHAT_REQUIRED_CAPABILITIES,
  AGENT_API_KEY_PLACEHOLDERS,
  AGENT_CAPABILITY_NAMES,
} from "../../packages/consts/agent";
import { LUCK_TIERS } from "../../packages/consts/luckChallenge";
import { GAG_MIN_OPERATION_TIERS, GAG_REPLACEMENT_CHARACTERS } from "../../packages/consts/gag";
import { GAG_TARGET_TEXTS, UNGAG_TARGET_TEXTS } from "../../packages/consts/atmosphere/teasing/gag";
import { GEMINI_SAFETY_SETTINGS, GEMINI_SERVER_TOOL_CONFIG } from "../../packages/consts/aiChat/gemini";
import {
  OPENAI_FLEXIBLE_IMAGE_SIZE_BY_ASPECT_RATIO,
  OPENAI_STANDARD_IMAGE_SIZE_BY_ASPECT_RATIO,
  EMPTY_OUTPUT_ITEMS,
} from "../../packages/consts/aiChat/openai";
import { RANDOM_IMAGE_EXTENSIONS } from "../../packages/consts/randomImage";
import { H_IMAGE_TEXTS } from "../../packages/consts/atmosphere/teasing/hImage";
import {
  EMPTY_MESSAGE_ENTITIES,
  MUTED_CHAT_PERMISSIONS,
  DISABLED_LINK_PREVIEW,
} from "../../packages/consts/telegram";
import { QA_ANSWER_LABELS, QA_QUESTION_LABELS } from "../../packages/consts/qa";
import { DEFAULT_CHAT_STATE, adoptChatState, createChatState, isEmptyChatState } from "../../packages/libs/chatState";
import { CHAT_STATE_KEYS } from "../../packages/consts/storageSchema";
import { botPermissions } from "../helpers/botPermissions";
import type { ChatState } from "../../packages/types/chatState";
import { DEFAULT_WHITELIST_PERMISSIONS, NON_WHITELIST_PERMISSIONS, SUPER_ADMIN_WHITELIST_PERMISSIONS, TEMPORARY_AD_BYPASS_PERMISSIONS, WHITELIST_PERMISSION_KEY_BY_LOWERCASE } from "../../packages/consts/whitelist";
import { PERMISSION_COMMAND_TEXTS, WHITE_COMMAND_TEXTS } from "../../packages/consts/atmosphere/teasing/whitelist";
import { WEATHER_CODE_DESCRIPTIONS } from "../../packages/consts/weather";
import { BOT_CHAT_PERMISSION_LABELS } from "../../packages/consts/botAdmin";
import { getChatState } from "../../packages/infra/storage/stateStore";

import * as Media from "../../packages/consts/aiChat/media";
import { AD_DETECT_JSON_SCHEMA, EMPTY_AD_CANDIDATE_ENTRIES } from "../../packages/consts/antiRaid/adDetect";
import {
  CHANNEL_COMMENT_JOIN_EXEMPTION,
  IDENTITY_JOIN_EXEMPTION,
  NO_JOIN_EXEMPTION,
  NO_VERIFICATION_EFFECTS,
} from "../../packages/consts/antiRaid/verification";
import { NO_LOCKDOWN_EFFECTS } from "../../packages/consts/antiRaid/lockdown";
import { EMPTY_FUNCTION_CALLS } from "../../packages/consts/aiChat/tools";
import { EMPTY_STICKER_MENU } from "../../packages/consts/aiChat/stickers";

/**
 * 共享常量表的不可变性测试。
 *
 * 这些表运行期不 `Object.freeze`，保护全部落在类型上。
 * `bun run check:conventions` 保证「容器本身声明成只读」，但它是纯 AST 检查，
 * 判不了 `readonly LuckTier[]` 里那个 `LuckTier` 的字段是否可写；这个文件补上元素这一层。
 *
 * 每一行 `@ts-expect-error` 都是断言：元素类型被放宽成可写时，「预期的错误没有发生」会让
 * `bun run typecheck` 失败（TS2578）。
 *
 * `@ts-expect-error` 只压制类型报错，底下那行仍会执行，所以这里只做读取断言，不改这些共享表。
 */

test("常量表本身不可整体替换或就地增删", () => {
  // @ts-expect-error Agent 示例占位凭据表由配置严格解析共享，不允许追加。
  expect(() => AGENT_API_KEY_PLACEHOLDERS.push("replace-with-extra-api-key")).toBeDefined();
  // @ts-expect-error 只读数组不允许就地追加
  expect(() => AGENT_CAPABILITY_NAMES.push("video")).toBeDefined();
  // @ts-expect-error 只读数组不允许按下标改写
  expect(() => { AGENT_AI_CHAT_REQUIRED_CAPABILITIES[0] = "image"; }).toBeDefined();
  // @ts-expect-error 只读数组不允许就地追加
  expect(() => BOT_COMMANDS.push({ command: "x", description: "x" })).toBeDefined();
  // @ts-expect-error 只读数组不允许按下标改写
  expect(() => { RANDOM_ECHO_MODES[0] = "nya"; }).toBeDefined();
  // @ts-expect-error 只读数组不允许排序（原地改动）
  expect(() => LUCK_TIERS.sort()).toBeDefined();
  // @ts-expect-error gag 替换候选跨所有 inline 查询共享，不允许追加
  expect(() => GAG_REPLACEMENT_CHARACTERS.push("篡改")).toBeDefined();
  // @ts-expect-error gag 操作保底档位不允许追加
  expect(() => GAG_MIN_OPERATION_TIERS.push([99, 99])).toBeDefined();
  // @ts-expect-error 问答字段标签是投递消息的唯一判据，追加一个就等于放宽认领口径
  expect(() => QA_QUESTION_LABELS.push("篡改:")).toBeDefined();
  // @ts-expect-error 同上；答案标签同样跨每条投递消息共享
  expect(() => QA_ANSWER_LABELS.push("篡改:")).toBeDefined();
  // @ts-expect-error 共享空实体表被每条无代码块的问答直答复用，追加会污染所有调用方
  expect(() => EMPTY_MESSAGE_ENTITIES.push({ type: "bold", offset: 0, length: 1 })).toBeDefined();
  // @ts-expect-error teardown 派发顺序是承重的（同步段顺序 + 穷尽 owner），不允许追加
  expect(() => CHAT_TEARDOWN_ORDER.push("copy")).toBeDefined();
  // @ts-expect-error 同上，也不允许按下标换掉某个 owner
  expect(() => { CHAT_TEARDOWN_ORDER[0] = "qa"; }).toBeDefined();
});

test("准入、媒体、Telegram 固定载荷和各领域空列表均不可写", () => {
  const assertReadonly = (): void => {
    // @ts-expect-error 模态关闭结果必须只读。
    Media.MEDIA_CLOSED_RESULT.ok = false;
    // @ts-expect-error 退避结果必须只读。
    Media.MEDIA_BACKOFF_RESULT.ok = false;
    // @ts-expect-error 拒绝结果必须只读。
    Media.MEDIA_TASK_REJECTED_RESULT.ok = false;
    // @ts-expect-error 取消结果必须只读。
    Media.MEDIA_CANCELLED_RESULT.ok = false;
    // @ts-expect-error 模态初始状态由两种模态共享，必须只读。
    Media.INITIAL_MEDIA_INPUT_STATE.support = "supported";
    // @ts-expect-error 禁用链接预览的共享载荷必须只读。
    DISABLED_LINK_PREVIEW.is_disabled = true;
    // @ts-expect-error 广告候选的共享空列表不得追加。
    EMPTY_AD_CANDIDATE_ENTRIES.push({});
    // @ts-expect-error OpenAI 输出的共享空列表不得追加。
    EMPTY_OUTPUT_ITEMS.push({});
    // @ts-expect-error 各供应商共用的无工具调用空列表不得追加。
    EMPTY_FUNCTION_CALLS.push({});
    // @ts-expect-error 贴纸共享空菜单不得追加。
    EMPTY_STICKER_MENU.push({});
    // @ts-expect-error 验证状态机共享的空效果表不得追加。
    NO_VERIFICATION_EFFECTS.push({ kind: "sendReminder", label: "x", isBot: false });
    // @ts-expect-error 私密模式状态机共享的空效果表不得追加。
    NO_LOCKDOWN_EFFECTS.push({ kind: "persistState" });
    // @ts-expect-error 模态支持度状态机共享的空效果表不得追加。
    Media.NO_MEDIA_INPUT_EFFECTS.push({ kind: "logMisconfiguredMediaEndpoint", capability: "media" });
  };
  expect(assertReadonly).toBeFunction();
});

test("对象元素的字段同样不可写", () => {
  // @ts-expect-error BotCommand 元素经 Readonly<> 包裹，字段只读
  expect(() => { BOT_COMMANDS[0]!.command = "hijacked"; }).toBeDefined();
  // @ts-expect-error LuckTier 自身字段即为 readonly
  expect(() => { LUCK_TIERS[0]!.weight = 999; }).toBeDefined();
  // @ts-expect-error LuckTier.fortunePercentRange 是只读元组
  expect(() => { LUCK_TIERS[0]!.fortunePercentRange[0] = 0; }).toBeDefined();
  // @ts-expect-error gag 档位里的上界与保底数同样是只读元组
  expect(() => { GAG_MIN_OPERATION_TIERS[0]![0] = 99; }).toBeDefined();
  // @ts-expect-error SafetySetting 元素经 Readonly<> 包裹，字段只读
  expect(() => { GEMINI_SAFETY_SETTINGS[0]!.threshold = undefined; }).toBeDefined();
});

test("Readonly<Record<…>> 形态的常量不可写入", () => {
  // @ts-expect-error OpenAI 任意画幅尺寸表不允许覆盖既有比例
  expect(() => { OPENAI_FLEXIBLE_IMAGE_SIZE_BY_ASPECT_RATIO["1:1"] = "1536x1536"; }).toBeDefined();
  // @ts-expect-error OpenAI 标准画幅尺寸表同样只读
  expect(() => { OPENAI_STANDARD_IMAGE_SIZE_BY_ASPECT_RATIO["1:1"] = "1536x1536"; }).toBeDefined();
  // @ts-expect-error Readonly<ChatPermissions> 的字段只读
  expect(() => { MUTED_CHAT_PERMISSIONS.can_send_messages = true; }).toBeDefined();
  // @ts-expect-error Readonly<Record<number, string>> 不允许新增/覆盖键
  expect(() => { WEATHER_CODE_DESCRIPTIONS[0] = "篡改"; }).toBeDefined();
  // @ts-expect-error 权限中文名表被 /bot_status 回执与缺权限提示共用，改坏它等于
  // 对着所有群报错一个权限位的含义。
  expect(() => { BOT_CHAT_PERMISSION_LABELS.canDeleteMessages = "篡改"; }).toBeDefined();
  // @ts-expect-error Readonly<WhitelistPermissions> 的字段只读；这份默认值被
  // parsePermissions 逐条展开复用，写坏它等于改掉此后所有条目的缺省权限。
  expect(() => { DEFAULT_WHITELIST_PERMISSIONS.isCanBlock = true; }).toBeDefined();
  // @ts-expect-error 新增白名单授权默认值同样只能在编译期读取。
  expect(() => { DEFAULT_WHITELIST_PERMISSIONS.isCanWhiteOther = true; }).toBeDefined();
  // @ts-expect-error Readonly<WhitelistPermissions> 的字段只读；这一份是
  // getEffectiveWhitelistPermissions 直接交给调用方的超级管理员视图，写坏它
  // 就是当场把超级管理员降权。
  expect(() => { SUPER_ADMIN_WHITELIST_PERMISSIONS.isCanBlock = false; }).toBeDefined();
  // @ts-expect-error 非白名单 query 复用这份逐项 false 视图，不允许调用方改写。
  expect(() => { NON_WHITELIST_PERMISSIONS.isCanBlock = true; }).toBeDefined();
  // @ts-expect-error 临时广告免检共享这份仅广告豁免视图，不允许调用方扩权。
  expect(() => { TEMPORARY_AD_BYPASS_PERMISSIONS.isCanMute = true; }).toBeDefined();
  const compileOnly: () => void = (): void => {
    // @ts-expect-error 权限键规范化索引是跨命令调用共享的只读查表，不允许增删。
    WHITELIST_PERMISSION_KEY_BY_LOWERCASE.set("x", "isCanMute");
  };
  // 逐场景纳秒软上报阈值不是代码常量：它随运行时重测而变，存放在仓库根 performance-result.json 里，
  // 只读性由 test/perf/hotPathGateResult.test.ts 在解析结果上断言。
  expect(compileOnly).toBeFunction();
});

/**
 * 开关命令文案表是跨调用方共享的单例：resolveSuperAdminToggleArg 与 toggleReplyText 各读一次。
 * ToggleCommandTexts 的字段本身声明为 readonly，这里逐张确认那层只读在常量声明处没有被放宽。
 */
test("白名单命令文案表不可写入，嵌套的目标提示同样只读", () => {
  // @ts-expect-error PermissionCommandTexts.usage 只读
  expect(() => { PERMISSION_COMMAND_TEXTS.usage = "篡改"; }).toBeDefined();
  // @ts-expect-error PermissionCommandTexts.superAdminTarget 只读
  expect(() => { PERMISSION_COMMAND_TEXTS.superAdminTarget = "篡改"; }).toBeDefined();
  // @ts-expect-error CommandTargetMessages.selfTarget 只读；嵌套一层同样锁死
  expect(() => { PERMISSION_COMMAND_TEXTS.target.selfTarget = "篡改"; }).toBeDefined();
  // @ts-expect-error WhiteCommandTexts.usage 只读
  expect(() => { WHITE_COMMAND_TEXTS.usage = "篡改"; }).toBeDefined();
  // @ts-expect-error WhiteCommandTexts.alreadyEnabled 只读
  expect(() => { WHITE_COMMAND_TEXTS.alreadyEnabled = (): string => "篡改"; }).toBeDefined();
  // @ts-expect-error CommandTargetMessages.missingTarget 只读
  expect(() => { WHITE_COMMAND_TEXTS.target.missingTarget = "篡改"; }).toBeDefined();
});

/**
 * help / query 两条回执在正文里嵌 JSON 代码块，pre 实体的 offset 就是前缀的 UTF-16 长度；
 * 前缀以换行结尾，代码块从下一行开始。
 */
test("/permission 的代码块前缀以换行结尾", () => {
  expect(PERMISSION_COMMAND_TEXTS.helpPrefix.endsWith("\n")).toBeTrue();
  expect(PERMISSION_COMMAND_TEXTS.queryPrefix("目标").endsWith("\n")).toBeTrue();
});

test("/white 成员关系的四种结局互不相同", () => {
  const outcomes: readonly string[] = [
    WHITE_COMMAND_TEXTS.enabled("目标"),
    WHITE_COMMAND_TEXTS.alreadyEnabled("目标"),
    WHITE_COMMAND_TEXTS.disabled("目标"),
    WHITE_COMMAND_TEXTS.alreadyDisabled("目标"),
  ];
  expect(new Set(outcomes).size).toBe(4);
  for (const outcome of outcomes) expect(outcome).toContain("目标");
});

test("随机图片的扩展名表与 /h_image 文案表不可写入", () => {
  // @ts-expect-error RANDOM_IMAGE_EXTENSIONS 是 ReadonlyMap，没有 set
  expect(() => { RANDOM_IMAGE_EXTENSIONS.set(".gif", "image/png"); }).toBeDefined();
  // @ts-expect-error H_IMAGE_TEXTS.usage 只读
  expect(() => { H_IMAGE_TEXTS.usage = "篡改"; }).toBeDefined();
  // @ts-expect-error H_IMAGE_TEXTS.tooLarge 只读
  expect(() => { H_IMAGE_TEXTS.tooLarge = (): string => "篡改"; }).toBeDefined();
});

test("各命令的目标解析文案表不可写入", () => {
  // @ts-expect-error CommandTargetMessages.missingTarget 只读
  expect(() => { BLOCK_TARGET_TEXTS.missingTarget = "篡改"; }).toBeDefined();
  // @ts-expect-error CommandTargetMessages.selfTarget 只读
  expect(() => { UNBLOCK_TARGET_TEXTS.selfTarget = "篡改"; }).toBeDefined();
  // @ts-expect-error CommandTargetMessages.invalidUsername 只读
  expect(() => { MUTE_TARGET_TEXTS.invalidUsername = (): string => "篡改"; }).toBeDefined();
  // @ts-expect-error CommandTargetMessages.unknownUsername 只读
  expect(() => { UNMUTE_TARGET_TEXTS.unknownUsername = (): string => "篡改"; }).toBeDefined();
  // @ts-expect-error CommandTargetMessages.conflictingTarget 只读
  expect(() => { COPY_TARGET_TEXTS.conflictingTarget = (): string => "篡改"; }).toBeDefined();
  // @ts-expect-error CommandTargetMessages.missingTarget 只读
  expect(() => { REVERSE_COPY_TARGET_TEXTS.missingTarget = "篡改"; }).toBeDefined();
  // @ts-expect-error CommandTargetMessages.selfTarget 只读
  expect(() => { NYA_COPY_TARGET_TEXTS.selfTarget = "篡改"; }).toBeDefined();
  // @ts-expect-error CommandTargetMessages.unknownUsername 只读
  expect(() => { TRANSLATE_TARGET_TEXTS.unknownUsername = (): string => "篡改"; }).toBeDefined();
  // @ts-expect-error CommandTargetMessages.missingTarget 只读
  expect(() => { STEAL_ICON_TARGET_TEXTS.missingTarget = "篡改"; }).toBeDefined();
  // @ts-expect-error gag 的目标文案表同样跨调用共享，不允许改写
  expect(() => { GAG_TARGET_TEXTS.selfTarget = "篡改"; }).toBeDefined();
  // @ts-expect-error ungag 的目标文案表同样跨调用共享，不允许改写
  expect(() => { UNGAG_TARGET_TEXTS.missingTarget = "篡改"; }).toBeDefined();
});

/**
 * 这几张表是从「每次调用现造」抽出来的；逐张确认提示里念的是自己那条命令。
 */
test("目标解析文案念的是各自的命令名", () => {
  for (const [command, texts] of [
    ["/block", BLOCK_TARGET_TEXTS],
    ["/block disable", UNBLOCK_TARGET_TEXTS],
    ["/mute", MUTE_TARGET_TEXTS],
    ["/unmute", UNMUTE_TARGET_TEXTS],
    ["/copy", COPY_TARGET_TEXTS],
    ["/copy reverse", REVERSE_COPY_TARGET_TEXTS],
    ["/copy nya", NYA_COPY_TARGET_TEXTS],
    ["/translate", TRANSLATE_TARGET_TEXTS],
    ["/icon steal", STEAL_ICON_TARGET_TEXTS],
  ] as const) {
    expect(texts.missingTarget).toContain(command);
  }
  // /block disable 与 /unmute 的提示不能退化成 /block、/mute 的那份。
  expect(UNBLOCK_TARGET_TEXTS.missingTarget).not.toBe(BLOCK_TARGET_TEXTS.missingTarget);
  expect(UNMUTE_TARGET_TEXTS.missingTarget).not.toBe(MUTE_TARGET_TEXTS.missingTarget);
  expect(STEAL_ICON_TARGET_TEXTS.missingTarget).not.toBe(COPY_TARGET_TEXTS.missingTarget);
  expect(MUTE_TARGET_TEXTS.missingTarget).toContain("/mute 10m");
  expect(UNMUTE_TARGET_TEXTS.selfTarget).toContain("/unmute");
  expect(PERMISSION_COMMAND_TEXTS.target.missingTarget).toContain("@username");
});

test("开关命令文案表不可写入", () => {
  // @ts-expect-error ToggleCommandTexts.enabled 只读
  expect(() => { AI_CHAT_TOGGLE_TEXTS.enabled = "篡改"; }).toBeDefined();
  // @ts-expect-error ToggleCommandTexts.alreadyEnabled 只读
  expect(() => { AD_DETECT_TOGGLE_TEXTS.alreadyEnabled = "篡改"; }).toBeDefined();
  // @ts-expect-error ToggleCommandTexts.alreadyDisabled 只读
  expect(() => { FLOOD_CONTROL_TOGGLE_TEXTS.alreadyDisabled = "篡改"; }).toBeDefined();
  // @ts-expect-error ToggleCommandTexts.usage 只读
  expect(() => { TRANSLATE_TOGGLE_TEXTS.usage = "篡改"; }).toBeDefined();
  // @ts-expect-error ToggleCommandTexts.rejection 只读
  expect(() => { INIT_TOGGLE_TEXTS.rejection = (): string => "篡改"; }).toBeDefined();
});

test("开关命令文案表四种结局齐备且互不相同", () => {
  for (const texts of [
    AI_CHAT_TOGGLE_TEXTS,
    AD_DETECT_TOGGLE_TEXTS,
    FLOOD_CONTROL_TOGGLE_TEXTS,
    TRANSLATE_TOGGLE_TEXTS,
    INIT_TOGGLE_TEXTS,
  ]) {
    const outcomes: readonly string[] = [
      texts.enabled,
      texts.disabled,
      texts.alreadyEnabled,
      texts.alreadyDisabled,
    ];
    for (const outcome of outcomes) expect(outcome.length).toBeGreaterThan(0);
    // 四句两两不同：同状态重复执行时不沿用刚改完那句（见 types/commands.ts 的 ToggleCommandTexts）。
    expect(new Set(outcomes).size).toBe(4);
    expect(texts.usage.length).toBeGreaterThan(0);
    expect(texts.rejection("杂鱼").length).toBeGreaterThan(0);
  }
});

/**
 * 这张表是 `getChatState` 在「这个群还没有任何状态」时交出去的全进程共享对象。
 * 除了常量声明本身，访问器的返回类型也要锁住：`readonly` 不参与 TS 的可赋值性判定，
 * 返回类型写回可变的 `ChatState` 时，第二条断言会因「预期的错误没有发生」让 typecheck 报 TS2578。
 */
test("默认群状态单例与它的只读访问器都不许被写", () => {
  // @ts-expect-error Readonly<ChatState> 的字段只读
  expect(() => { DEFAULT_CHAT_STATE.isInitEnabled = true; }).toBeDefined();
  // @ts-expect-error getChatState 返回 Readonly<ChatState>，不得经它改状态
  expect(() => { getChatState(-1).botPermissions = undefined; }).toBeDefined();
  const assertBotPermissionsReadonly: () => void = (): void => {
    const permissions = getChatState(-1).botPermissions;
    if (permissions === undefined) return;
    // @ts-expect-error 权限快照构造后逐位只读，只允许主线程整体替换 State 字段
    permissions.canDeleteMessages = true;
  };
  expect(assertBotPermissionsReadonly).toBeFunction();
  // 读取照常。
  expect(DEFAULT_CHAT_STATE.isInitEnabled).toBeFalse();
  expect(DEFAULT_CHAT_STATE.isFloodControlEnabled).toBeFalse();
});

test("默认群状态单例与新建状态同形状：形状不一致会让热路径的读取重新发散", () => {
  // getChatState 在「有条目」和「没条目」之间交出这两个对象；键集合与顺序保持一致
  // （见 libs/chatState.ts 的 createChatState）。
  //
  // 比对的是一份手写的字段清单，不是 createChatState() 自己：DEFAULT_CHAT_STATE 就等于 createChatState() 的返回值。
  // `Record<keyof ChatState, true>` 让 ChatState 新增字段时这里编译不过；运行期再比一次键顺序。
  const shape: Record<keyof ChatState, true> = {
    quietUntil: true,
    lockdown: true,
    isAIChatEnabled: true,
    isTranslationEnabled: true,
    isAdDetectEnabled: true,
    isFloodControlEnabled: true,
    isAntiRaidEnabled: true,
    isInitEnabled: true,
    botPermissions: true,
    title: true,
    isProxySendEnabled: true,
    translate: true,
  };
  expect(Object.keys(createChatState())).toEqual(Object.keys(shape));
  expect(Object.keys(DEFAULT_CHAT_STATE)).toEqual(Object.keys(shape));
  // 恢复路径逐字段抄写，键顺序必须落回同一个隐藏类。
  expect(Object.keys(adoptChatState(DEFAULT_CHAT_STATE))).toEqual(Object.keys(shape));
  // 持久化字段闭集与规范形状逐键同序。
  expect([...CHAT_STATE_KEYS]).toEqual(Object.keys(shape));
});

test("isEmptyChatState 必须认得全部 12 个字段：漏掉一个就会把有状态的群当成空条目回收", () => {
  const values: Readonly<Record<keyof ChatState, unknown>> = {
    quietUntil: 1,
    lockdown: { phase: "applying", intentId: 1, originalPermissions: {}, announced: false, expiresAt: 1 },
    isAIChatEnabled: true,
    isTranslationEnabled: true,
    isAdDetectEnabled: true,
    isFloodControlEnabled: true,
    isAntiRaidEnabled: true,
    isInitEnabled: true,
    botPermissions: botPermissions(),
    title: "群名",
    isProxySendEnabled: true,
    translate: [{ translatedUser: { id: 1 }, language: "ja" }],
  };
  expect(isEmptyChatState(createChatState())).toBe(true);
  for (const [field, value] of Object.entries(values)) {
    const state: ChatState = createChatState();
    (state as unknown as Record<string, unknown>)[field] = value;
    expect(isEmptyChatState(state)).toBe(false);
  }
});

test("常量表内容本身仍可正常读取", () => {
  expect(BOT_COMMANDS.length).toBeGreaterThan(0);
  expect(LUCK_TIERS.reduce((sum: number, tier): number => sum + tier.weight, 0)).toBe(100);
  expect(RANDOM_ECHO_MODES).toContain("nya");
  expect(DEFAULT_WHITELIST_PERMISSIONS.isCanBypassFloodControl).toBe(true);
  expect(DEFAULT_WHITELIST_PERMISSIONS.isCanControllFloodControlPermission).toBe(false);
  expect(Object.keys(NON_WHITELIST_PERMISSIONS))
    .toEqual(Object.keys(DEFAULT_WHITELIST_PERMISSIONS));
  expect(Object.keys(TEMPORARY_AD_BYPASS_PERMISSIONS))
    .toEqual(Object.keys(DEFAULT_WHITELIST_PERMISSIONS));
  expect(TEMPORARY_AD_BYPASS_PERMISSIONS).toEqual({
    ...NON_WHITELIST_PERMISSIONS,
    isCanBypassAdDetection: true,
  });
  expect(NON_WHITELIST_PERMISSIONS.isCanBypassFloodControl).toBe(false);
  expect(NON_WHITELIST_PERMISSIONS.isCanViewBotStatus).toBe(false);
  expect(TEMPORARY_AD_BYPASS_PERMISSIONS.isCanBypassAdDetection).toBe(true);
  expect(TEMPORARY_AD_BYPASS_PERMISSIONS.isCanBypassFloodControl).toBe(false);
  expect(TEMPORARY_AD_BYPASS_PERMISSIONS.isCanViewBotStatus).toBe(false);
  expect(SUPER_ADMIN_WHITELIST_PERMISSIONS.isCanBlock).toBe(true);
  expect(SUPER_ADMIN_WHITELIST_PERMISSIONS.isCanControllFloodControlPermission).toBe(true);
});

function assertMentionFactsReadonly(): void {
  // @ts-expect-error 未提及任何人时共享的提及事实不可修改。
  NO_MENTION_FACTS.isMentioned = true;
  // @ts-expect-error 只提及机器人时共享的提及事实不可修改。
  BOT_MENTION_FACTS.hasOtherMention = true;
  // @ts-expect-error 只提及他人时共享的提及事实不可修改。
  OTHER_MENTION_FACTS.isMentioned = true;
  // @ts-expect-error 同时提及时共享的提及事实不可修改。
  BOTH_MENTION_FACTS.hasOtherMention = false;
}
void assertMentionFactsReadonly;

function assertJoinExemptionsReadonly(): void {
  // @ts-expect-error 没有豁免来源时共享的入群豁免结论不可修改。
  NO_JOIN_EXEMPTION.exempt = true;
  // @ts-expect-error 身份豁免时共享的入群豁免结论不可修改。
  IDENTITY_JOIN_EXEMPTION.viaChannelComment = true;
  // @ts-expect-error 评论区豁免时共享的入群豁免结论不可修改。
  CHANNEL_COMMENT_JOIN_EXEMPTION.exempt = false;
}
void assertJoinExemptionsReadonly;

import { BOT_ATMOSPHERES } from "../../packages/consts/bot";
function assertBotAtmospheresReadonly(): void {
  // @ts-expect-error 部署枚举到通知风格的映射不能由调用方改写。
  BOT_ATMOSPHERES.normal = "teasing";
}
void assertBotAtmospheresReadonly;

import { DEFAULT_ASSET_CONFIG } from "../../packages/consts/ui/assets";
function assertDefaultAssetConfigReadonly(): void {
  // @ts-expect-error 内置素材缺省快照也是 holder 初值，调用方不能改写。
  DEFAULT_ASSET_CONFIG.gagThumbnailUrl = "https://changed.example/g.png";
  // @ts-expect-error 默认头像来源同样只读，不能就地改成别的来源。
  DEFAULT_ASSET_CONFIG.botDefaultAvatar.kind = "path";
}
void assertDefaultAssetConfigReadonly;

import { TOOL_DECLARATIONS, WEB_SEARCH_TOOL_DECLARATION } from "../../packages/consts/tools";
function assertToolDeclarationsReadonly(): void {
  // @ts-expect-error 静态查询工具清单不能由调用方增删。
  TOOL_DECLARATIONS.push(TOOL_DECLARATIONS[0]!);
  // @ts-expect-error 工具声明的字段同样只读，不能就地改名。
  TOOL_DECLARATIONS[0]!.name = "changed";
  // @ts-expect-error 检索工具声明不可修改。
  WEB_SEARCH_TOOL_DECLARATION.name = "changed";
}
void assertToolDeclarationsReadonly;

import {
  WEB_DIGEST_JSON_SCHEMA,
  WEB_DIGEST_LANGUAGES,
  WEB_DIGEST_RESEARCH_URL_PATTERN,
  WEB_DIGEST_RESEARCH_URL_TRAILING_PUNCTUATION_PATTERN,
  WEB_DIGEST_SOURCE_LABELS,
} from "../../packages/consts/webDigest";
import { WEB_DIGEST_LANGUAGE_NAMES } from "../../packages/consts/aiChat/prompts/webDigest";
function assertWebDigestConstantsReadonly(): void {
  // @ts-expect-error 组稿 JSON Schema 不可修改。
  WEB_DIGEST_JSON_SCHEMA.type = "array";
  // @ts-expect-error 摘要语言清单不可增删。
  WEB_DIGEST_LANGUAGES.push("fr");
  // @ts-expect-error 来源标签表不可修改。
  WEB_DIGEST_SOURCE_LABELS.zh = "changed";
  // @ts-expect-error 正文链接表达式的游标不可修改。
  WEB_DIGEST_RESEARCH_URL_PATTERN.lastIndex = 1;
  // @ts-expect-error 链接句读表达式的游标不可修改。
  WEB_DIGEST_RESEARCH_URL_TRAILING_PUNCTUATION_PATTERN.lastIndex = 1;
  // @ts-expect-error 语言称呼表不可修改。
  WEB_DIGEST_LANGUAGE_NAMES.en = "changed";
}
void assertWebDigestConstantsReadonly;

function assertAdDetectSchemaReadonly(): void {
  // @ts-expect-error 广告检测 Schema 的字段形态不可修改。
  AD_DETECT_JSON_SCHEMA.properties.ad.type = "boolean";
  // @ts-expect-error 广告检测 Schema 的必填字段清单不可扩容。
  AD_DETECT_JSON_SCHEMA.required.push("extra");
}
void assertAdDetectSchemaReadonly;
