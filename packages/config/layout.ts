/**
 * 部署配置目录布局的严格检查；安装器与启动总闸共用，只 lstat/stat 目录项，不读取文件内容。
 *
 * 配置根顶层只放 static/ 与 dynamic/：static/ 下是修改后须重启的 bot.json、g-auth.json，
 * dynamic/ 下是热重载即时生效的六份文件（见 config/reload.ts）。任一份部署文件出现在
 * 配置根顶层或另一子目录都是放错位置，按致命错误拒绝，不猜测哪一份才是部署方想要的。
 */

import { lstat, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { LEGACY_BOT_CONFIG_NAME } from "../consts/bot";
import {
  AD_SAMPLES_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  ASSETS_CONFIG_PATH,
  BOT_CONFIG_PATH,
  CONFIG_ROOT,
  CRON_CONFIG_PATH,
  DYNAMIC_CONFIG_DIR,
  GOOGLE_AUTH_FILE_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
} from "../consts/paths";
import { DYNAMIC_CONFIG_DIR_NAME, STATIC_CONFIG_DIR_NAME } from "../consts/configLayout";
import { isErrno } from "../libs/errno";
import { invalidInput } from "../libs/inputValidation";

/** 一份部署文件的文件名、所属子目录，以及它不得出现的另一子目录。 */
interface ConfigFilePlacement {
  readonly name: string;
  readonly directory: string;
  readonly otherDirectory: string;
}

/** 按部署文件路径常量派生的归属表；顺序即拒绝顺序。 */
const CONFIG_FILE_PLACEMENTS: readonly ConfigFilePlacement[] = [
  ...[BOT_CONFIG_PATH, GOOGLE_AUTH_FILE_PATH].map((path: string): ConfigFilePlacement => ({
    name: basename(path),
    directory: STATIC_CONFIG_DIR_NAME,
    otherDirectory: DYNAMIC_CONFIG_DIR_NAME,
  })),
  ...[
    AGENT_CONFIG_PATH,
    ASSETS_CONFIG_PATH,
    AD_SAMPLES_CONFIG_PATH,
    MOOD_CONFIG_PATH,
    STICKERS_CONFIG_PATH,
    CRON_CONFIG_PATH,
  ].map((path: string): ConfigFilePlacement => ({
    name: basename(path),
    directory: DYNAMIC_CONFIG_DIR_NAME,
    otherDirectory: STATIC_CONFIG_DIR_NAME,
  })),
];

/**
 * 目录项存在即拒绝，包含悬空链接与目录；只有 ENOENT 与 ENOTDIR（上级不是目录，条目
 * 不可能存在）算不存在，其余读取失败按非法处理。
 */
async function assertEntryAbsent(path: string, expected: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error: unknown) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR")) return;
  }
  return invalidInput(path, "$", expected);
}

/**
 * 拒绝放错位置的部署文件：配置根顶层的旧 Bot 入口，以及每份部署文件在配置根顶层或
 * 另一子目录下的同名项。配置根或子目录不存在时视为没有放错；安装器在建立子目录与
 * 示例文件之前调用。
 */
export async function assertNoMisplacedConfigFiles(root: string): Promise<void> {
  await assertEntryAbsent(join(root, LEGACY_BOT_CONFIG_NAME), "absent after explicit cold migration to bot.json");
  for (const placement of CONFIG_FILE_PLACEMENTS) {
    const expected: string = `absent; ${placement.name} belongs in ${placement.directory}/`;
    await assertEntryAbsent(join(root, placement.name), expected);
    await assertEntryAbsent(join(root, placement.otherDirectory, placement.name), expected);
  }
}

/**
 * 启动总闸的布局检查：先拒绝放错位置的文件，再要求 dynamic/ 是已存在的目录（可为空），
 * 热重载监听才有目录可挂。在读取 bot.json 之前调用。
 */
export async function assertDeploymentConfigLayout(): Promise<void> {
  await assertNoMisplacedConfigFiles(CONFIG_ROOT);
  try {
    if ((await stat(DYNAMIC_CONFIG_DIR)).isDirectory()) return;
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) return invalidInput(DYNAMIC_CONFIG_DIR, "$", "an accessible directory");
  }
  return invalidInput(DYNAMIC_CONFIG_DIR, "$", "an existing directory");
}
