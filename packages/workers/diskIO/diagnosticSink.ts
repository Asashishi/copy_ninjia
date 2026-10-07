/**
 * Disk I/O 故障的非递归最终诊断出口：不经 logger，直接写控制台；主线程宿主的
 * 直接控制台输出统一经过此边界。
 *
 * 本模块是 `packages/infra/` 唯一可以静态依赖的 `packages/workers/` 模块，自身没有
 * 任何依赖；它位于 `packages/workers/diskIO/`，即 AGENTS.md 划定的允许直接
 * console.error 的边界内。豁免登记在
 * scripts/conventions/moduleBoundaries.ts 的 INFRA_LAYERING_EXEMPTIONS。
 */
export function writeDiskIODiagnostic(...values: readonly unknown[]): void {
  console.error(...values);
}
