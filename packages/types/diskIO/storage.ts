import type { PendingBlockedRemoval } from "../blocklist";
import type { BLOCKLIST_REMOVAL_OUTBOX_VERSION } from "../../consts/antiRaid/blocklist";

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

/**
 * 追加型 JSON 对象文件的游标状态：size 是物理字节数，empty 表示顶层对象里
 * 还没有任何条目（决定下一次写入是整份原子重写还是按位置追加）。
 */
export interface AppendOnlyFileState {
  size: number;
  empty: boolean;
}

/** 当前按日追加目标文件的游标状态；day 同时决定文件名 `<day>.json`。 */
export interface DayFileState extends AppendOnlyFileState {
  day: string;
}

/** 黑名单文件里单个用户的记录，见 workers/diskIO/blocklistFile.ts。 */
export interface BlockedUserRecord {
  /** 恒为 true：解除拉黑是 /unblock 把条目整条删掉后全量重写，不写 false 记录（见 04-invariants.md）。 */
  isBlocked: true;
  /** 拉黑时刻的东京时间「YYYY/MM/DD HH:mm:ss」，与 libs/time.ts 的 formatTokyoTime 同形态。 */
  blockedAt: string;
}

/** memory/blocklist-removals.json 的当前 schema。 */
export interface BlocklistRemovalOutboxFile {
  version: typeof BLOCKLIST_REMOVAL_OUTBOX_VERSION;
  entries: PendingBlockedRemoval[];
}
