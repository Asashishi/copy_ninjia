import type { TemporaryAdBypassActivity } from "./states/temporaryAdBypass";

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
