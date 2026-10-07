/** owner: main。 */

/**
 * 广告判定回投后，主线程侧后台任务的在途集合（owner 是 packages/antiRaid/adDetect.ts 的
 * handleAdDetected 与 handleAdVerdictTrue）。
 *
 * 命中处置是「拉黑落盘 + 为每个管理群登记一批封禁」，两步在同一 SQLite
 * 数据库中各自等待事务 ACK；ad=true 判定另登记一项临时广告免检累计清零任务。
 * 集合用于停机 drain：drainAntiRaid 等这些任务结算（见 docs/cn/04-invariants.md）。
 * 每项在结算时自行摘除，容量等于同时在途的判定回投任务数。
 * 进程重启后集合为空，业务真相由已提交的 SQLite 事务 ACK 保持。
 */
export const inFlightAdDisposals: Set<Promise<void>> = new Set<Promise<void>>();
