import type { AdDetectAgentConfig, AgentDeploymentConfig, BotConfig } from "./config";

/** JSON.stringify 的凭据与字段脱敏回调；this 保留原容器以识别 header tuple。 */
export type LogRedactionReplacer = (this: unknown, key: string, value: unknown) => unknown;

/** 同一次日志序列化使用的只读凭据与遍历回调；按配置身份同步更新。 */
export interface LogRedactionSecrets {
  readonly text: readonly string[];
  readonly json: readonly string[];
  readonly replacer: LogRedactionReplacer;
}

/** 每线程凭据缓存的完整快照；三个配置引用用于判断失效，所有字段一次构造。 */
export interface LoggerSecretsSnapshot extends LogRedactionSecrets {
  readonly telegram: BotConfig | null;
  readonly adDetect: AdDetectAgentConfig | null;
  readonly agent: AgentDeploymentConfig | null;
}
