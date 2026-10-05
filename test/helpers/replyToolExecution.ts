import type { ReplyToolset } from "../../packages/types/aiChat/replies";

/** 供发送内容与回调断言使用；回执仍保留原始乐观结果。 */
export async function executeAndSettle(
  toolset: ReplyToolset,
  name: string,
  argumentsJson: string
): Promise<string> {
  const result: string = toolset.execute(name, argumentsJson);
  await toolset.settle();
  return result;
}
