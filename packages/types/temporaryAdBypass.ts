/** 临时广告免检累计记录；时间列均为 Unix epoch 毫秒。 */
export interface TemporaryAdBypassActivity {
  /** 当天或刚结束的合格东京日仍授予临时广告免检时为 true。 */
  readonly adBypass: boolean;
  /** 首次进入临时广告免检的时刻。 */
  readonly adBypassGrantedAt: number | null;
  /** 当前连续合格东京日数量；上一日未达标时随新累计归零。 */
  readonly qualifiedDays: number;
  readonly sendCount: number;
  readonly countedAt: number;
  /** 当前东京日已计入连续合格日时的首个达标时刻；当天尚未达标时为 null。 */
  readonly qualifiedAt: number | null;
}

/** SQLite 临时广告免检表的一行；用户与频道共用 Telegram 身份主键。 */
export interface StoredTemporaryAdBypassActivity extends TemporaryAdBypassActivity {
  readonly id: number;
}

/** 主线程保留到 SQLite 精确 revision ACK 的临时广告免检最终值。 */
export interface UnacknowledgedTemporaryAdBypassWrite {
  readonly activity: Readonly<TemporaryAdBypassActivity> | null;
  readonly revision: number;
}

/** Disk I/O Worker 同一身份在事务提交前合并的临时广告免检最终值。 */
export interface PendingTemporaryAdBypassWrite {
  readonly activity: Readonly<TemporaryAdBypassActivity> | null;
  readonly revision: number;
}

/** 主线程计入一条发言后的 write-through 最终值与 Worker 接收结果。 */
export interface RecordedTemporaryAdBypassActivity {
  readonly activity: Readonly<TemporaryAdBypassActivity>;
  readonly queued: boolean;
}
