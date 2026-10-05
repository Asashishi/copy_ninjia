/** owner: main。Google 翻译客户端、进程级凭据快照与按群串行的后台译文链。 */

import type { v3 as GoogleTranslate } from "@google-cloud/translate";
import { createKeyedSerialTaskRunner } from "../../libs/keyedSerialTaskRunner";
import type { KeyedSerialTaskRunner } from "../../libs/keyedSerialTaskRunner";
import type { GoogleServiceAccountKey } from "../../types/config";
import type { TranslateMessageBacklog } from "../../types/translate";

/**
 * 启动总闸严格解析后发布唯一凭据快照；缺省为 null，
 * closeTranslate 不清除，进程重启重新读取；Worker 不引入，容量为一份部署配置。
 */
export const googleServiceAccountKey: { current: GoogleServiceAccountKey | null } = { current: null };

interface TranslateRuntime {
  client: GoogleTranslate.TranslationServiceClient | null;
  accepting: boolean;
  generation: number;
  tasks: Set<Promise<unknown>>;
}

/**
 * 服务账号解析出的 GCP project 路径前缀。首次翻译时填充，closeTranslate
 * 清空；重启后从服务账号重新查询，容量固定为一个字符串。
 */
export const translateParentCache: { parent: string | null } = { parent: null };

/**
 * 翻译 owner 的客户端、接入闸、代际与在途任务。initTranslate 开放入口，
 * closeTranslate 关闭客户端并提升代际；进程重启后以初始空状态重建。在途集合同时登记
 * 翻译请求与按群串行的后台译文任务（translate/message.ts），供停机 drainTranslate 等待，
 * 在 Promise settle 时删除；条数受每群 TRANSLATE_CHAT_BACKLOG_MAX 约束。
 */
export const translateRuntime: TranslateRuntime = {
  client: null,
  accepting: false,
  generation: 0,
  tasks: new Set(),
};

/**
 * 按群串行的后台译文任务链尾（translate/message.ts 的 queueTranslateMessage）：同群译文按收到
 * 顺序发出。链排空即由执行器删除条目；容量为同时有译文在途的群数，上界为开着翻译会话的群数，
 * 不设淘汰。不落盘，进程重启后为空。
 */
export const translateMessageChains: Map<number, Promise<void>> = new Map();
/**
 * 每群后台译文积压：queueTranslateMessage 入队时 count +1、任务结束时 -1，归零即删除条目；
 * count 达到 TRANSLATE_CHAT_BACKLOG_MAX 时新消息不翻译。容量与 translateMessageChains 相同，
 * 不落盘，进程重启后为空。
 */
export const translateMessageBacklogs: Map<number, TranslateMessageBacklog> = new Map();
/** 后台译文的按群串行调度器，与 translateMessageChains 共享生命周期。 */
export const translateMessageRunner: KeyedSerialTaskRunner<number> =
  createKeyedSerialTaskRunner(translateMessageChains);
