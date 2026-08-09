/**
 * Disk I/O 故障的非递归最终诊断出口。该边界不能调用 logger，否则 logger 会把
 * 同一错误重新投递给已经故障的 Disk I/O Worker；主线程宿主的直接
 * 控制台输出统一经过此边界。
 */
export function writeDiskIODiagnostic(...values: readonly unknown[]): void {
  console.error(...values);
}
