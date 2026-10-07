import type {
  AiTextResult,
  MediaInputCapability,
  MediaInputSupport,
} from "../aiChat/provider";

/**
 * 一种模态的完整探测状态；字段在构造时一次写全，运行期只整体替换，不增删。
 */
export interface MediaInputModalityState {
  readonly support: MediaInputSupport;
  /**
   * 连续瞬时失败次数，封顶 MEDIA_PROBE_MAX_TRANSIENT_FAILURES；成功或落定关闭
   * 结论时清零。只有 `transient` 计数——单份坏媒体不得把整条模态推进退避。
   */
  readonly transientFailures: number;
  /**
   * 下一次允许发起真实探测的绝对时刻（Date.now() 口径）；0 表示不在退避中。
   * 读取侧把超过 MEDIA_PROBE_BACKOFF_MAX_MS 的剩余时长视为墙钟回拨并立即放行
   * （同 auto/message/triggerPolicy.ts 的冷却口径）。
   */
  readonly nextProbeAt: number;
  /**
   * 所属 media 配置代次：初始为 0，agent.json 热重载替换 media 能力时两种模态一起
   * 进入下一代。结论只能记到接纳该请求时的那一代上。
   */
  readonly configGeneration: number;
}

/** media 模型的模态支持表；vision 与 voice 固定初始化。 */
export interface MediaInputSupportState {
  readonly vision: MediaInputModalityState;
  readonly voice: MediaInputModalityState;
}

/**
 * 媒体模态状态机要求调用方执行的副作用：模态落定为 misconfigured 的那一次记一条英文诊断。
 * 判定与落定在 packages/states/mediaInputSupport.ts，日志边界在 AI Chat Worker 的 owner 缓存。
 */
export interface MediaInputEffect {
  readonly kind: "logMisconfiguredMediaEndpoint";
  readonly capability: MediaInputCapability;
}

/**
 * 一次归因的结果。`next` 与传入的 `current` 是同一引用时表示状态不变，调用方
 * 不必整表替换；`effects` 为空数组时没有任何副作用要执行。
 */
export interface MediaInputTransition {
  readonly next: MediaInputModalityState;
  readonly effects: readonly MediaInputEffect[];
}

/** 一次真实媒体调用的归因输入。 */
export interface MediaInputResultEvent {
  readonly capability: MediaInputCapability;
  /** 本次调用的业务结果；只有带 mediaFailure 的失败才对整条模态下结论。 */
  readonly result: AiTextResult;
  /** 发起这次调用时读到的模态状态；用于按对象身份归因状态代次。 */
  readonly attemptState: MediaInputModalityState;
  /** 与准入共用的同一次墙钟读数。 */
  readonly now: number;
}
