/** 临时白名单累计记录；时间列均为 Unix epoch 毫秒。 */
export interface TemporaryWhitelistActivity {
  /** 首个合格日后为 true，直到显式删除或晋升永久广告免检。 */
  readonly tempWhite: boolean;
  /** 首次进入临时广告免检的时刻。 */
  readonly tempWhiteAt: number | null;
  /** 当前连续合格东京日数量；临时成员断签后允许归零。 */
  readonly tempWhiteCount: number;
  readonly sendCount: number;
  readonly countedAt: number;
  /** 当前东京日已计入连续合格日时的首个达标时刻；当天尚未达标时为 null。 */
  readonly qualifiedAt: number | null;
}

/** SQLite 临时白名单表的一行；用户与频道共用 Telegram 身份主键。 */
export interface StoredTemporaryWhitelistActivity extends TemporaryWhitelistActivity {
  readonly id: number;
}

/** 主线程保留到 SQLite 精确 revision ACK 的临时白名单最终值。 */
export interface UnacknowledgedTemporaryWhitelistWrite {
  readonly activity: Readonly<TemporaryWhitelistActivity> | null;
  readonly revision: number;
}

/** Disk I/O Worker 同一身份在事务提交前合并的临时白名单最终值。 */
export interface PendingTemporaryWhitelistWrite {
  readonly activity: Readonly<TemporaryWhitelistActivity> | null;
  readonly revision: number;
}

/** 主线程计入一条发言后的 write-through 最终值与 Worker 接收结果。 */
export interface RecordedTemporaryWhitelistActivity {
  readonly activity: Readonly<TemporaryWhitelistActivity>;
  readonly queued: boolean;
}
