import type { ConfigReadinessCache } from "../../types/config";

/**
 * 按功能聚合的部署配置可用性结论（packages/config/readiness.ts）的内存状态。
 *
 * 与 cache/perThread/config.ts 那四份 loader 单例分开：那四份是「文件解出来的
 * 内容」、谁读谁缓存，这三条是「这个功能此刻能不能开」的结论，只有主线程问得到
 * ——判定挂在 `/ai_chat enable`、`/ad_detect enable`、日语翻译开关与启动前置
 * 核对上，全都是主线程的命令与生命周期路径。
 * 同一进程不清除也不淘汰成功或失败结论；只有进程重启才恢复为 null。
 */

/**
 * AI 闲聊三份部署配置的可用性结论；首次判定填充，此后不再读盘。**失败结论
 * 同样缓存**：这道判定挂在 /ai_chat enable 与投喂门禁上，不缓存失败等于每条
 * 群消息一次 readFileSync。修好文件需要重启才生效，与底层 loader 的单例语义一致。
 */
export const aiChatConfigReadinessCache: ConfigReadinessCache = { current: null };
/** 广告示例配置的可用性结论；语义同 aiChatConfigReadinessCache。 */
export const adDetectConfigReadinessCache: ConfigReadinessCache = { current: null };
/** 日语翻译服务账号密钥（g-auth.json）的可用性结论；语义同上。 */
export const jaTranslateConfigReadinessCache: ConfigReadinessCache = { current: null };
