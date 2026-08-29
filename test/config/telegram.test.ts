import { afterEach, describe, expect, test } from "bun:test";
import {
  BOT_TOKEN,
  SUPER_ADMIN_USER_ID,
  parseTelegramConfig,
} from "../../packages/config/telegram";
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
    const placeholder: string = "replace-with-telegram-bot-token";
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
