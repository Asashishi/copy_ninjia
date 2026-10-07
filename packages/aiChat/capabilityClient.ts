/**
 * 各实现包（gemini、openai、anthropic）按能力取 SDK 客户端的共用骨架：核对该能力配置的
 * provider，按能力从本线程 holder 取已建实例，没有时以该能力配置构造并回填。各家 holder 仍归
 * cache/workers/aiChat/ 下各自的文件；端点、超时与重试等构造参数由调用方的 create 决定。
 */

import { AGENT_PROVIDER_LABELS } from "../consts/agent";
import { agentCapabilityConfig } from "../config/agent";
import type {
  AgentCapability,
  AgentDeploymentCapabilityConfig,
  AgentProvider,
  ProviderCapabilityConfig,
} from "../types/config";

export interface CapabilityClientOptions<TProvider extends AgentProvider, TClient> {
  readonly provider: TProvider;
  readonly capability: AgentCapability;
  /** 本线程该供应商的按能力客户端缓存（cache/workers/aiChat/{gemini,openai,anthropic}.ts）。 */
  readonly holder: { current: Map<AgentCapability, TClient> | null };
  readonly create: (config: ProviderCapabilityConfig<TProvider>) => TClient;
}

function isProviderConfig<TProvider extends AgentProvider>(
  config: AgentDeploymentCapabilityConfig | undefined,
  provider: TProvider
): config is ProviderCapabilityConfig<TProvider> {
  return config?.provider === provider;
}

/** 取该能力的客户端；能力未配置或不属于该 provider 时抛错，不跨供应商回退。 */
export function capabilityClient<TProvider extends AgentProvider, TClient>({
  provider,
  capability,
  holder,
  create,
}: CapabilityClientOptions<TProvider, TClient>): TClient {
  const config: AgentDeploymentCapabilityConfig | undefined = agentCapabilityConfig(capability);
  if (!isProviderConfig(config, provider)) {
    throw new Error(
      `Agent capability "${capability}" is not configured for the ${AGENT_PROVIDER_LABELS[provider]} provider.`
    );
  }
  const clients: Map<AgentCapability, TClient> = holder.current ??= new Map<AgentCapability, TClient>();
  const cached: TClient | undefined = clients.get(capability);
  if (cached !== undefined) return cached;
  const client: TClient = create(config);
  clients.set(capability, client);
  return client;
}
