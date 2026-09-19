import type { ConfigReadinessCache } from "../../types/config";

/**
 * 按功能聚合的部署配置可用性结论（packages/config/readiness.ts）的内存状态。
 *
 * 与 cache/perThread/config.ts 那四份 loader 单例分开：那四份是「文件解出来的
 * 内容」、谁读谁缓存，这三条是「这个功能此刻能不能开」的结论，只有主线程问得到
 * ——判定挂在 `/ai_chat enable`、`/ad_detect enable`、翻译开关与启动前置
 * 核对上，全都是主线程的命令与生命周期路径。
 * 每条都是单个结论对象，只整体替换、不淘汰；进程重启恢复为 null。
 */

/**
 * AI 闲聊部署配置的可用性结论。**失败结论同样缓存**：这道判定挂在
 * /ai_chat enable 与投喂门禁上，不缓存失败等于每条群消息一次读盘。
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
