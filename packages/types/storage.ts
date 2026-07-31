/** Linux 进程的稳定身份，用于防 PID 复用的实例锁。 */
export interface ProcessIdentity {
  pid: number;
  startTimeTicks: string;
  bootId: string;
}
