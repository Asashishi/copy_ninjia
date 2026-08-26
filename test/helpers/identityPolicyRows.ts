import {
  blocklistEntries,
  whitelistEntries,
} from "../../packages/database/schema/identityPolicy";
import type { IdentityPolicyTable } from "../../packages/types/identityPolicy";
import type { StorageDatabase } from "../../packages/types/storageDatabase";

export interface PutIdentityPolicyRowOptions {
  readonly database: StorageDatabase;
  readonly table: IdentityPolicyTable;
  readonly id: number;
  readonly data: string;
}

/**
 * 写入一条原始名单行，绕过生产写入路径的编码与校验。只供损坏数据回归测试
 * 构造严格启动输入；生产代码没有「按表名写任意 data」这条入口。
 */
export function putIdentityPolicyRow({
  database,
  table,
  id,
  data,
}: PutIdentityPolicyRowOptions): void {
  if (table === "whitelist") {
    database.insert(whitelistEntries).values({ id, data })
      .onConflictDoUpdate({ target: whitelistEntries.id, set: { data } }).run();
    return;
  }
  database.insert(blocklistEntries).values({ id, data })
    .onConflictDoUpdate({ target: blocklistEntries.id, set: { data } }).run();
}
