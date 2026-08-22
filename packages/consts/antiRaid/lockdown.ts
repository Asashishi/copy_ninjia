/** 反刷群私密模式的计数窗口、阈值与恢复策略。 */

/** 滑动计数窗口时长：最近这么长时间内的入群数超过阈值，视为疑似拉人头刷群。 */
export const JOIN_WINDOW_MS: number = 60 * 1000;
/**
 * 滑动窗口内触发私密模式的入群人数上限，超过（第 46 人起）才触发，见
 * workers/antiRaid/lockdownRuntime.ts 的 recordJoin 与待验证成员消息窗口。
 */
export const ANTI_RAID_PER_MINUTE_LIMIT: number = 45;
/**
 * 一轮私密模式（禁止普通成员拉人 + 新入群直接请出）的时长，也是它的**上限**。
 *
 * 恢复时刻在加锁生效那一刻定死：锁定期内再怎么灌人也不会把它推后（见
 * states/lockdown.ts 的 thresholdExceeded）。到点先真的解除——权限还回去、
 * 公告删掉、发解除通知——窗口若仍越过阈值，再由下一条入群开启新的一轮。
 * 反过来做（每次超阈值都把倒计时重排满）会让持续刷群把同一轮无限续期，
 * 群里看到的就是「过了 5 分钟也没解除」，而且不会留下任何错误日志。
 */
export const LOCKDOWN_MS: number = 5 * 60 * 1000;
/** 解除私密模式的 API 调用失败后，重试前的等待时长。 */
export const RESTORE_RETRY_MS: number = 30 * 1000;
/**
 * 一轮私密模式因落盘失败或读取原权限失败作废后，暂停再次触发的冷却时长。
 *
 * 这两类失败对同一个群通常是系统性的（状态无法持久化、机器人在该群读不到
 * 群资料），而触发判定挂在每一条越过阈值的入群上：没有冷却，刷群期间每进
 * 一个人都会重来一次「发封锁公告 + 读权限 + 落盘」，群里刷满公告、Telegram
 * 侧刷满请求，却一次也锁不上。冷却期内入群仍照常计数与逐个验证，只是不再
 * 尝试进入私密模式。所属模块：workers/antiRaid/lockdownRuntime.ts。
 */
export const LOCKDOWN_RETRIGGER_COOLDOWN_MS: number = 5 * 60 * 1000;
