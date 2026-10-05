import { invalidInput, readUtf8TextInput } from "../libs/inputValidation";

/**
 * 读取 prompt/ 下已存在的提示词文件（persona.md、voice_tool.md），拒绝不可读、非法 UTF-8 或空白
 * 内容，返回去掉首尾空白的正文。错误不得携带文件内容或底层 I/O 细节；文件是否存在由主线程启动
 * 总闸（config/readiness.ts 的 ensurePromptFiles）先行判定，真正缺省时不调用本函数。
 */
export async function loadPromptFile(path: string): Promise<string> {
  let content: string;
  try {
    content = await readUtf8TextInput(path);
  } catch {
    return invalidInput(path, "$", "a readable non-empty UTF-8 text file");
  }
  const prompt: string = content.trim();
  if (prompt.length === 0) {
    return invalidInput(path, "$", "a readable non-empty UTF-8 text file");
  }
  return prompt;
}
