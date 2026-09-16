/** 安装器共用的路径、严格校验和新库初始化入口；二进制发行时单独打包。 */
export { RUNTIME_DATA_ROOT, IDENTITY_DATABASE_PATH } from "../../packages/consts/paths";
export { loadTelegramConfig } from "../../packages/config/telegramInput";
export { validateAgentDeploymentConfig } from "../../packages/config/agent";
import type * as Readiness from "../../packages/config/readiness";
export { createStorageDatabase } from "../../packages/database/interact/migration";
export {
  closeStorageDatabase,
  enableStorageDatabaseWal,
  openStorageDatabase,
} from "../../packages/database/interact/connection";
export { initializeStorageDatabase } from "../../packages/database/interact/initialization";

/** 完成问卷和新库初始化后才加载启动总闸，避免路径解析阶段读取尚未填写的配置。 */
export async function validateExistingDeploymentInputs(): Promise<void> {
  const readiness: typeof Readiness = await import("../../packages/config/readiness");
  await readiness.validateExistingDeploymentInputs();
}
