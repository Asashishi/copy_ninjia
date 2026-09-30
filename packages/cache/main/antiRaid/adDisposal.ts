/**
 * 广告判定回投后，主线程侧后台任务的在途集合（owner 是 packages/antiRaid/adDetect.ts 的
 * handleAdDetected 与 handleAdVerdictTrue）。
 *
 * 命中处置本体是「拉黑落盘 + 为每个管理群登记一批封禁」，两步在同一 SQLite
 * 数据库中各自保留事务 ACK，因此进程中途退出不会丢处置；ad=true 判定另登记一项
 * 临时广告免检累计清零任务。这个集合只用于停机 drain——让 drainAntiRaid
 * 等这些任务结算，而不是把它们连同事件一起丢在半路（见 docs/cn/04-invariants.md）。
 * 每项在结算时自行摘除，容量因此等于同时在途的判定回投任务数。
 * 进程重启后集合为空，业务真相仍由已经提交的 SQLite 事务 ACK 保持。
 */
export const inFlightAdDisposals: Set<Promise<void>> = new Set<Promise<void>>();
