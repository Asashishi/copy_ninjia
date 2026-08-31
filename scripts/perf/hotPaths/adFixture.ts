/** 广告热路径基准使用的稳定正文序列。 */

/**
 * 无元数据早退路径必须轮换不同长度正文；固定单一字面量会被 JSC 整体提到循环外，
 * 量到常量折叠而不是 appendLinkUrls/boundSampleContext 的生产成本。
 */
export const AD_SAMPLE_TEXTS: readonly string[] = [
  "ordinary message",
  "another ordinary message",
  "hi",
  "just a normal chat line here",
  "ok",
  "some slightly longer ordinary message body",
  "yet another one",
  "short",
];
