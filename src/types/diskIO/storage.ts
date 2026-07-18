/** 单条抽签结果的落盘/缓存形状。 */
export interface LuckDrawRecord {
  label: string;
  fortunePercent: number;
}

/** 当天的运势缓存；entries 在内存中使用 Map。 */
export interface LuckDayCache {
  day: string;
  entries: Map<string, LuckDrawRecord>;
}

/** memory/luck/receipt-secret.json 的当前 schema。 */
export interface LuckReceiptSecret {
  version: 1;
  day: string;
  key: string;
}

/** 一条尚未追加落盘的运势记录。 */
export interface LuckPendingEntry {
  key: string;
  record: LuckDrawRecord;
}

/** 当前按日追加目标文件的游标状态。 */
export interface DayFileState {
  day: string;
  size: number;
  empty: boolean;
}

/** memory/luck/YYYY-MM-DD.json 的扁平落盘结构。 */
export type LuckDayFile = Record<string, LuckDrawRecord>;
