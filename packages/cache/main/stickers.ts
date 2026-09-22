/** owner 为主线程；贴纸目录落盘回执与重建重放的进程内状态。 */

/** 每个未确认包的最新编号；发布时覆盖，匹配 durable 回执时删除。
 * 容量为当前配置包及仍待落盘的历史包；Disk I/O 重建时与目录镜像一同重放。
 * 缺失表示没有待确认写入，已退出配置的镜像可以释放。 */
export const pendingStickerCatalogRevisions: Map<string, number> = new Map();

/** 全进程递增编号，重加同包时不复用旧回执；进程退出释放，Worker 重建不重置。 */
export const stickerCatalogRevisionCounter: { current: number } = { current: 0 };
