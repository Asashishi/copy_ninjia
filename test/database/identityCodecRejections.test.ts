import { describe, expect, test } from "bun:test";
import {
  assertTelegramIdentityId,
  decodeBlocklistEntryData,
  decodePendingBlockedRemovalData,
  decodeWhitelistEntryData,
} from "../../packages/database/codec/identity";
import { WHITELIST_PERMISSION_KEYS } from "../../packages/consts/whitelist";
import { InputValidationError } from "../../packages/libs/inputValidation";
import type { WhitelistPermissionKey } from "../../packages/types/identityPolicy";

/**
 * 名单与 outbox 三个解码器的**拒绝分支**逐条核对。
 *
 * 与 temporaryWhitelistCodec.test.ts 同一条理由：这些解码器是 AGENTS.md
 * 「不为用户行为兜底」在持久化侧的落点，被改坏的行必须致命退出而不是被默认值
 * 回填或丢弃。正例通过证明不了任何一条判定写对了方向——只有让每条 invalidInput
 * 都被一个具体的坏输入命中，才谈得上这道闸真的在。
 *
 * 断言统一核对「抛的是 InputValidationError」且「消息命中该字段路径」：字段路径
 * 是运维唯一能据以定位的东西，写错路径等于把人指到别的列上。
 */

const SOURCE: string = "whitelist_entries[7].data";

function allPermissions(value: boolean): Record<string, boolean> {
  const permissions: Record<string, boolean> = {};
  for (const key of WHITELIST_PERMISSION_KEYS) permissions[key] = value;
  return permissions;
}

const VALID_META: Readonly<Record<string, string>> = {
  firstName: "Ada",
  lastName: "L",
  username: "ada",
};

