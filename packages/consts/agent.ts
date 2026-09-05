/**
 * `config/agent.json` 的 `agent` 段允许出现的全部能力名，顺序与
 * `config_example/agent.json` 一致。
 *
 * 这份名单是唯一权威源：`packages/config/agent.ts` 的两处 `hasOnlyKeys` 用它
 * 决定「未知字段一律拒绝」，install.sh 的安装问卷按同一份名单逐项询问，
 * 由 `test/scripts/installScript.test.ts` 与本常量对拍。新增能力必须改这里，
 * 并同步能力档解析、示例文件与三语文档。
 *
 * 所属模块：AI 能力部署配置。
 */
export const AGENT_CAPABILITY_NAMES: readonly string[] = [
  "ad_detect",
  "text",
  "summary",
  "media",
  "image",
  "song",
];

/**
 * AI 闲聊可用的必备能力：三项齐备才算对话核心成立，缺任意一项
 * `/ai_chat enable` 会被拒绝（见 packages/aiChat/availability.ts）。
 *
 * 必须是 AGENT_CAPABILITY_NAMES 的子集；install.sh 用同一份名单判断问卷
 * 是否问全了必填项。所属模块：AI 能力部署配置。
 */
export const AGENT_AI_CHAT_REQUIRED_CAPABILITIES: readonly string[] = [
  "text",
  "summary",
  "media",
];

/** Agent 部署示例实际使用的占位凭据；严格解析只拒绝这些已知无效值。 */
export const AGENT_API_KEY_PLACEHOLDERS: readonly string[] = [
  "replace-with-deepseek-api-key",
  "replace-with-google-api-key",
  "replace-with-openai-api-key",
  "replace-with-xai-api-key",
];

/** Agent 配置允许使用明文 HTTP 的回环主机闭集。 */
export const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/** Agent base_url 严格校验的期望形态，不含用户配置值。 */
export const EXPECTED_BASE_URL: string =
  "an absolute https URL without credentials or a fragment " +
  "(plain http is allowed only for localhost, 127.0.0.1, and ::1)";
