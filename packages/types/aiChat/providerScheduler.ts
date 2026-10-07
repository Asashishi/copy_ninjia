import type { PrioritizedBoundedTaskRunner } from "../../libs/prioritizedBoundedTaskRunner";
import type {
  AiImageProvider,
  AiMediaProvider,
  AiSpeechFacade,
  AiStructuredTextProvider,
  AiSummaryProvider,
  AiTextProvider,
  AiWebSearchFacade,
} from "./provider";
import type { AgentProvider } from "../config";

/**
 * 一条 AI 供应商配额归属。相同协议、端点和凭据的能力共享执行器；模型名不参与
 * 分组。
 */
export interface AiProviderQuotaLane {
  readonly provider: AgentProvider;
  readonly baseUrl: string | undefined;
  readonly apiKey: string;
  readonly runner: PrioritizedBoundedTaskRunner;
}

/** 每项能力的门面缓存；首次取用时构造，agent.json 热重载时整体清空后按新快照重建。 */
export interface AiProviderFacadeCache {
  text: AiTextProvider | undefined;
  summary: AiSummaryProvider | undefined;
  media: AiMediaProvider | undefined;
  mediaBackground: AiMediaProvider | undefined;
  /** undefined 表示尚未解析，null 表示部署未配置该能力。 */
  image: AiImageProvider | null | undefined;
  /** undefined 表示尚未解析，null 表示部署未配置该能力。 */
  tts: AiSpeechFacade | null | undefined;
  /** undefined 表示尚未解析，null 表示部署未配置该能力。 */
  webSearch: AiWebSearchFacade | null | undefined;
  /** 用 text 模型执行的联网检索（cron 摘要在没配 web_search 时用）。 */
  textWebSearch: AiWebSearchFacade | undefined;
  /** text 能力的结构化 JSON 生成（cron 摘要组稿）。 */
  structuredText: AiStructuredTextProvider | undefined;
}
