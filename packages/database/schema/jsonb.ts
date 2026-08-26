import { sql } from "drizzle-orm";
import { check, customType } from "drizzle-orm/sqlite-core";
import {
  IDENTITY_DATABASE_JSONB_STRICT_VALIDATION_FLAG,
  IDENTITY_DATABASE_JSONB_VALIDATION_FLAG,
} from "../../consts/identityStorage";
import type { SQL } from "drizzle-orm";
import type { CheckBuilder, SQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * SQLite JSONB 的 Drizzle 驱动编解码边界。
 *
 * 写入时由 SQLite 把严格校验后的 JSON 文本编码为私有 JSONB BLOB；读取必须通过
 * `jsonbTextProjection` 转回文本，业务代码不接触 SQLite 私有二进制格式。
 */
export const jsonbText: ReturnType<typeof customType<{
  data: string;
  driverData: Uint8Array;
}>> = customType<{
  data: string;
  driverData: Uint8Array;
}>({
  dataType: (): string => "blob",
  toDriver: (value: string): SQL => sql`jsonb(${value})`,
  fromDriver: (_value: Uint8Array): never => {
    throw new Error("SQLite JSONB columns must be read through their schema projection.");
  },
});

/** 仅供各 JSONB 表声明共用 CHECK 时约束 data 列形状。 */
export interface JsonDataTable {
  readonly data: SQLiteColumn;
}

/** 为一张表生成 SQLite JSONB 合法性 CHECK，表名由调用方显式提供。 */
export function jsonDataCheck(name: string, table: JsonDataTable): CheckBuilder[] {
  const validationFlag: SQL = sql.raw(String(IDENTITY_DATABASE_JSONB_VALIDATION_FLAG));
  return [check(name, sql`json_valid(${table.data}, ${validationFlag})`)];
}

/** 把 SQLite 私有 JSONB BLOB 投影为可交给严格领域解码器的规范 JSON 文本。 */
export function jsonbTextProjection(column: SQLiteColumn): SQL<string> {
  return sql<string>`json(${column})`;
}

/**
 * 启动分页先核对 BLOB 与严格 JSONB，再安全投影正文；非法值返回 null，避免
 * `json()` 抢先抛出没有表、主键和字段路径的 SQLite 底层错误。
 */
export function guardedStrictJsonbTextProjection(
  column: SQLiteColumn
): SQL<string | null> {
  const validationFlag: number = IDENTITY_DATABASE_JSONB_STRICT_VALIDATION_FLAG;
  return sql<string | null>`CASE
    WHEN typeof(${column}) = 'blob' AND json_valid(${column}, ${validationFlag}) = 1
    THEN json(${column})
    ELSE NULL
  END`;
}

/** 返回 SQLite 实际保存某行 data 的存储类，供 JSONB 存储检查使用。 */
export function jsonbStorageClass(column: SQLiteColumn): SQL<string> {
  return sql<string>`typeof(${column})`;
}
