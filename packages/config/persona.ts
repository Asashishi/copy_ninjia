import { personaCache } from "../cache/perThread/config";

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
