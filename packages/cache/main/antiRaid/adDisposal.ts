/**
 * 广告判定命中后，主线程侧处置任务的在途集合（owner 是
 * packages/antiRaid/adCandidate.ts）。
 *
 * 处置本体是「拉黑落盘 + 为每个管理群登记一批封禁」，两步都各自 durable：
 * 名单进 memory/blocklist/blocklist.json，封禁批次进 memory/blocklist/removals.json，
 * 因此进程中途退出不会丢处置。这个集合只用于停机 drain——让 drainAntiRaid
 * 等这些任务结算，而不是把它们连同事件一起丢在半路（见 docs/cn/04-invariants.md）。
 * 每项在结算时自行摘除，容量因此等于同时在途的判定命中数。
 */
export const inFlightAdDisposals: Set<Promise<void>> = new Set<Promise<void>>();
