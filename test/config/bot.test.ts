import { getTimeZone } from "../../packages/config/time";
import { afterEach, describe, expect, test } from "bun:test";
import {
  BOT_TOKEN,
  SUPER_ADMIN_USER_ID,
  getBotConfig,
} from "../../packages/config/bot";
import { parseBotConfig } from "../../packages/config/botInput";
import { BOT_CONFIG_PATH } from "../../packages/consts/paths";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../../packages/consts/telegram";
import { botConfigCache } from "../../packages/cache/perThread/config";
import type { BotConfig } from "../../packages/types/config";
import { DEFAULT_BOT_TIME_ZONE } from "../../packages/consts/bot";

afterEach((): void => {
  botConfigCache.current = null;
});

describe("config/static/bot.json", () => {
  test("测试配置可加载且输出稳定的运行时类型", async () => {
    const expected: BotConfig = parseBotConfig(await Bun.file(BOT_CONFIG_PATH).json());
    expect(BOT_TOKEN).toBe(expected.botToken);
    expect(SUPER_ADMIN_USER_ID).toBe(expected.superAdminUserId);
  });

  test("严格解析 token 与正安全整数超级管理员 ID", () => {
    const parsed: BotConfig = parseBotConfig(
      { bot_token: "  token:secret  ", super_admin_user_id: 123 },
      "telegram.test.json"
    );
    expect(parsed).toEqual({ timeZone: DEFAULT_BOT_TIME_ZONE, atmosphere: undefined, botToken: "token:secret", superAdminUserId: 123 });
  });

  test("示例 token 在启动前拒绝且错误不回显原值", () => {
    // 取常量而不是再抄一份字面量：占位符在 consts、config_example 与 install.sh
    // 各有一份，抄进测试会让常量改了测试照样绿。示例文件那一份的对拍见
    // test/config/examples.test.ts，install.sh 那一份见 test/scripts/installScript.test.ts。
    const placeholder: string = TELEGRAM_BOT_TOKEN_PLACEHOLDER;
    const parse = (): BotConfig => parseBotConfig(
      { bot_token: placeholder, super_admin_user_id: 123 },
      "telegram.test.json"
    );
    expect(parse).toThrow(
      "telegram.test.json: $.bot_token must be a configured non-placeholder string"
    );
    expect(parse).not.toThrow(placeholder);
  });

  test("解析结果在编译期保持只读", () => {
    const assertReadonly = (config: BotConfig): void => {
      // @ts-expect-error 部署配置只在进程启动时构造一次，调用方不得改写 token。
      config.botToken = "replacement";
      // @ts-expect-error 超级管理员身份同样只能通过停机修改配置来变更。
      config.superAdminUserId = 456;
      // @ts-expect-error 通知风格属于本次启动的只读配置。
      config.atmosphere = "normal";
      // @ts-expect-error 默认时区属于本次启动的只读配置。
      config.timeZone = "UTC";
    };
    expect(assertReadonly).toBeDefined();
  });

  test("快照未初始化时读取直接抛错，且只写路径不写值", () => {
    // 生产里这条分支只在「模块顶层 await 尚未跑完就有人读」时到得了，属于
    // 启动期必须硬失败的边界（AGENTS.md「不为用户行为兜底」）：不得回退默认值，
    // 也不得把 token 回显进错误文案。
    botConfigCache.current = null;
    expect(getBotConfig).toThrow(
      `Telegram configuration was not initialized from ${BOT_CONFIG_PATH}.`
    );
    expect(getBotConfig).not.toThrow(BOT_TOKEN);
  });

  test("快照就位后读取原样交回同一份对象，不重新解析", () => {
    const snapshot: BotConfig = { timeZone: getTimeZone(), atmosphere: "mesugaki", botToken: "token:snapshot", superAdminUserId: 7 };
    botConfigCache.current = snapshot;
    expect(getBotConfig()).toBe(snapshot);
  });

  test("缺字段、未知字段、空 token 与非法 ID 都拒绝且不回显输入", () => {
    const invalidValues: readonly unknown[] = [
      {},
      { bot_token: "secret" },
      { bot_token: "secret", super_admin_user_id: 1, extra: true },
      { bot_token: "   ", super_admin_user_id: 1 },
      { bot_token: "secret", super_admin_user_id: "1" },
      { bot_token: "secret", super_admin_user_id: 0 },
      { bot_token: "secret", super_admin_user_id: Number.MAX_SAFE_INTEGER + 1 },
    ];
    for (const value of invalidValues) {
      expect((): BotConfig => parseBotConfig(value, "telegram.test.json"))
        .toThrow("telegram.test.json:");
    }
  });
});

test("通知风格缺省保持未配置，显式值 trim 后保留且非法值拒绝", () => {
  for (const atmosphere of [undefined, "mesugaki", "normal"] as const) {
    expect(parseBotConfig({ bot_token: "secret", super_admin_user_id: 7, atmosphere }).atmosphere)
      .toBe(atmosphere);
  }
  for (const atmosphere of ["mesugaki", "normal"] as const) {
    expect(parseBotConfig({ bot_token: "secret", super_admin_user_id: 7, atmosphere: ` ${atmosphere} ` }).atmosphere)
      .toBe(atmosphere);
  }
  for (const atmosphere of [null, "plain", "teasing", "", "  ", 1, [], {}]) {
    expect(() => parseBotConfig({ bot_token: "secret", super_admin_user_id: 7, atmosphere }, "bot.fixture.json"))
      .toThrow("bot.fixture.json: $.atmosphere must be mesugaki or normal");
  }
});

test("默认时区缺省使用 Bot 默认值，配置值 trim 后保留", () => {
  const identity: Readonly<Record<string, unknown>> = { bot_token: "secret", super_admin_user_id: 7 };
  expect(parseBotConfig(identity).timeZone).toBe(DEFAULT_BOT_TIME_ZONE);
  for (const timeZone of ["UTC", "Asia/Shanghai", "America/New_York", "Asia/Kathmandu"]) {
    expect(parseBotConfig({ ...identity, time_zone: ` ${timeZone} ` }).timeZone).toBe(timeZone);
  }
});

test("默认时区按 Temporal 规范化大小写，别名不折叠", () => {
  const identity: Readonly<Record<string, unknown>> = { bot_token: "secret", super_admin_user_id: 7 };
  for (const [input, canonical] of [
    ["asia/tokyo", "Asia/Tokyo"], ["ASIA/TOKYO", "Asia/Tokyo"], ["utc", "UTC"],
    ["europe/london", "Europe/London"], ["Japan", "Japan"], ["Asia/Calcutta", "Asia/Calcutta"],
  ] as const) {
    expect(parseBotConfig({ ...identity, time_zone: input }).timeZone).toBe(canonical);
  }
});

test("存在但非法的默认时区拒绝，错误只包含文件、字段与期望", () => {
  for (const timeZone of [null, "", "  ", "secret-invalid-zone", "+09:00", 9, true, [], {}]) {
    expect((): BotConfig => parseBotConfig({
      bot_token: "secret", super_admin_user_id: 7, time_zone: timeZone,
    }, "bot.fixture.json")).toThrow("bot.fixture.json: $.time_zone must be an IANA time zone name.");
  }
});
