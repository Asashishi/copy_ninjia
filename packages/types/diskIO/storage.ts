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

/** 入群日志中的单个成员记录；只保存批量清理所需的最小事实。 */
export interface JoinLogRecord {
  userId: number;
  /** Telegram `chat_member` update.date 换算后的 Unix 毫秒时间戳。 */
  joinedAt: number;
}

/** 一条尚未刷盘的日志序列化文本及其东京日期。 */
export interface BufferedLogEntry {
  day: string;
  text: string;
}

/** 一条尚未刷盘的入群事实及其目标文件。序列化只在 flush 确认仍为最新值后执行。 */
export interface BufferedJoinLogEntry {
  chatId: number;
  day: string;
  record: JoinLogRecord;
}

/**
 * 一个群日入群文件的追加游标与逻辑索引。latestByUser 是该文件的权威折叠视图：
 * 精确重投或晚到的旧事件据此在写盘前丢弃，Worker 重建时从文件严格恢复。
 */
export interface JoinLogFileCache {
  state: AppendOnlyFileState;
  latestByUser: Map<number, JoinLogRecord>;
  /** latestByUser 按标准快照格式写出后的准确 UTF-8 字节数。 */
  snapshotBytes: number;
  /** 上次评估压缩后新追加的物理字节，用于把整文件序列化成本摊薄。 */
  appendedBytesSinceCompaction: number;
  /** 当前文件中确定已被更新值取代的物理历史条目数。 */
  redundantEntries: number;
  /** 本群日本代际是否已经记录过容量降级，避免每条事件重复刷控制台。 */
  capacityWarningEmitted: boolean;
}

/** 当前按日追加目标文件的游标状态；day 同时决定文件名 `<day>.json`。 */
export interface DayFileState extends AppendOnlyFileState {
  day: string;
}
