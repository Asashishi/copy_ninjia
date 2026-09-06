import type { PreparedReplyAction, ReplyActionChains, ReplyToolset } from "../../packages/types/aiChat/replies";

/** 只读句柄的编译期断言；闭包不执行，不改写调用方对象。 */
void ((toolset: ReplyToolset, action: PreparedReplyAction, chains: ReplyActionChains): void => {
  // @ts-expect-error 工具声明在整轮内不可替换。
  toolset.functions = [];
  // @ts-expect-error 接纳边界由工具集构造时固定。
  toolset.execute = async (): Promise<string> => "";
  // @ts-expect-error 排空入口不可替换。
  toolset.settle = async (): Promise<void> => {};
  // @ts-expect-error 乐观回执在接纳后不可改写。
  action.result = "";
  // @ts-expect-error 已接纳链的执行函数不可改写。
  action.run = async (): Promise<string> => "";
  // @ts-expect-error 调用链 owner 的入口不可替换。
  chains.start = (): void => {};
});

/** 供发送内容与回调断言使用；回执仍保留原始乐观结果。 */
export async function executeAndSettle(
  toolset: ReplyToolset,
  name: string,
  argumentsJson: string
): Promise<string> {
  const result: string = await toolset.execute(name, argumentsJson);
  await toolset.settle();
  return result;
}