function expectRejected(decode: () => unknown, fieldPath: string): void {
  let thrown: unknown;
  try {
    decode();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(InputValidationError);
  const message: string = (thrown as InputValidationError).message;
  expect(message).toContain(fieldPath);
}

describe("身份主键的严格校验", () => {
  test("0 与非安全整数一律拒绝，正负 ID 都接受", () => {
    expect((): void => assertTelegramIdentityId(42, SOURCE)).not.toThrow();
    expect((): void => assertTelegramIdentityId(-1_001, SOURCE)).not.toThrow();
    expectRejected((): void => assertTelegramIdentityId(0, SOURCE), "$.id");
    expectRejected((): void => assertTelegramIdentityId(1.5, SOURCE), "$.id");
    expectRejected(
      (): void => assertTelegramIdentityId(Number.MAX_SAFE_INTEGER + 2, SOURCE),
      "$.id"
    );
  });
});

describe("白名单行的严格解码", () => {
  function whitelistJson(
    override: Readonly<Record<string, unknown>> = {}
  ): string {
    return JSON.stringify({
      permissions: allPermissions(true),
      meta: VALID_META,
      ...override,
    });
  }

  test("完整合法行通过并保留全部权限位", () => {
    const decoded = decodeWhitelistEntryData(whitelistJson(), SOURCE);
    expect(decoded.meta.username).toBe("ada");
    for (const key of WHITELIST_PERMISSION_KEYS) {
      expect(decoded.permissions[key as WhitelistPermissionKey]).toBeTrue();
    }
  });

  test("顶层形状不符一律拒绝", () => {
    expectRejected((): unknown => decodeWhitelistEntryData("[]", SOURCE), "$");
    expectRejected((): unknown => decodeWhitelistEntryData("null", SOURCE), "$");
    // 多一个未知键同样拒绝：hasExactKeys 不放行「顺手带上的字段」。
    expectRejected(
      (): unknown => decodeWhitelistEntryData(whitelistJson({ extra: 1 }), SOURCE),
      "$"
    );
    // 少一个键。
    expectRejected(
      (): unknown => decodeWhitelistEntryData(
        JSON.stringify({ permissions: allPermissions(true) }),
        SOURCE
      ),
      "$"
    );
  });

  test("权限对象缺键、多键或非布尔一律拒绝", () => {
    const incomplete: Record<string, boolean> = allPermissions(true);
    const firstKey: WhitelistPermissionKey = WHITELIST_PERMISSION_KEYS[0]!;
    delete incomplete[firstKey];
    expectRejected(
      (): unknown => decodeWhitelistEntryData(
        whitelistJson({ permissions: incomplete }),
        SOURCE
      ),
      "$.permissions"
    );

    const nonBoolean: Record<string, unknown> = allPermissions(true);
    nonBoolean[firstKey] = "true";
    expectRejected(
      (): unknown => decodeWhitelistEntryData(
        whitelistJson({ permissions: nonBoolean }),
        SOURCE
      ),
      `$.permissions.${firstKey}`
    );
  });

  test("metadata 三个字段各自的类型判定都生效", () => {
    expectRejected(
      (): unknown => decodeWhitelistEntryData(whitelistJson({ meta: "ada" }), SOURCE),
      "$.meta"
    );
    expectRejected(
      (): unknown => decodeWhitelistEntryData(
        whitelistJson({ meta: { ...VALID_META, firstName: 1 } }),
        SOURCE
      ),
      "$.meta.firstName"
    );
    expectRejected(
      (): unknown => decodeWhitelistEntryData(
        whitelistJson({ meta: { ...VALID_META, lastName: null } }),
        SOURCE
      ),
      "$.meta.lastName"
    );
    expectRejected(
      (): unknown => decodeWhitelistEntryData(
        whitelistJson({ meta: { ...VALID_META, username: [] } }),
        SOURCE
      ),
      "$.meta.username"
    );
  });
});

describe("黑名单行的严格解码", () => {
  function blocklistJson(
    override: Readonly<Record<string, unknown>> = {}
  ): string {
    return JSON.stringify({
      blockedAt: "2026/01/15 12:00:00",
      meta: VALID_META,
      ...override,
    });
  }

  test("合法行通过", () => {
    expect(decodeBlocklistEntryData(blocklistJson(), SOURCE).blockedAt)
      .toBe("2026/01/15 12:00:00");
  });

  test("顶层形状与 blockedAt 格式都严格核对", () => {
    expectRejected((): unknown => decodeBlocklistEntryData("42", SOURCE), "$");
    expectRejected(
      (): unknown => decodeBlocklistEntryData(blocklistJson({ extra: true }), SOURCE),
      "$"
    );
    expectRejected(
      (): unknown => decodeBlocklistEntryData(blocklistJson({ blockedAt: 1_700_000 }), SOURCE),
      "$.blockedAt"
    );
    // 形状对但不是 YYYY/MM/DD HH:mm:ss：ISO 串同样拒绝，不做宽松解析。
    expectRejected(
      (): unknown => decodeBlocklistEntryData(
        blocklistJson({ blockedAt: "2026-01-15T12:00:00Z" }),
        SOURCE
      ),
      "$.blockedAt"
    );
  });

  test("metadata 判定与白名单共用同一实现", () => {
    expectRejected(
      (): unknown => decodeBlocklistEntryData(blocklistJson({ meta: {} }), SOURCE),
      "$.meta"
    );
  });
});

describe("待踢 outbox 行的严格解码", () => {
  const OUTBOX_SOURCE: string = "pending_blocked_removals[3].data";

  function entryJson(
    params: Readonly<Record<string, unknown>>,
    override: Readonly<Record<string, unknown>> = {}
  ): string {
    return JSON.stringify({
      params,
      createdAt: 1_000,
      attempts: 0,
      lastFailure: null,
      ...override,
    });
  }

  const SWEEP_PARAMS: Readonly<Record<string, unknown>> = {
    chatId: -1_001,
    probeMembership: true,
    removalId: 1,
  };
  const FROZEN_PARAMS: Readonly<Record<string, unknown>> = {
    chatId: -1_001,
    probeMembership: false,
    removalId: 2,
    userIds: [11, 22],
  };

  test("补扫与定名两种合法形态都通过", () => {
    expect(decodePendingBlockedRemovalData(entryJson(SWEEP_PARAMS), OUTBOX_SOURCE)
      .params.probeMembership).toBeTrue();
    const frozen = decodePendingBlockedRemovalData(entryJson(FROZEN_PARAMS), OUTBOX_SOURCE);
    // 判别式收窄之后才拿得到 userIds：补扫那一支根本没有这个字段。
    expect(frozen.params.probeMembership).toBeFalse();
    if (frozen.params.probeMembership) throw new Error("expected a frozen removal");
    expect(frozen.params.userIds).toEqual([11, 22]);
  });

  test("条目顶层字段逐条核对", () => {
    expectRejected(
      (): unknown => decodePendingBlockedRemovalData("\"x\"", OUTBOX_SOURCE),
      "$"
    );
    expectRejected(
      (): unknown => decodePendingBlockedRemovalData(
        entryJson(SWEEP_PARAMS, { createdAt: -1 }),
        OUTBOX_SOURCE
      ),
      "$.createdAt"
    );
    expectRejected(
      (): unknown => decodePendingBlockedRemovalData(
        entryJson(SWEEP_PARAMS, { attempts: -1 }),
        OUTBOX_SOURCE
      ),
      "$.attempts"
    );
    expectRejected(
      (): unknown => decodePendingBlockedRemovalData(
        entryJson(SWEEP_PARAMS, { lastFailure: "nope" }),
        OUTBOX_SOURCE
      ),
      "$.lastFailure"
    );
  });

  test("params 形状、removalId 与 probeMembership 逐条核对", () => {
    expectRejected(
      (): unknown => decodePendingBlockedRemovalData(entryJson({ ...SWEEP_PARAMS, extra: 1 }), OUTBOX_SOURCE),
      "$.params"
    );
    expectRejected(
      (): unknown => decodePendingBlockedRemovalData(
        entryJson({ ...SWEEP_PARAMS, removalId: 0 }),
        OUTBOX_SOURCE
      ),
      "$.params.removalId"
    );
    expectRejected(
      (): unknown => decodePendingBlockedRemovalData(
        entryJson({ ...SWEEP_PARAMS, probeMembership: "yes" }),
        OUTBOX_SOURCE
      ),
      "$.params.probeMembership"
    );
  });

  test("补扫任务不得携带定名字段", () => {
    for (const frozen of ["userIds", "joinedAt", "announcementMessageId"]) {
      expectRejected(
        (): unknown => decodePendingBlockedRemovalData(
          entryJson({ ...SWEEP_PARAMS, [frozen]: frozen === "userIds" ? [1] : 1 }),
          OUTBOX_SOURCE
        ),
        "$.params"
      );
    }
  });

  test("定名任务的 userIds 必须非空、全为非零安全整数且不重复", () => {
    for (const userIds of [[], "11", [0], [1.5], [Number.MAX_SAFE_INTEGER + 2]]) {
      expectRejected(
        (): unknown => decodePendingBlockedRemovalData(
          entryJson({ ...FROZEN_PARAMS, userIds }),
          OUTBOX_SOURCE
        ),
        "$.params.userIds"
      );
    }
    // 重复 ID 单独一条判定：同一个人被踢两次会在战报里重复计数。
    expectRejected(
      (): unknown => decodePendingBlockedRemovalData(
        entryJson({ ...FROZEN_PARAMS, userIds: [11, 11] }),
        OUTBOX_SOURCE
      ),
      "$.params.userIds"
    );
  });

  test("定名任务的两个可选字段缺省合法、存在但非法则拒绝", () => {
    const withOptional = decodePendingBlockedRemovalData(
      entryJson({ ...FROZEN_PARAMS, joinedAt: 5, announcementMessageId: 9 }),
      OUTBOX_SOURCE
    );
    expect(withOptional.params.probeMembership).toBeFalse();

    expectRejected(
      (): unknown => decodePendingBlockedRemovalData(
        entryJson({ ...FROZEN_PARAMS, joinedAt: -1 }),
        OUTBOX_SOURCE
      ),
      "$.params.joinedAt"
    );
    expectRejected(
      (): unknown => decodePendingBlockedRemovalData(
        entryJson({ ...FROZEN_PARAMS, announcementMessageId: 0 }),
        OUTBOX_SOURCE
      ),
      "$.params.announcementMessageId"
    );
  });
});
