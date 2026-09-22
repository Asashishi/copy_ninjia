import type {
  AdDetectAgentConfig,
  AdSampleConfig,
  AgentDeploymentConfig,
  MoodConfig,
  StickerConfig,
  BotConfig,
} from "../../types/config";

/**
 * 部署配置快照的线程内 holder：defaultMoodConfigCache 属 packages/config/mood.ts、
 * defaultStickerConfigCache 属 packages/config/stickers.ts、defaultAdSampleConfigCache
 * 属 packages/config/adSamples.ts、personaCache 属 packages/config/persona.ts、
 * botConfigCache 属 packages/config/bot.ts；adDetectAgentConfigCache 与
 * agentDeploymentConfigCache 属 packages/config/agent.ts，同一份文件的两段各缓存
 * 各的。
 *
 * perThread：主线程在启动总闸严格解析后填充权威快照；AI 闲聊 Worker（agent 对话
 * 段、心情、贴纸、人设）与 Anti-Raid Worker（ad_detect 段、广告示例）只 adopt 主
 * 线程投递的副本，自己从不读这些文件。ad_samples.json、agent.json、mood.json 与
 * stickers.json 由主线程热重载（config/reload.ts）整体替换（文件删除时换成 null）后，
 * 再经消息投给持有副本的 Worker；Worker 崩溃重建时重放主线程当前快照。每个 holder
 * 恒为一个对象或 null，只整体替换、绝不就地改写——logger 的凭据脱敏按对象身份判断
 * 是否重算。
 *
 * 按功能聚合的可用性结论只有主线程用，因此不在这里，见
 * cache/main/configReadiness.ts。
 */

/**
 * 默认心情配置快照。主线程由启动总闸填充、热重载整体替换；AI 闲聊 Worker 由
 * init 与 configReload 消息填充。自定义路径加载不进入缓存。
 */
export const defaultMoodConfigCache: { current: MoodConfig | null } = { current: null };
/** 默认贴纸配置快照；填充与替换时机同 defaultMoodConfigCache。 */
export const defaultStickerConfigCache: { current: StickerConfig | null } = { current: null };
/**
 * 默认广告示例配置快照。主线程由启动总闸填充、热重载整体替换；Anti-Raid Worker
 * 由 agentConfig 消息填充。
 */
export const defaultAdSampleConfigCache: { current: AdSampleConfig | null } = { current: null };
/** persona.md 的单份文本快照；主线程启动总闸填充，AI Worker 由 init 消息填充，不热重载。 */
export const personaCache: { current: string | null } = { current: null };

/**
 * config/bot.json 的主线程只读快照；Bot 配置模块启动时读盘填充，进程重启后重建。
 * Worker 不加载 Bot 配置，本 holder 保持 null；通知风格随初始化载荷单独注入。
 * 不热重载，容量至多一个对象且无需淘汰；线程边界见 docs/cn/04-invariants.md。
 */
export const botConfigCache: { current: BotConfig | null } = { current: null };

/**
 * config/agent.json 的 **agent.ad_detect 能力**快照；主线程权威值的本线程副本。
 *
 * 填充时机按线程分两路：
 * - 主线程：启动总闸 validateAgentDeploymentConfig 解析成功后写入；文件在但没有
 *   ad_detect 段时显式写 null。热重载（config/reload.ts）按本轮读到的内容整体
 *   替换，段或文件被删除时写 null，补上时写新快照。
 * - Anti-Raid Worker：主线程 agentConfig 消息到达时 adopt 写入（含显式 null）；
 *   初始化、热重载与 Worker 崩溃重建各投递一次主线程当前快照，绝不自己读盘。
 *
 * 因此 null 一律读作「这个部署没配广告检测」，判定侧 fail-closed，不得回填默认值。
 * 两段各一个 holder 而不是整份文件一个：探哪一段、运行时就只读哪一段，否则
 * 「通过启动门禁的配置」与「跑得起来的配置」是两个集合。容量恒为一个对象。
 *
 * logger 的值级脱敏逐条日志读取本 holder（见 infra/logger/serialization.ts 的 currentSecrets），
 * 因此它必须在**每条**持有该凭据的线程里都有一份，不能收进某个 owner 目录。
 */
export const adDetectAgentConfigCache: { current: AdDetectAgentConfig | null } = { current: null };

/**
 * config/agent.json 的 **AI 对话能力段**快照；分段理由与填充口径同上。
 *
 * 主线程由启动总闸填充、热重载整体替换；AI 闲聊 Worker 由 init 与 configReload
 * 消息 adopt 填充，崩溃重建时由 lastInitState 重放主线程当前快照。回复、总结、
 * 读图、生图、生歌逐轮取模型名与凭据都只读这里，Worker 从不碰磁盘。
 */
export const agentDeploymentConfigCache: { current: AgentDeploymentConfig | null } = { current: null };
