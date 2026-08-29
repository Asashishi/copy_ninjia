import { expect, test } from "bun:test";
import {
  AD_DETECT_TOGGLE_TEXTS,
  AI_CHAT_TOGGLE_TEXTS,
  BLOCK_TARGET_TEXTS,
  BOT_COMMANDS,
  COPY_TARGET_TEXTS,
  FLOOD_CONTROL_TOGGLE_TEXTS,
  INIT_TOGGLE_TEXTS,
  JA_COPY_TOGGLE_TEXTS,
  JA_COPY_TARGET_TEXTS,
  MUTE_TARGET_TEXTS,
  NYA_COPY_TARGET_TEXTS,
  REVERSE_COPY_TARGET_TEXTS,
  STEAL_ICON_TARGET_TEXTS,
  UNBLOCK_TARGET_TEXTS,
  UNMUTE_TARGET_TEXTS,
} from "../../packages/consts/commands";
import { CHAT_TEARDOWN_ORDER } from "../../packages/consts/chatTeardown";
import { AGENT_API_KEY_PLACEHOLDERS } from "../../packages/consts/agent";
import { LUCK_TIERS } from "../../packages/consts/luckChallenge";
import {
  GAG_MIN_OPERATION_TIERS,
  GAG_REPLACEMENT_CHARACTERS,
  GAG_TARGET_TEXTS,
  UNGAG_TARGET_TEXTS,
} from "../../packages/consts/gag";
import { GEMINI_SAFETY_SETTINGS } from "../../packages/consts/aiChat/gemini";
import {
  OPENAI_FLEXIBLE_IMAGE_SIZE_BY_ASPECT_RATIO,
  OPENAI_STANDARD_IMAGE_SIZE_BY_ASPECT_RATIO,
} from "../../packages/consts/aiChat/openai";
import { RANDOM_ECHO_MODES } from "../../packages/consts/auto";
import { EMPTY_MESSAGE_ENTITIES, MUTED_CHAT_PERMISSIONS } from "../../packages/consts/telegram";
import { QA_ANSWER_LABELS, QA_QUESTION_LABELS } from "../../packages/consts/qa";
import { DEFAULT_CHAT_STATE, createChatState } from "../../packages/libs/chatState";
import {
  DEFAULT_WHITELIST_PERMISSIONS,
  NON_WHITELIST_PERMISSIONS,
  PERMISSION_COMMAND_TEXTS,
  SUPER_ADMIN_WHITELIST_PERMISSIONS,
  WHITELIST_PERMISSION_KEY_BY_LOWERCASE,
  WHITE_COMMAND_TEXTS,
} from "../../packages/consts/whitelist";
import { WEATHER_CODE_DESCRIPTIONS } from "../../packages/consts/weather";
import { BOT_STATUS_PERMISSION_LABELS } from "../../packages/consts/botStatus";
import { getChatState } from "../../packages/infra/storage/stateStore";

/**
 * 共享常量表的不可变性回归测试。
 *
 * 这些表**运行期不再 `Object.freeze`**（理由与实测数字见 AGENTS.md 的「常量」
 * 一节：冻结容器在 JSC 上没有读取快路径），保护全部落在类型上。
 * `bun run check:conventions` 能保证「容器本身声明成只读」，但它是纯 AST 检查，
 * 判不了 `readonly LuckTier[]` 里那个 `LuckTier` 的字段到底可不可写——旧规则
 * 靠逐层 `Object.freeze` 覆盖的正是这一层。这个文件把那一层补回来。
 *
 * 每一行 `@ts-expect-error` 都是断言：哪天某个元素类型被放宽成可写，这里会因为
 * 「预期的错误没有发生」直接让 `bun run typecheck` 失败（TS2578）。
 *
 * **注意 `@ts-expect-error` 只压制类型报错，底下那行仍会执行**，所以这里只做
 * 读取断言，绝不真去改这些共享表——写坏了会污染同进程里其它测试。
 */

test("常量表本身不可整体替换或就地增删", () => {
  // @ts-expect-error Agent 示例占位凭据表由配置严格解析共享，不允许追加。
  expect(() => AGENT_API_KEY_PLACEHOLDERS.push("replace-with-extra-api-key")).toBeDefined();
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
  // @ts-expect-error 权限中文名表被 /bot_status 每次回执读取，改坏它等于对着
  // 所有群报错一个权限位的含义。
  expect(() => { BOT_STATUS_PERMISSION_LABELS.canDeleteMessages = "篡改"; }).toBeDefined();
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
  const compileOnly: () => void = (): void => {
    // @ts-expect-error 权限键规范化索引是跨命令调用共享的只读查表，不允许增删。
    WHITELIST_PERMISSION_KEY_BY_LOWERCASE.set("x", "isCanMute");
  };
  // 逐场景纳秒软上报阈值已经不是代码常量：它随运行时重测而变，现在住在仓库根
  // performance-result.json 里，只读性由 test/perf/hotPathGateResult.test.ts 在解析结果上断言。
  expect(compileOnly).toBeFunction();
});

