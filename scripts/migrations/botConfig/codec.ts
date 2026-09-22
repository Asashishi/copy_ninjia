import { parseBotConfig } from "../../../packages/config/botInput";
import { parseCronConfig } from "../../../packages/config/cron";
import { DEFAULT_BOT_ATMOSPHERE } from "../../../packages/consts/bot";
import { invalidInput } from "../../../packages/libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../../packages/libs/record";
import { decodeStateFile } from "../../../packages/libs/stateFileCodec";

/** 只接受本次迁移的身份配置，校验后原样保留凭据和管理员 ID。 */
export function migrateBotIdentity(value: unknown, path: string): unknown {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["bot_token", "super_admin_user_id"])) {
    return invalidInput(path, "$", "exactly { bot_token, super_admin_user_id } before this migration");
  }
  const converted: Record<string, unknown> = { ...value, atmosphere: DEFAULT_BOT_ATMOSPHERE };
  parseBotConfig(converted, path);
  return converted;
}

/** 仅重命名图库键；新旧并存、已迁移或非法的任一 state 副本均拒绝。 */
export function migrateBotState(value: unknown, path: string): unknown {
  if (isPlainRecord(value) && isPlainRecord(value.global) && isPlainRecord(value.global.assets)) {
    const assets: Record<string, unknown> = value.global.assets;
    if ("randomHImageDir" in assets) {
      return invalidInput(path, "state.global.assets", "the source schema without randomHImageDir");
    }
    if ("randomImageDir" in assets) {
      const { randomImageDir, ...other }: Record<string, unknown> = assets;
      value = { ...value, global: { ...value.global, assets: { ...other, randomHImageDir: randomImageDir } } };
    }
  }
  try {
    decodeStateFile(value);
  } catch {
    return invalidInput(path, "$", "a valid state document with the source randomImageDir asset field");
  }
  return value;
}

/** 固定单图来源转成单元素数组；随机目录和 send_file 保留，并整份严格验证。 */
export function migrateBotCron(value: unknown, path: string): unknown {
  if (Array.isArray(value)) {
    for (let taskIndex: number = 0; taskIndex < value.length; taskIndex++) {
      const task: unknown = value[taskIndex];
      if (!isPlainRecord(task) || !Array.isArray(task.actions)) continue;
      for (let actionIndex: number = 0; actionIndex < task.actions.length; actionIndex++) {
        const action: unknown = task.actions[actionIndex];
        if (!isPlainRecord(action) || action.type !== "send_image" || !isPlainRecord(action.payload)) continue;
        const payload: Record<string, unknown> = action.payload;
        if (payload.rand_image === true) continue;
        for (const key of ["url", "path"]) {
          if (!(key in payload)) continue;
          if (typeof payload[key] !== "string") {
            return invalidInput(path, `$[${taskIndex}].actions[${actionIndex}].payload.${key}`, "a scalar string before this migration");
          }
          payload[key] = [payload[key]];
        }
      }
    }
  }
  parseCronConfig(value, path);
  return value;
}
