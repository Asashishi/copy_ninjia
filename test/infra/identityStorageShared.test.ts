/** Disk I/O 身份策略读回复的严格收敛（infra/identityStorage/shared.ts 的 rawIdentityPolicyRows）。 */

import { describe, expect, test } from "bun:test";
import { rawIdentityPolicyRows } from "../../packages/infra/identityStorage/shared";

describe("rawIdentityPolicyRows", () => {
  test("只含请求过的身份时按 id 收成表", () => {
    const rows: Map<number, string> = rawIdentityPolicyRows([[7, "{\"a\":1}"], [-1001, "{}"]], new Set([7, -1001, 9]), "whitelist");
    expect([...rows]).toEqual([[7, "{\"a\":1}"], [-1001, "{}"]]);
  });

  test("回复里出现未请求的身份时拒绝", () => {
    expect(() => rawIdentityPolicyRows([[8, "{}"]], new Set([7]), "blocklist"))
      .toThrow("Disk I/O returned an unexpected or duplicate blocklist identity 8.");
  });

  test("同一身份出现两次时拒绝", () => {
    expect(() => rawIdentityPolicyRows([[7, "{}"], [7, "{}"]], new Set([7]), "whitelist"))
      .toThrow("Disk I/O returned an unexpected or duplicate whitelist identity 7.");
  });

  test("身份 id 不是非零安全整数时拒绝", () => {
    expect(() => rawIdentityPolicyRows([[0, "{}"]], new Set([0]), "whitelist")).toThrow("identity whitelist read reply");
    expect(() => rawIdentityPolicyRows([[1.5, "{}"]], new Set([1.5]), "blocklist")).toThrow("identity blocklist read reply");
  });
});
