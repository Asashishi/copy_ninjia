import type { v3 as GoogleTranslate } from "@google-cloud/translate";
import type { GoogleServiceAccountKey } from "../../types/config";

/** owner：main。Google 翻译客户端与进程级凭据快照。 */

/**
 * owner：main。启动总闸严格解析后发布唯一凭据快照；缺省为 null，
 * closeTranslate 不清除，进程重启重新读取；Worker 不引入，容量为一份部署配置。
 */
export const googleServiceAccountKey: { current: GoogleServiceAccountKey | null } = { current: null };

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
