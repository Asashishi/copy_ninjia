import { readFileSync } from "node:fs";
import { personaCache } from "../cache/perThread/config";
import { PERSONA_PATH } from "../consts/paths";
import { invalidInput } from "../libs/inputValidation";

/**
 * 读取 AI 人设资源并拒绝缺失、不可读或空白内容。错误不得携带文件内容或底层
 * I/O 细节；主线程启动闸和 AI Worker 运行期兜底共用同一实现。
 */
export function loadPersona(path: string = PERSONA_PATH): string {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return invalidInput(path, "$", "a readable non-empty UTF-8 text file");
  }
  const persona: string = content.trim();
  if (persona.length === 0) {
    return invalidInput(path, "$", "a readable non-empty UTF-8 text file");
  }
  return persona;
}

/** 默认人设按线程只读取一次，启动校验结果供同线程运行期复用。 */
export function getPersona(): string {
  personaCache.current ??= loadPersona();
  return personaCache.current;
}
