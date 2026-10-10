import { resolve } from "node:path";
import { RUNTIME_DATA_ROOT } from "../paths";
import type { AssetConfig } from "../../types/config";

/** 部署 UI 素材的内置缺省值；config/dynamic/assets.json 的 `onlyPath`、`pathOrUrl`、`onlyUrl` 各组逐项覆盖，见 packages/config/assets.ts。 */

/** 「未卜先知」Telegram inline 结果的缺省缩略图直链。 */
export const FORTUNE_THUMBNAIL_URL: string =
  "https://drive.google.com/uc?export=view&id=1RMluRcTHBUTqYrkNISoVEZCI84ZQEosA";

/** 「概率论」Telegram inline 结果的缺省缩略图直链。 */
export const PROBABILITY_THUMBNAIL_URL: string =
  "https://drive.google.com/uc?export=view&id=1RMluRcTHBUTqYrkNISoVEZCI84ZQEosA";

/** gag 发言 Telegram inline 结果的缺省缩略图直链。 */
export const GAG_THUMBNAIL_URL: string =
  "https://drive.google.com/uc?export=view&id=1AhvfdbcwQnUBBk86yEafb_G3gZOWXim2";

/** `/icon reset`、`/copy stop` 复原机器人头像时下载的缺省直链（DEFAULT_ASSET_CONFIG 以 url 来源引用）。 */
export const BOT_DEFAULT_AVATAR_URL: string =
  "https://drive.google.com/uc?export=download&id=1Wqxii-o6O36ZDWhM1L0BcZPGBFmpvalg";

/**
 * `onlyPath.random_h_image_dir` 的缺省值：随机图片（`/h_image`）的来源目录。相对路径按运行时
 * 数据根解析；启动时或热重载切换目录时不存在则自动创建。
 */
export const RANDOM_H_IMAGE_DIR: string = "./h_image";

/**
 * config/dynamic/assets.json 顶层分组名：组内字段只能写本机路径（绝对路径或 `./`、`../` 开头的
 * 相对路径，相对路径按运行时数据根解析）。所属模块：部署素材配置（packages/config/assets.ts）。
 */
export const ASSET_ONLY_PATH_GROUP: string = "onlyPath";

/** config/dynamic/assets.json 顶层分组名：组内字段可写本机路径或 http(s) 直链。所属模块：部署素材配置。 */
export const ASSET_PATH_OR_URL_GROUP: string = "pathOrUrl";

/** config/dynamic/assets.json 顶层分组名：组内字段只能写 https 直链。所属模块：部署素材配置。 */
export const ASSET_ONLY_URL_GROUP: string = "onlyUrl";

/** config/dynamic/assets.json 顶层允许出现的全部分组；所属模块：部署素材配置。 */
export const ASSET_CONFIG_GROUPS: ReadonlySet<string> = new Set([
  ASSET_ONLY_PATH_GROUP,
  ASSET_PATH_OR_URL_GROUP,
  ASSET_ONLY_URL_GROUP,
]);

/** `onlyPath` 组允许出现的全部字段；所属模块：部署素材配置。 */
export const ASSET_ONLY_PATH_KEYS: ReadonlySet<string> = new Set([
  "random_h_image_dir",
]);

/** `pathOrUrl` 组允许出现的全部字段；所属模块：部署素材配置。 */
export const ASSET_PATH_OR_URL_KEYS: ReadonlySet<string> = new Set([
  "bot_default_avatar",
]);

/** `onlyUrl` 组允许出现的全部字段；所属模块：部署素材配置。 */
export const ASSET_ONLY_URL_KEYS: ReadonlySet<string> = new Set([
  "fortune_thumbnail_url",
  "probability_thumbnail_url",
  "gag_thumbnail_url",
]);

/** `random_h_image_dir` 在 assets.json 里的字段路径；素材解析与图库目录准备（infra/randomImage.ts）的诊断共用。 */
export const RANDOM_H_IMAGE_DIR_FIELD: string = `$.${ASSET_ONLY_PATH_GROUP}.random_h_image_dir`;

/** `bot_default_avatar` 在 assets.json 里的字段路径；素材解析与本机头像文件核对的诊断共用。 */
export const BOT_DEFAULT_AVATAR_FIELD: string = `$.${ASSET_PATH_OR_URL_GROUP}.bot_default_avatar`;

/**
 * config/dynamic/assets.json 缺省或字段缺省时生效的素材配置；也是主线程素材 holder
 * （cache/main/assets.ts）的初值。所属模块：部署素材配置。
 */
export const DEFAULT_ASSET_CONFIG: Readonly<AssetConfig> = {
  randomHImageDirectory: resolve(RUNTIME_DATA_ROOT, RANDOM_H_IMAGE_DIR),
  fortuneThumbnailUrl: FORTUNE_THUMBNAIL_URL,
  probabilityThumbnailUrl: PROBABILITY_THUMBNAIL_URL,
  gagThumbnailUrl: GAG_THUMBNAIL_URL,
  botDefaultAvatar: { kind: "url", url: BOT_DEFAULT_AVATAR_URL },
};
