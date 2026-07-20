/** 运势命令使用的持久化窄边界，避免调用方依赖完整 Disk I/O 宿主。 */
export { ensureLuckReceiptSecret, onDiskIORespawn, postDiskIO } from "../../infra/diskIO";
