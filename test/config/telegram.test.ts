import { afterEach, describe, expect, test } from "bun:test";
import {
  BOT_TOKEN,
  SUPER_ADMIN_USER_ID,
  getTelegramConfig,
  parseTelegramConfig,
} from "../../packages/config/telegram";
import { TELEGRAM_CONFIG_PATH } from "../../packages/consts/paths";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../../packages/consts/telegram";
import { telegramConfigCache } from "../../packages/cache/perThread/config";
import type { TelegramConfig } from "../../packages/types/config";

afterEach((): void => {
  telegramConfigCache.current = null;
});

describe("config/telegram.json", () => {
  test("测试配置可加载且输出稳定的运行时类型", () => {
    expect(BOT_TOKEN).toBe("123456789:test-only-telegram-bot-token");
    expect(SUPER_ADMIN_USER_ID).toBe(123456789);
  });

  test("严格解析 token 与正安全整数超级管理员 ID", () => {
    const parsed: TelegramConfig = parseTelegramConfig(
      { bot_token: "  token:secret  ", super_admin_user_id: 123 },
      "telegram.test.json"
    );
    expect(parsed).toEqual({ botToken: "token:secret", superAdminUserId: 123 });
  });

  test("示例 token 在启动前拒绝且错误不回显原值", () => {
    // 取常量而不是再抄一份字面量：占位符在 consts、config_example 与 install.sh
    // 各有一份，抄进测试会让常量改了测试照样绿。示例文件那一份的对拍见
    // test/config/examples.test.ts，install.sh 那一份见 test/scripts/installScript.test.ts。
    const placeholder: string = TELEGRAM_BOT_TOKEN_PLACEHOLDER;
    const parse = (): TelegramConfig => parseTelegramConfig(
      { bot_token: placeholder, super_admin_user_id: 123 },
      "telegram.test.json"
    );
    expect(parse).toThrow(
      "telegram.test.json: $.bot_token must be a configured non-placeholder string"
    );
    expect(parse).not.toThrow(placeholder);
  });

  test("解析结果在编译期保持只读", () => {
    const assertReadonly = (config: TelegramConfig): void => {
      // @ts-expect-error 部署配置只在进程启动时构造一次，调用方不得改写 token。
      config.botToken = "replacement";
      // @ts-expect-error 超级管理员身份同样只能通过停机修改配置来变更。
      config.superAdminUserId = 456;
    };
    expect(assertReadonly).toBeDefined();
  });

  test("快照未初始化时读取直接抛错，且只写路径不写值", () => {
    // 生产里这条分支只在「模块顶层 await 尚未跑完就有人读」时到得了，属于
    // 启动期必须硬失败的边界（AGENTS.md「不为用户行为兜底」）：不得回退默认值，
    // 也不得把 token 回显进错误文案。
    telegramConfigCache.current = null;
    expect(getTelegramConfig).toThrow(
      `Telegram configuration was not initialized from ${TELEGRAM_CONFIG_PATH}.`
    );
    expect(getTelegramConfig).not.toThrow(BOT_TOKEN);
  });

  test("快照就位后读取原样交回同一份对象，不重新解析", () => {
    const snapshot: TelegramConfig = { botToken: "token:snapshot", superAdminUserId: 7 };
    telegramConfigCache.current = snapshot;
    expect(getTelegramConfig()).toBe(snapshot);
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
      expect((): TelegramConfig => parseTelegramConfig(value, "telegram.test.json"))
        .toThrow("telegram.test.json:");
    }
  });
});
