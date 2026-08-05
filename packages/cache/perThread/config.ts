import type {
  AdDetectOpenAiConfig,
  AdSampleConfig,
  AiAgentOpenAiConfig,
  GeminiDeploymentConfig,
  MoodConfig,
  ReactionConfig,
  StickerConfig,
} from "../../types/config";

/**
 * 部署配置单例缓存的内存状态：defaultMoodConfigCache 属
 * packages/config/mood.ts、defaultReactionConfigCache 属 packages/config/reactions.ts、
 * defaultStickerConfigCache 属 packages/config/stickers.ts、defaultAdSampleConfigCache
 * 属 packages/config/adSamples.ts，adDetectOpenAiConfigCache 与 aiAgentOpenAiConfigCache
 * 属 packages/config/openai.ts（同一份文件的两段各缓存各的），geminiDeploymentConfigCache
 * 属 packages/config/gemini.ts，彼此相互独立。
 *
 * perThread：这些 loader 各自被两条以上线程加载（心情/反应在主线程与 AI 闲聊
 * Worker，贴纸连 Disk I/O Worker 也要，广告示例在主线程与 Anti-Raid Worker），
 * 各持一份从同一个只读文件解出来的副本。不做跨线程共享也不需要——配置在进程
 * 生命周期内不变，重复解析一次的代价远低于为它铺一条消息通道。
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

/**
 * config/openai.json 的 **ad_detect 段**解析结果缓存。文件缺失、缺段、缺模型名都算
 * 失败（代码不再持有默认值），走下面那个失败 holder。
 *
 * 两段各一对 holder，而不是整份文件一对：填充这一对只解析 ad_detect，ai_agent 段
 * 里的任何笔误都进不到这条线程的失败态里。这是就绪探测分段判定
 * （config/readiness.ts）在运行时侧的对应物——探哪一段，运行时就只读哪一段，
 * 否则「通过启动门禁的配置」与「跑得起来的配置」是两个集合。
 */
export const adDetectOpenAiConfigCache: { current: AdDetectOpenAiConfig | null } = { current: null };

/**
 * config/openai.json 的 **ad_detect 段**解析**失败**缓存，与上面的成功缓存互斥填充。
 *
 * 只缓存成功是不够的：广告检测的模型名是逐消息从这份配置里取的（见
 * workers/antiRaid/adDetect/classifier.ts），文件一坏，Anti-Raid Worker 的
 * 每条候选消息都要重做一次同步 readFileSync + JSON.parse 才抛进 catch。
 * 缓存失败之后，坏文件在这条线程上只解析一次。
 *
 * 修好文件要重启才生效，与四份 loader「读一次、进程内不再重载」的语义一致
 * （同 cache/main/configReadiness.ts）。首次读取填充，进程/Worker 重建后重新读盘。
 */
export const adDetectOpenAiConfigFailure: { current: Error | null } = { current: null };

/** config/openai.json 的 **ai_agent 段**解析结果缓存；分段理由同上。 */
export const aiAgentOpenAiConfigCache: { current: AiAgentOpenAiConfig | null } = { current: null };

/**
 * config/openai.json 的 **ai_agent 段**解析**失败**缓存，与上面的成功缓存互斥填充。
 *
 * 与 ad_detect 那一对同理：回复、总结、读图、生图四条流水线每次取模型名都要过这里
 * （见 aiChat/openai/*.ts），不缓存失败就等于每轮一次同步读盘。
 */
export const aiAgentOpenAiConfigFailure: { current: Error | null } = { current: null };

/** config/gemini.json 的解析结果缓存；语义与上面两对 OpenAI 段缓存一致。 */
export const geminiDeploymentConfigCache: { current: GeminiDeploymentConfig | null } = { current: null };

/**
 * config/gemini.json 的解析**失败**缓存，与上面的成功缓存互斥填充。
 *
 * 与 OpenAI 那份同样只缓存成功是不够的：回复会话每轮都要取一次模型名，文件一坏
 * 就等于每轮一次同步 readFileSync + JSON.parse 才抛进 catch。修好文件要重启才
 * 生效，与其余 loader「读一次、进程内不再重载」的语义一致。
 */
export const geminiDeploymentConfigFailure: { current: Error | null } = { current: null };
