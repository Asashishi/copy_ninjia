import type { ConfigReadinessCache } from "../../types/config";

/**
 * owner: main。按功能聚合的部署配置可用性结论，供 packages/config/readiness.ts 使用。
 *
 * cache/perThread/config.ts 持有解析后的配置快照，Worker 只接管主线程投递的副本。
 * 本模块持有 AI 闲聊、广告检测与翻译三个功能的可用性结论，供主线程的命令、
 * 消息准入与生命周期路径读取；跨线程边界见 docs/cn/04-invariants.md。
 * 容量固定为三个 holder，各持有一个结论对象，只整体替换、不淘汰；进程重启恢复为 null。
 */

/**
 * AI 闲聊部署配置的可用性结论。**失败结论同样写入本缓存**，与成功结论一样只由
 * 下方替换时机整体覆盖，不留空表示「还没判定过」。
 *
 * 填充：启动总闸（config/readiness.ts 的 validateExistingDeploymentInputs）。
 * 替换：config/ 热重载每轮按 holder 重算，可用性或失败文件变化时由
 * app/configReload.ts 经 adoptAiChatConfigReadiness 整体替换；转为可用时先完成
 * AI Worker 恢复再发布。清理：无，进程重启恢复为 null（null 按「启动预检未完成」
 * 判不可用）。只在主线程，Worker 崩溃不影响。
 */
export const aiChatConfigReadinessCache: ConfigReadinessCache = { current: null };
/** 广告检测部署配置的可用性结论；填充、替换与清理同 aiChatConfigReadinessCache（经 adoptAdDetectConfigReadiness）。 */
export const adDetectConfigReadinessCache: ConfigReadinessCache = { current: null };
/** 翻译服务账号密钥（g-auth.json）的可用性结论；只由启动总闸填充，g-auth.json 不热重载，修好须重启。 */
export const translateConfigReadinessCache: ConfigReadinessCache = { current: null };
