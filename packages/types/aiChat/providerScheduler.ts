import type { PrioritizedBoundedTaskRunner } from "../../libs/prioritizedBoundedTaskRunner";
import type {
  AiImageProvider,
  AiMediaProvider,
  AiSongProvider,
  AiSummaryProvider,
  AiTextProvider,
} from "./provider";
import type { AgentProvider } from "../config";

/**
 * 一条 AI 供应商配额归属。相同协议、端点和凭据的能力共享执行器；模型名不参与
 * 分组，因为常见供应商在账号或项目层共享额度。
 */
export interface AiProviderQuotaLane {
  readonly provider: AgentProvider;
  readonly baseUrl: string | undefined;
  readonly apiKey: string;
  readonly runner: PrioritizedBoundedTaskRunner;
}

/** 每项能力的一次构造后只读门面缓存；配置在 Worker 生命周期内不变。 */
export interface AiProviderFacadeCache {
  text: AiTextProvider | undefined;
  summary: AiSummaryProvider | undefined;
  media: AiMediaProvider | undefined;
  mediaBackground: AiMediaProvider | undefined;
  /** undefined 表示尚未解析，null 表示部署未配置该能力。 */
  image: AiImageProvider | null | undefined;
  /** undefined 表示尚未解析，null 表示部署未配置该能力。 */
  song: AiSongProvider | null | undefined;
}
