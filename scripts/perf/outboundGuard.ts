import { bot } from "../../packages/infra/telegram/mainClient";
import type { Transformer } from "grammy";

/**
 * 出站硬闸：基准脚本会 import 生产模块，而部署机上 bot 通常正在运行、用的是同一个
 * token。任何一次真实出站都以线上机器人的身份发出，且无法撤回。所有场景按设计
 * 都只碰进程内存和自己的 mock 数据根，这里把统一出站通道堵死，让越界变成一次
 * 响亮的失败。
 *
 * **必须装 grammY transformer，光换 globalThis.fetch 拦不住它。** grammY 在模块
 * 加载时就把 fetch 绑到内部 shim 上（`node_modules/grammy/out/core/client.js` 里
 * 的 `shim_node_js_1.fetch`），之后调用只认那个绑定；而静态 import 又先于模块体
 * 执行，赋值再早也来不及。实测靠改 globalThis.fetch「保护」的一次基准，仍然向
 * Telegram 发出了三万多次 getChatAdministrators。transformer 挂在 grammY 自己的
 * 调用层，与传输实现无关，才是可靠的拦截点。
 *
 * globalThis.fetch 这道仍然保留，但它覆盖的是**另一类**调用：项目里直接写
 * `fetch(...)` 的地方（头像抓取、JSON API）在调用时才解析全局，因此拦得住。
 *
 * 本模块由 hotPaths.ts 与 fullSuite 的各子进程共用：多一个会 import 生产模块的
 * 基准入口，就多一条可能打到线上的路径，这道闸只能有一份实现。
 */
export function installOutboundGuards(): void {
  const deny: Transformer = (_prev: unknown, method: string): never => {
    throw new Error(`perf benchmark attempted Telegram API call '${method}'; scenarios must stay in-process`);
  };
  bot.api.config.use(deny);
  globalThis.fetch = ((...args: unknown[]): never => {
    throw new Error(
      `perf benchmark attempted a network call (${JSON.stringify(args[0])}); scenarios must stay in-process`
    );
  }) as unknown as typeof fetch;
}
