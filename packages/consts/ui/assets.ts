/** 部署 UI 素材的内置缺省 URL；运行时由 state.global.assets 逐项覆盖。 */

/** 「未卜先知」Telegram inline 结果的缺省缩略图直链。 */
export const FORTUNE_THUMBNAIL_URL: string =
  "https://drive.google.com/uc?export=view&id=1RMluRcTHBUTqYrkNISoVEZCI84ZQEosA";

/** 「概率论」Telegram inline 结果的缺省缩略图直链。 */
export const PROBABILITY_THUMBNAIL_URL: string =
  "https://drive.google.com/uc?export=view&id=1RMluRcTHBUTqYrkNISoVEZCI84ZQEosA";

/** gag 发言 Telegram inline 结果的缺省缩略图直链。 */
export const GAG_THUMBNAIL_URL: string =
  "https://drive.google.com/uc?export=view&id=1AhvfdbcwQnUBBk86yEafb_G3gZOWXim2";

/** `/icon reset`、`/copy stop` 复原机器人头像时下载的缺省直链。 */
export const BOT_DEFAULT_AVATAR_URL: string =
  "https://drive.google.com/uc?export=download&id=1M72eDI8DLUbL2-SI4lyzZQSXOhfwxBci";

/**
 * `state.global.assets.randomHImageDir` 的缺省值：随机图片（`/h_image`）的来源目录。
 * 写成显式相对路径语法，补写进 state.json 时不留裸目录名；相对路径按运行时数据根解析，
 * 见 infra/storage/stateStore.ts 的 getRandomHImageDirectory；启动时不存在则自动创建。
 */
export const RANDOM_H_IMAGE_DIR: string = "./h_image";
