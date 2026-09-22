/**
 * Disk I/O 故障的非递归最终诊断出口。该边界不能调用 logger，否则 logger 会把
 * 同一错误重新投递给已经故障的 Disk I/O Worker；主线程宿主的直接
 * 控制台输出统一经过此边界。
 *
 * 本模块是 `packages/infra/` 唯一可以静态依赖的 `packages/workers/` 模块：它自己
 * 没有任何依赖，放在这个目录只是因为 AGENTS.md 把「允许直接 console.error」的边界
 * 划在 `packages/workers/diskIO/`。豁免登记在
 * scripts/conventions/moduleBoundaries.ts 的 INFRA_LAYERING_EXEMPTIONS。
 */
export function writeDiskIODiagnostic(...values: readonly unknown[]): void {
  console.error(...values);
}
