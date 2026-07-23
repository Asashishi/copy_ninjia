import type { v3 as GoogleTranslate } from "@google-cloud/translate";

/** Google 翻译客户端（src/copy/translate.ts）的进程内运行态。 */

interface TranslateRuntime {
  client: GoogleTranslate.TranslationServiceClient | null;
  accepting: boolean;
  generation: number;
  tasks: Set<Promise<string | null>>;
}

/**
 * 服务账号解析出的 GCP project 路径前缀。首次翻译时填充，closeTranslate
 * 清空；重启后从服务账号重新查询，容量固定为一个字符串。
 */
export const translateParentCache: { parent: string | null } = { parent: null };

/**
 * 翻译 owner 的客户端、接入闸、代际与在途任务。initTranslate 开放入口，
 * closeTranslate 关闭客户端并提升代际；进程重启后以初始空状态重建，在途
 * 集合只受调用方当前并发量约束并在 Promise settle 时删除。
 */
export const translateRuntime: TranslateRuntime = {
  client: null,
  accepting: false,
  generation: 0,
  tasks: new Set(),
};
