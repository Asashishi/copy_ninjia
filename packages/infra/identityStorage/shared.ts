import {
  unacknowledgedIdentityWrites,
} from "../../cache/main/identityStorage";
import { assertTelegramIdentityId } from "../../database/codec/identity";
import type { IdentityPolicyTable } from "../../types/identityPolicy";
import type { UnacknowledgedIdentityWrite } from
  "../../types/identityStorage";

/** 校验并收敛 Disk I/O 返回的一张身份策略原始行表。 */
export function rawIdentityPolicyRows(
  rows: readonly (readonly [number, string])[],
  requested: ReadonlySet<number>,
  table: IdentityPolicyTable
): Map<number, string> {
  const result: Map<number, string> = new Map();
  for (const [id, data] of rows) {
    assertTelegramIdentityId(id, `identity ${table} read reply`);
    if (!requested.has(id) || result.has(id)) {
      throw new Error(
        `Disk I/O returned an unexpected or duplicate ${table} identity ${id}.`
      );
    }
    result.set(id, data);
  }
  return result;
}

/** 本地未 ACK 最终值覆盖数据库迟到值后的当前原始策略。 */
export function currentIdentityPolicyText(
  table: IdentityPolicyTable,
  id: number,
  databaseText: string | undefined
): string | null {
  const pending: UnacknowledgedIdentityWrite | undefined =
    unacknowledgedIdentityWrites(table).get(id);
  return pending === undefined ? databaseText ?? null : pending.data;
}
