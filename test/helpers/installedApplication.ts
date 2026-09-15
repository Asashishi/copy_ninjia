/** 安装测试的进程 preload：只替换网络应答，保留应用入口、Worker 与磁盘生命周期。 */
import { bot } from "../../packages/infra/telegram/mainClient";
import type { Transformer } from "grammy";

const workerNames: string[] = [];
let stopScheduled: boolean = false;
const RealWorker: typeof Worker = globalThis.Worker;
globalThis.Worker = class extends RealWorker {
  constructor(url: ConstructorParameters<typeof Worker>[0], options?: WorkerOptions) {
    const preloads: string | string[] = options?.preload ?? [];
    super(url, {
      ...options,
      preload: [`${import.meta.dir}/installedWorkerNetwork.ts`,
        ...(typeof preloads === "string" ? [preloads] : preloads)],
    });
    workerNames.push(String(url).split("/").at(-1)!);
  }
};

globalThis.fetch = ((): never => {
  console.error("INSTALL_NETWORK_BLOCKED");
  throw new Error("Installation startup test attempted a network request.");
}) as unknown as typeof fetch;

const transformer: Transformer = async (_previous: unknown, method: string, payload: any): Promise<any> => {
  console.log(`INSTALL_API ${method}`);
  switch (method) {
    case "getMe":
      return { ok: true, result: {
        id: 123456789,
        is_bot: true,
        first_name: "Installation test",
        username: "installation_test_bot",
      } };
    case "setMyCommands":
    case "deleteMyCommands":
      return { ok: true, result: true };
    case "getChat":
      return { ok: true, result: { id: payload.chat_id, type: "supergroup", title: "Installation test group" } };
    case "getStickerSet":
      return { ok: true, result: { name: payload.name, title: "Installation test stickers", sticker_type: "regular", stickers: [] } };
    case "getUpdates":
      if (!stopScheduled) {
        stopScheduled = true;
        setTimeout((): void => {
          process.kill(process.pid, "SIGTERM");
        }, 50);
      }
      await Bun.sleep(100);
      return { ok: true, result: [] };
    default:
      console.error("INSTALL_NETWORK_BLOCKED");
      throw new Error(`Installation startup test attempted unexpected Telegram method ${method}.`);
  }
};
bot.api.config.use(transformer);

process.on("exit", (): void => {
  console.log(`INSTALL_WORKERS ${JSON.stringify(workerNames.sort())}`);
});
