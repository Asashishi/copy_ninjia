/** 安装测试的进程 preload：只替换网络应答，保留应用入口、Worker 与磁盘生命周期。 */
import { bot } from "../../packages/infra/telegram/mainClient";
import type { Transformer } from "grammy";

const workerNames: string[] = [];
let stopScheduled: boolean = false;
const RealWorker: typeof Worker = globalThis.Worker;
globalThis.Worker = class extends RealWorker {
  constructor(...args: ConstructorParameters<typeof Worker>) {
    super(...args);
    workerNames.push(String(args[0]).split("/").at(-1)!);
  }
};

globalThis.fetch = ((): never => {
  throw new Error("Installation startup test attempted a network request.");
}) as unknown as typeof fetch;

const transformer: Transformer = async (_previous: unknown, method: string): Promise<any> => {
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
      return { ok: true, result: true };
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
      throw new Error(`Installation startup test attempted unexpected Telegram method ${method}.`);
  }
};
bot.api.config.use(transformer);

process.on("exit", (): void => {
  console.log(`INSTALL_WORKERS ${JSON.stringify(workerNames.sort())}`);
});
