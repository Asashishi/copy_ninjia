/**
 * config/ 目录最后一次文件事件之后等待多久再读取部署配置，属 app/configReload.ts。
 * 编辑器保存常见「截断再写」「写临时文件再改名」等多步事件，窗口内的事件合并成
 * 一轮读取；窗口内读到的中间态即使解析失败也只会被拒绝，不影响已生效快照。
 */
export const CONFIG_RELOAD_DEBOUNCE_MS: number = 500;
