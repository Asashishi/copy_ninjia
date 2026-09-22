/**
 * 临时广告免检状态机（packages/states/temporaryAdBypass.ts）的状态契约。
 */

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
