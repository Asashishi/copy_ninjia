/**
 * config/dynamic/ 目录最后一次文件事件之后等待多久再读取部署配置，属 app/configReload.ts。
 * 编辑器保存常见「截断再写」「写临时文件再改名」等多步事件，窗口内的事件合并成
 * 一轮读取；窗口内读到的中间态即使解析失败也只会被拒绝，不影响已生效快照。
 */
export const CONFIG_RELOAD_DEBOUNCE_MS: number = 500;
/**
 * config/dynamic/ 目录自身被改名、删除或整体替换后重新建立监听的退避序列，属
 * app/configReload.ts。首次重建在一个 CONFIG_RELOAD_DEBOUNCE_MS 窗口之后；目录仍不存在时
 * 依次按本表等待，用完后一直按最后一项重试，直到目录恢复或停机关闸。
 */
export const CONFIG_RELOAD_REWATCH_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000];
