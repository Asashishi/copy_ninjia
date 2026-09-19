import { describe, expect, test } from "bun:test";
import { ATMOSPHERE_TEXTS } from "../../packages/consts/atmosphere";
import { describeBotPermissionGap } from "../../packages/libs/botPermissionGap";
import type { AtmosphereNotices } from "../../packages/types/atmosphereNotices";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { botPermissions } from "../helpers/botPermissions";

const NOT_ADMIN: BotChatPermissions = botPermissions({ isAdministrator: false, canManageChat: false });

describe("describeBotPermissionGap", () => {
  test("该位已具备时不给原因", () => {
    for (const texts of Object.values(ATMOSPHERE_TEXTS)) {
      expect(describeBotPermissionGap(
        botPermissions({ canDeleteMessages: true }),
        "canDeleteMessages",
        texts.NOTICE_TEXTS
      )).toBeUndefined();
    }
  });

  test("是管理员只缺这一位时点名权限中文名，不说成不是管理员", () => {
    for (const texts of Object.values(ATMOSPHERE_TEXTS)) {
      const reason: string | undefined =
        describeBotPermissionGap(botPermissions(), "canRestrictMembers", texts.NOTICE_TEXTS);
      expect(reason).toBe(texts.NOTICE_TEXTS.botMissingPermission("限制与封禁成员"));
      expect(reason).not.toContain("不是管理员");
    }
  });

  test("确证不是管理员时说不是管理员，并带上要补的那一位", () => {
    for (const texts of Object.values(ATMOSPHERE_TEXTS)) {
      const reason: string | undefined =
        describeBotPermissionGap(NOT_ADMIN, "canDeleteMessages", texts.NOTICE_TEXTS);
      expect(reason).toBe(texts.NOTICE_TEXTS.botNotAdministrator("删除消息"));
      expect(reason).toContain("不是");
      expect(reason).toContain("「删除消息」");
    }
  });

  test("快照缺失只说没查清，不猜身份", () => {
    for (const texts of Object.values(ATMOSPHERE_TEXTS)) {
      const reason: string | undefined =
        describeBotPermissionGap(undefined, "canDeleteMessages", texts.NOTICE_TEXTS);
      expect(reason).toBe(texts.NOTICE_TEXTS.botPermissionUnknown);
      expect(reason).not.toContain("管理员");
    }
  });

  test("普通版原因短语不带默认人设口吻", () => {
    const notices: Readonly<AtmosphereNotices> = ATMOSPHERE_TEXTS.plain.NOTICE_TEXTS;
    for (const reason of [
      notices.botPermissionUnknown,
      notices.botNotAdministrator("删除消息"),
      notices.botMissingPermission("删除消息"),
      notices.gagMissingRights("gag", notices.botPermissionUnknown),
      notices.muteBotLacksRights("Alice", notices.botPermissionUnknown),
      notices.unmuteBotLacksRights("Alice", notices.botPermissionUnknown),
      notices.blockSkippedHere(notices.botPermissionUnknown),
    ]) {
      expect(reason).not.toMatch(/本天才|杂鱼|笨蛋|♡|哼|小本本|猫脑子/);
    }
  });
});
