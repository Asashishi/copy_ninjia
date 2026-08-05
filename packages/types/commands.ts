/**
 * 目标解析失败时按场景发送的提示文案，由调用方（各命令）定制措辞。
 * 判定见 packages/commands/targetResolution.ts 的 resolveCommandTarget。
 */
export interface CommandTargetMessages {
  /** 既没有回复消息、也没给 @username 参数。 */
  readonly missingTarget: string;
  /** 给了非空参数，但它既不是合法 @username、也不是（按开关）合法的用户 id / 会话 id。 */
  readonly invalidUsername: (rawArgument: string) => string;
  /** 给了 @username，但本天才没缓存过这个人（未曾在群里发言过）。 */
  readonly unknownUsername: (rawUsername: string) => string;
  /**
   * 回复了一条消息、同时又给了参数，而两者指向的不是同一个目标。
   *
   * 措辞必须让人看出「有两个目标、本天才没挑」——静默取一的那条路正是这类命令
   * 最容易踩的坑，见 resolveCommandTarget。
   */
  readonly conflictingTarget: (rawArgument: string) => string;
  /** 解析出的目标是机器人自己。 */
  readonly selfTarget: string;
}

/**
 * 一条 enable/disable 开关命令的全部对外文案。
 *
 * 六项都是必填。四种状态结局各有各的话，尤其是 alreadyEnabled/alreadyDisabled：
 * 同状态重复执行必须说破「本来就是这样」，不能借用刚改完的那句——否则群里看到
 * 的是一次并不存在的状态变化，管理员会以为自己刚刚才把它打开/关掉（口径同
 * /quiet、/unquiet 与 /white）。把它们收在同一个必填结构里，就是让新开关命令
 * 没法只写「开」「关」两句了事。
 *
 * 具体文案表见 packages/consts/commands.ts，判定见
 * packages/commands/superAdminToggle.ts 的 toggleReplyText。
 */
export interface ToggleCommandTexts {
  /** 无权者的嘲讽；入参是发起身份的展示名。 */
  readonly rejection: (mockerLabel: string) => string;
  /** 参数不是 enable/disable 时的用法提示。 */
  readonly usage: string;
  /** 由关变开。 */
  readonly enabled: string;
  /** 由开变关。 */
  readonly disabled: string;
  /** 本来就开着，本次没有改变状态。 */
  readonly alreadyEnabled: string;
  /** 本来就关着，本次没有改变状态。 */
  readonly alreadyDisabled: string;
}

/**
 * 一条模型切换命令（`/image_model`、`/chat_model`）的全部对外文案。
 *
 * 两条命令共用这一份字段口径，但**各自一张文案表**：字段是一样的，话不一样——
 * 回执必须说破自己切的是哪一半能力，否则超管会以为一条命令把四项全换了。
 *
 * 不复用 ToggleCommandTexts：这类命令选的是两家供应商之一，不是开/关，四种
 * 状态结局那套字段套不上。两把凭据各有各的缺席提示——只有一家可用时切换没有
 * 意义，混成一句只会让人去查错地方（口径同 /ad_detect 分开报两道前提）。
 *
 * 具体文案表见 packages/consts/commands.ts，共同判定见
 * packages/commands/providerModel.ts。
 */
export interface ProviderModelCommandTexts {
  /** 非超级管理员的嘲讽；入参是发起身份的展示名。 */
  readonly rejection: (mockerLabel: string) => string;
  /** 参数不是 gpt/gemini 时的用法提示。 */
  readonly usage: string;
  /** 缺 AI_CHAT_GEMINI_API_KEY。 */
  readonly missingGeminiKey: string;
  /** 缺 AI_CHAT_OPENAI_API_KEY。 */
  readonly missingOpenAiKey: string;
  /** 切换成功；入参是面向用户的供应商名。 */
  readonly switched: (providerLabel: string) => string;
  /** 本来就是这家，本次没有改变选取。 */
  readonly unchanged: (providerLabel: string) => string;
}
