/** 安装器共用的路径、严格校验和新库初始化入口；二进制发行时单独打包。 */
export { RUNTIME_DATA_ROOT, IDENTITY_DATABASE_PATH } from "../../packages/consts/paths";
export { assertCurrentBotConfigDirectory } from "../../packages/config/botInput";
export { validateAgentDeploymentConfig } from "../../packages/config/agent";
import { parseBotConfig, assertCurrentBotConfigDirectory } from "../../packages/config/botInput";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../../packages/consts/telegram";
import { readJsonInput } from "../../packages/libs/inputValidation";
import { isPlainRecord } from "../../packages/libs/record";
import { dirname } from "node:path";
import type { BotAtmosphere } from "../../packages/types/atmosphere";
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

/** 只严格校验候选文件内容；部署目录的旧入口由安装准备与启动总闸检查。 */
export async function validateStagedBotConfig(path: string): Promise<void> {
  parseBotConfig(await readJsonInput(path), path);
}

/** 问卷开始前校验既有 Bot 字段；仅示例 token 允许等待本次填写，风格原样保留。 */
export async function loadInstallerBotAtmosphere(path: string): Promise<BotAtmosphere> {
  await assertCurrentBotConfigDirectory(dirname(path));
  const value: unknown = await readJsonInput(path);
  const candidate: unknown = isPlainRecord(value) && typeof value.bot_token === "string" &&
    value.bot_token.trim() === TELEGRAM_BOT_TOKEN_PLACEHOLDER
    ? { ...value, bot_token: "installer-initial-identity" }
    : value;
  return parseBotConfig(candidate, path).atmosphere;
}
