/**
 * 部署配置根下两个子目录的名称；纯字面量、不读环境变量，测试 preload 可在路径注入前导入。
 * 目录路径由 consts/paths.ts 拼出，布局检查见 config/layout.ts。
 */

/** 只在启动时读取、修改后须重启才生效的部署配置子目录名（bot.json、g-auth.json）。 */
export const STATIC_CONFIG_DIR_NAME: string = "static";
/** 由 app/configReload.ts 监听、修改后热重载即时生效的部署配置子目录名（其余六份）。 */
export const DYNAMIC_CONFIG_DIR_NAME: string = "dynamic";
