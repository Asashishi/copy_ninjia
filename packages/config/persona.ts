import { personaCache } from "../cache/perThread/config";
import { PERSONA_PATH } from "../consts/paths";
import { invalidInput, readUtf8TextInput } from "../libs/inputValidation";

/**
 * 读取已存在的自定义人设并拒绝不可读、非法 UTF-8 或空白内容，返回去掉首尾空白的正文。
 * 错误不得携带文件内容或底层 I/O 细节；文件是否存在由主线程启动总闸（config/readiness.ts
 * 的 ensurePersona）先行判定，真正缺省时不调用本函数。
 */
export async function loadPersona(path: string = PERSONA_PATH): Promise<string> {
  let content: string;
  try {
    content = await readUtf8TextInput(path);
  } catch {
    return invalidInput(path, "$", "a readable non-empty UTF-8 text file");
  }
  const persona: string = content.trim();
  if (persona.length === 0) {
    return invalidInput(path, "$", "a readable non-empty UTF-8 text file");
  }
  return persona;
}

/** 接管启动总闸或 Worker 初始化消息已经确定的人设快照。 */
export function adoptPersona(persona: string): void {
  personaCache.current = persona;
}

/** 人设只读当前线程已接管的快照，不在运行期回退读盘。 */
export function getPersona(): string {
  const persona: string | null = personaCache.current;
  if (persona === null) {
    throw new Error("Persona was not initialized by the deployment input preflight.");
  }
  return persona;
}
