import { personaCache } from "../cache/perThread/config";
import { PERSONA_PATH } from "../consts/paths";
import { invalidInput, readUtf8TextInput } from "../libs/inputValidation";

/**
 * 读取 AI 人设资源并拒绝缺失、不可读或空白内容。错误不得携带文件内容或底层
 * I/O 细节；主线程启动闸和 AI Worker 运行期兜底共用同一实现。
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

/** 接管启动预检或 Worker 初始化消息已经严格校验的人设快照。 */
export function adoptPersona(persona: string): void {
  personaCache.current = persona;
}

/** 启动预检填充默认路径快照；重复调用只读 holder。 */
export async function ensurePersona(): Promise<void> {
  if (personaCache.current !== null) return;
  adoptPersona(await loadPersona());
}

/** 默认人设只读当前线程已校验的快照，不在运行期回退读盘。 */
export function getPersona(): string {
  const persona: string | null = personaCache.current;
  if (persona === null) {
    throw new Error(`Persona configuration was not initialized from ${PERSONA_PATH}.`);
  }
  return persona;
}
