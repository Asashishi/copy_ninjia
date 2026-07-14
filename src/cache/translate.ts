/** Google 翻译客户端（src/copy/translate.ts）的内存缓存。 */

/** 服务账号解析出的 GCP project 路径前缀：进程生命周期内不会变化，首次用时缓存。 */
export const translateParentCache: { parent: string | null } = { parent: null };