/**
 * 五张开关命令文案表都是跨调用方共享的单例：resolveSuperAdminToggleArg 与
 * toggleReplyText 各读一次，写坏其中一句就是全群一起换口径。ToggleCommandTexts
 * 的字段本身声明为 readonly，这里逐张确认那层只读没有在常量声明处被放宽。
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
 * help / query 两条回执要在正文里嵌 JSON 代码块，pre 实体的 offset 就是前缀的
 * UTF-16 长度。前缀少了结尾换行，代码块会从开场白最后一个字符开始，Telegram
 * 渲染出来整块错位——这是文案改动最容易踩、又最不容易在单测里看出来的一处。
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
  expect(() => { JA_COPY_TARGET_TEXTS.unknownUsername = (): string => "篡改"; }).toBeDefined();
  // @ts-expect-error CommandTargetMessages.missingTarget 只读
  expect(() => { STEAL_ICON_TARGET_TEXTS.missingTarget = "篡改"; }).toBeDefined();
  // @ts-expect-error gag 的目标文案表同样跨调用共享，不允许改写
  expect(() => { GAG_TARGET_TEXTS.selfTarget = "篡改"; }).toBeDefined();
  // @ts-expect-error ungag 的目标文案表同样跨调用共享，不允许改写
  expect(() => { UNGAG_TARGET_TEXTS.missingTarget = "篡改"; }).toBeDefined();
});

/**
 * 这几张表是从「每次调用现造」抽出来的，最容易在复制粘贴时留下上一条命令的
 * 命令名。逐张确认提示里念的是自己那条命令。
 */
test("目标解析文案念的是各自的命令名", () => {
  for (const [command, texts] of [
    ["/block", BLOCK_TARGET_TEXTS],
    ["/unblock", UNBLOCK_TARGET_TEXTS],
    ["/mute", MUTE_TARGET_TEXTS],
    ["/unmute", UNMUTE_TARGET_TEXTS],
    ["/copy", COPY_TARGET_TEXTS],
    ["/r_copy", REVERSE_COPY_TARGET_TEXTS],
    ["/nya_copy", NYA_COPY_TARGET_TEXTS],
    ["/ja_copy", JA_COPY_TARGET_TEXTS],
    ["/steal_icon", STEAL_ICON_TARGET_TEXTS],
  ] as const) {
    expect(texts.missingTarget).toContain(command);
  }
  // /unblock 与 /unmute 的提示不能退化成 /block、/mute 的那份。
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
  expect(() => { JA_COPY_TOGGLE_TEXTS.usage = "篡改"; }).toBeDefined();
  // @ts-expect-error ToggleCommandTexts.rejection 只读
  expect(() => { INIT_TOGGLE_TEXTS.rejection = (): string => "篡改"; }).toBeDefined();
});

test("开关命令文案表四种结局齐备且互不相同", () => {
  for (const texts of [
    AI_CHAT_TOGGLE_TEXTS,
    AD_DETECT_TOGGLE_TEXTS,
    FLOOD_CONTROL_TOGGLE_TEXTS,
    JA_COPY_TOGGLE_TEXTS,
    INIT_TOGGLE_TEXTS,
  ]) {
    const outcomes: readonly string[] = [
      texts.enabled,
      texts.disabled,
      texts.alreadyEnabled,
      texts.alreadyDisabled,
    ];
    for (const outcome of outcomes) expect(outcome.length).toBeGreaterThan(0);
    // 四句必须两两不同：同状态重复执行若沿用刚改完那句，群里看到的就是一次
    // 并不存在的状态变化（见 types/commands.ts 的 ToggleCommandTexts）。
    expect(new Set(outcomes).size).toBe(4);
    expect(texts.usage.length).toBeGreaterThan(0);
    expect(texts.rejection("杂鱼").length).toBeGreaterThan(0);
  }
});

/**
 * 这张表比其它常量更危险：它不是一份静态数据，而是 `getChatState` 在「这个群
 * 还没有任何状态」时交出去的那个**全进程共享**对象。写进它一次，所有没有状态
 * 的群立刻一起报告那个字段。因此除了常量声明本身，访问器的返回类型也必须锁住
 * ——`readonly` 不参与 TS 的可赋值性判定，只要哪天有人把返回类型写回可变的
 * `ChatState`，第二条断言就会因为「预期的错误没有发生」让 typecheck 报 TS2578。
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
  expect(DEFAULT_CHAT_STATE.isInitEnabled).toBeUndefined();
  expect(DEFAULT_CHAT_STATE.isFloodControlEnabled).toBeUndefined();
});

test("默认群状态单例与新建状态同形状：形状不一致会让热路径的读取重新发散", () => {
  // getChatState 在「有条目」和「没条目」之间来回交出这两个对象；键集合或顺序
  // 一旦分叉，每条群消息那 4~6 次读取就又变成多态（见 libs/chatState.ts 的
  // createChatState）。漏加一个字段在别处只会静默降级，只有这里看得出来。
  expect(Object.keys(DEFAULT_CHAT_STATE)).toEqual(Object.keys(createChatState()));
});

test("常量表内容本身仍可正常读取", () => {
  expect(BOT_COMMANDS.length).toBeGreaterThan(0);
  expect(LUCK_TIERS.reduce((sum: number, tier): number => sum + tier.weight, 0)).toBe(100);
  expect(RANDOM_ECHO_MODES).toContain("nya");
  expect(DEFAULT_WHITELIST_PERMISSIONS.isCanBypassFloodControl).toBe(true);
  expect(DEFAULT_WHITELIST_PERMISSIONS.isCanControllFloodControlPermission).toBe(false);
  expect(Object.keys(NON_WHITELIST_PERMISSIONS))
    .toEqual(Object.keys(DEFAULT_WHITELIST_PERMISSIONS));
  expect(NON_WHITELIST_PERMISSIONS.isCanBypassFloodControl).toBe(false);
  expect(NON_WHITELIST_PERMISSIONS.isCanViewBotStatus).toBe(false);
  expect(SUPER_ADMIN_WHITELIST_PERMISSIONS.isCanBlock).toBe(true);
  expect(SUPER_ADMIN_WHITELIST_PERMISSIONS.isCanControllFloodControlPermission).toBe(true);
});
