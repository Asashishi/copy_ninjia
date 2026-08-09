import type {
  AdDetectAgentConfig,
  AdSampleConfig,
  AgentDeploymentConfig,
  MoodConfig,
  ReactionConfig,
  StickerConfig,
  TelegramConfig,
} from "../../types/config";

/**
 * 部署配置单例缓存的内存状态：defaultMoodConfigCache 属
 * packages/config/mood.ts、defaultReactionConfigCache 属 packages/config/reactions.ts、
 * defaultStickerConfigCache 属 packages/config/stickers.ts、defaultAdSampleConfigCache
 * 属 packages/config/adSamples.ts、telegramConfigCache 属 packages/config/telegram.ts；
 * adDetectAgentConfigCache 与
 * agentDeploymentConfigCache 属 packages/config/agent.ts，同一份文件的两段各缓存
 * 各的。
 *
 * perThread：这些 holder 各自被两条以上线程持有（心情/反应在主线程与 AI 闲聊
 * Worker，Telegram 身份在主线程与 AI 闲聊 Worker，贴纸连 Disk I/O Worker 也要，
 * 广告示例在主线程与 Anti-Raid Worker），各持一份从同一个只读文件解出来的副本。
 * 不做跨线程共享也不需要——配置在进程生命周期内不变，重复解析一次的代价远低于
 * 为它铺一条消息通道。
 *
 * **两份 agent 快照是例外，它们不重复解析**：agent.json 带着各能力的 api_key，
 * 「各线程各读一次盘」在进程启动后改文件时会解出两代不同的配置。因此它们由
 * 主线程一次解析、经各自 Worker 的初始化消息投递，Worker 侧只 adopt 不读盘
 * （见 config/agent.ts 的三段边界说明）。
 *
 * 按功能聚合的可用性结论只有主线程用，因此不在这里，见
 * cache/main/configReadiness.ts。
 */

/** 默认心情配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘；自定义路径加载不进入缓存。 */
export const defaultMoodConfigCache: { current: MoodConfig | null } = { current: null };
/** 默认反应配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘。 */
export const defaultReactionConfigCache: { current: ReactionConfig | null } = { current: null };
/** 默认贴纸配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘。 */
export const defaultStickerConfigCache: { current: StickerConfig | null } = { current: null };
/** 默认广告示例配置的单例缓存；首次读取填充，进程/Worker 重建后重新读盘。 */
export const defaultAdSampleConfigCache: { current: AdSampleConfig | null } = { current: null };
/** persona.md 的单份文本缓存；主线程启动闸或 AI Worker 首次读取时填充，线程重建后重读。 */
export const personaCache: { current: string | null } = { current: null };

/**
 * config/telegram.json 的线程内只读快照；首次读取填充，进程或 Worker 重建后重读。
 * 配置在生命周期内不热重载，因此容量恒为一个对象且无需淘汰。
 */
export const telegramConfigCache: { current: TelegramConfig | null } = { current: null };

/**
 * config/agent.json 的 **agent.ad_detect 能力**快照；进程内唯一权威值的本线程副本。
 *
 * 填充时机按线程分两路，两路都只写一次、都不热重载：
 * - 主线程：启动总闸 validateAgentDeploymentConfig 解析成功后写入；文件在但没有
 *   ad_detect 段时显式写 null。
 * - Anti-Raid Worker：主线程 agentConfig 初始化消息到达时 adopt 写入（含显式
 *   null），Worker 崩溃重建后由 onRespawn 重放**同一份**快照，绝不重新读盘。
 *
 * 因此 null 一律读作「这个部署没配广告检测」，判定侧 fail-closed，不得回填默认值。
 * 两段各一个 holder 而不是整份文件一个：探哪一段、运行时就只读哪一段，否则
 * 「通过启动门禁的配置」与「跑得起来的配置」是两个集合。容量恒为一个对象。
 *
 * logger 的值级脱敏逐条日志读取本 holder（见 infra/logger.ts 的 currentSecrets），
 * 因此它必须在**每条**持有该凭据的线程里都有一份，不能收进某个 owner 目录。
 */
export const adDetectAgentConfigCache: { current: AdDetectAgentConfig | null } = { current: null };

/**
 * config/agent.json 的 **AI 对话能力段**快照；分段理由与填充口径同上。
 *
 * 主线程由启动总闸填充；AI 闲聊 Worker 由 init 消息 adopt 填充，崩溃重建时
 * 由 lastInitState 重放同一份快照。回复、总结、读图、生图、生歌逐轮取模型名
 * 与凭据都只读这里，没有任何一条运行时路径会再碰磁盘。
 */
export const agentDeploymentConfigCache: { current: AgentDeploymentConfig | null } = { current: null };
