import type { LockdownEffect } from "../../types/states/lockdown";

/** 反刷群私密模式的计数窗口、阈值与恢复策略。 */

/**
 * 状态不变或无需副作用的私密模式转移共用的空效果表；只读，任何转移都不得向它追加。
 * 所属模块：states/lockdown/。
 */
export const NO_LOCKDOWN_EFFECTS: readonly LockdownEffect[] = [];

/** 滑动计数窗口时长：最近这么长时间内的入群数超过阈值，视为疑似拉人头刷群。 */
export const JOIN_WINDOW_MS: number = 60 * 1000;
/**
 * 滑动窗口内触发私密模式的入群人数上限，超过（第 46 人起）才触发，见
 * workers/antiRaid/lockdownJoinWindow.ts 的 recordJoinWindow 与 states/verification/pending.ts
 * 的 handleTrackedMessage（待验证成员消息窗口）。
 */
export const ANTI_RAID_PER_MINUTE_LIMIT: number = 45;
/**
 * 入群滑窗保留的时间戳硬上限：阈值外多留一项即可证明窗口已经越界。
 * 超出部分由 JoinWindow 的 overflowThrough 以保守饱和语义表示。
 */
export const JOIN_WINDOW_CAPACITY: number = ANTI_RAID_PER_MINUTE_LIMIT + 1;
/**
 * 一轮私密模式（禁止普通成员拉人 + 新入群直接请出）的时长，也是它的**上限**。
 *
 * 恢复时刻在加锁生效那一刻定死：锁定期内再怎么灌人也不会把它推后（见
 * states/lockdown/apply.ts 的 handleThresholdExceeded）。到点先真的解除——权限还回去、
 * 公告删掉、发解除通知——窗口若仍越过阈值，再由下一条入群开启新的一轮。
 * 反过来做（每次超阈值都把倒计时重排满）会让持续刷群把同一轮无限续期，
 * 群里看到的就是「过了 5 分钟也没解除」，而且不会留下任何错误日志。
 */
export const LOCKDOWN_MS: number = 5 * 60 * 1000;
/** 解除私密模式的 API 调用失败后，重试前的等待时长。 */
export const RESTORE_RETRY_MS: number = 30 * 1000;
/**
 * 解除私密模式连续因权限被拒（被移出群、被撤管理员）失败多少次之内照常记错误、按
 * RESTORE_RETRY_MS 重试；超过后降为 warn，重试间隔从 RESTORE_RETRY_MS 起翻倍、以
 * RESTORE_PERMANENT_RETRY_MAX_MS 封顶。私密模式记录照旧保留，机器人重新获得限制成员权限时
 * 立即重试。所属模块：workers/antiRaid/lockdownApi.ts 与 lockdownRuntime.ts。
 */
export const RESTORE_PERMANENT_FAILURE_LOG_LIMIT: number = 3;
/** 权限被拒的解除重试退避上限；见 RESTORE_PERMANENT_FAILURE_LOG_LIMIT。 */
export const RESTORE_PERMANENT_RETRY_MAX_MS: number = 30 * 60 * 1000;
/**
 * 一轮私密模式因落盘失败或读取原权限失败作废后，暂停再次触发的冷却时长。
 *
 * 这两类失败对同一个群通常是系统性的（状态无法持久化、机器人在该群读不到
 * 群资料），而触发判定挂在每一条越过阈值的入群上：没有冷却，刷群期间每进
 * 一个人都会重来一次「发封锁公告 + 读权限 + 落盘」，群里刷满公告、Telegram
 * 侧刷满请求，却一次也锁不上。冷却期内入群仍照常计数与逐个验证，只是不再
 * 尝试进入私密模式。所属模块：states/lockdown/shared.ts；冷却写入在
 * workers/antiRaid/lockdownJoinWindow.ts。
 */
export const LOCKDOWN_RETRIGGER_COOLDOWN_MS: number = 5 * 60 * 1000;
