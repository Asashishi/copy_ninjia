/** Telegram 客户端初始化（packages/infra/telegram/client.ts）的内存状态。 */

/**
 * 当前 isolate 的 Telegram 客户端 transformer 安装状态。首次显式初始化后
 * 置 true；客户端与 isolate 同寿命，无需运行期清空，Worker 重建时自然回到 false。
 */
export const telegramClientInitialization: { current: boolean } = { current: false };
