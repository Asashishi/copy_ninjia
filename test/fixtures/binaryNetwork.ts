/** 编译产物的隔离启动夹具；主线程与全部 Worker 只允许明确列出的罐头出站。 */
import { WEATHER_API_URL } from "../../packages/consts/weather";

if (Bun.isMainThread) {
  const OriginalWorker: typeof Worker = globalThis.Worker;
  globalThis.Worker = class extends OriginalWorker {
    constructor(url: ConstructorParameters<typeof Worker>[0], options?: WorkerOptions) {
      super(url, { ...options, preload: [import.meta.path] });
      console.log(`BINARY_WORKER ${String(url).split("/").at(-1)}`);
    }
  };
}
let stopping: boolean = false;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
  const url: URL = new URL(input instanceof Request ? input.url : String(input));
  const weather: URL = new URL(WEATHER_API_URL);
  if (url.origin === weather.origin && url.pathname === weather.pathname) {
    console.log("BINARY_WEATHER");
    return Response.json({
      current: { temperature_2m: 20, weather_code: 0 },
      daily: { temperature_2m_max: [25], temperature_2m_min: [15], weather_code: [0] },
    });
  }
  if (Bun.isMainThread && url.origin === "https://api.telegram.org") {
    const method: string | undefined = url.pathname.split("/").at(-1);
    console.log(`BINARY_API ${method}`);
    switch (method) {
      case "getMe":
        return Response.json({ ok: true, result: { id: 123456789, is_bot: true, first_name: "Binary test", username: "binary_test_bot" } });
      case "getChat":
        return Response.json({ ok: true, result: { id: -1001, type: "supergroup", title: "Migration test group" } });
      case "setMyCommands":
      case "deleteMyCommands":
        return Response.json({ ok: true, result: true });
      case "getStickerSet":
        return Response.json({ ok: true, result: { name: "test", title: "test", sticker_type: "regular", stickers: [] } });
      case "getUpdates":
        if (!stopping) {
          stopping = true;
          setTimeout((): void => { process.kill(process.pid, "SIGTERM"); }, 300);
        }
        await Bun.sleep(50);
        return Response.json({ ok: true, result: [] });
    }
  }
  console.error("BINARY_NETWORK_BLOCKED");
  throw new Error("Binary startup test attempted an unexpected network request.");
}) as typeof fetch;
// grammY 使用 Bun 内建的 node-fetch；它在模块内保存 nativeFetch，需替换其导出。
const nodeFetch: { default: typeof fetch } = import.meta.require("node-fetch") as { default: typeof fetch };
nodeFetch.default = globalThis.fetch;
