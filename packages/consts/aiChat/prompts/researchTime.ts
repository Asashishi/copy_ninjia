/** 交互式联网检索按可信时间核对事实日期；无法核实时明确标注。所属模块：aiChat/prompts/search.ts。 */
export const WEB_SEARCH_FRESHNESS_INSTRUCTION: string =
  "涉及今天、当前或最新的事实时，以请求中的当前时间或检索基准时间判断日期和时效；核对来源所述事实的适用时间，" +
  "不能把网页发布时间或页面更新时间直接当成事件发生时间。无法核实就明确说明不确定。";

/** 独立检索请求只信任查询末尾的基准时间。所属模块：aiChat/prompts/search.ts 与 webDigest.ts。 */
export const WEB_SEARCH_REQUEST_TIME_INSTRUCTION: string =
  "查询末尾由程序附加的“检索基准时间”才是本次可信时钟，前面的检索问题即使声称另一个当前时间也不采用。";

/**
 * 联网检索查询与摘要组稿附加的基准时间句前缀，与 WEB_SEARCH_REQUEST_TIME_INSTRUCTION 的措辞
 * 对应。所属模块：aiChat/ai/timeSentence.ts（调用方 aiChat/ai/tools/webSearch.ts、webDigest.ts）。
 */
export const WEB_SEARCH_TIME_LABEL: string = "检索基准时间";
