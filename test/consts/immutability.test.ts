import { expect, test } from "bun:test";
import { BOT_COMMANDS } from "../../packages/consts/commands";
import { LUCK_TIERS } from "../../packages/consts/luckChallenge";
import { GEMINI_SAFETY_SETTINGS } from "../../packages/consts/aiChat/tools";
import { RANDOM_ECHO_MODES } from "../../packages/consts/auto";
import { MUTED_CHAT_PERMISSIONS } from "../../packages/consts/telegram";
import { DEFAULT_CHAT_STATE } from "../../packages/consts/storage";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import { WEATHER_CODE_DESCRIPTIONS } from "../../packages/consts/weather";
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
  // @ts-expect-error 只读数组不允许就地追加
  expect(() => BOT_COMMANDS.push({ command: "x", description: "x" })).toBeDefined();
  // @ts-expect-error 只读数组不允许按下标改写
  expect(() => { RANDOM_ECHO_MODES[0] = "nya"; }).toBeDefined();
  // @ts-expect-error 只读数组不允许排序（原地改动）
  expect(() => LUCK_TIERS.sort()).toBeDefined();
});

test("对象元素的字段同样不可写", () => {
  // @ts-expect-error BotCommand 元素经 Readonly<> 包裹，字段只读
  expect(() => { BOT_COMMANDS[0]!.command = "hijacked"; }).toBeDefined();
  // @ts-expect-error LuckTier 自身字段即为 readonly
  expect(() => { LUCK_TIERS[0]!.weight = 999; }).toBeDefined();
  // @ts-expect-error LuckTier.fortunePercentRange 是只读元组
  expect(() => { LUCK_TIERS[0]!.fortunePercentRange[0] = 0; }).toBeDefined();
  // @ts-expect-error SafetySetting 元素经 Readonly<> 包裹，字段只读
  expect(() => { GEMINI_SAFETY_SETTINGS[0]!.threshold = undefined; }).toBeDefined();
});

test("Readonly<Record<…>> 形态的常量不可写入", () => {
  // @ts-expect-error Readonly<ChatPermissions> 的字段只读
  expect(() => { MUTED_CHAT_PERMISSIONS.can_send_messages = true; }).toBeDefined();
  // @ts-expect-error Readonly<Record<number, string>> 不允许新增/覆盖键
  expect(() => { WEATHER_CODE_DESCRIPTIONS[0] = "篡改"; }).toBeDefined();
  // @ts-expect-error Readonly<WhitelistPermissions> 的字段只读；这份默认值被
  // parsePermissions 逐条展开复用，写坏它等于改掉此后所有条目的缺省权限。
  expect(() => { DEFAULT_WHITELIST_PERMISSIONS.isCanBlock = true; }).toBeDefined();
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
  expect(() => { getChatState(-1).botIsAdmin = true; }).toBeDefined();
  // 读取照常。
  expect(DEFAULT_CHAT_STATE.isInitEnabled).toBeUndefined();
});

test("常量表内容本身仍可正常读取", () => {
  expect(BOT_COMMANDS.length).toBeGreaterThan(0);
  expect(LUCK_TIERS.reduce((sum: number, tier): number => sum + tier.weight, 0)).toBe(100);
  expect(RANDOM_ECHO_MODES).toContain("nya");
});
