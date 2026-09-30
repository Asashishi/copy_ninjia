import { raceAbort } from "../../packages/libs/abortSignal";

let unhandled: number = 0;
process.on("unhandledRejection", (): void => { unhandled++; });
const controller: AbortController = new AbortController();
controller.abort();
const task: Promise<string> = Bun.argv[2] === "immediate"
  ? Promise.reject(new Error("immediate task failure"))
  : new Promise<string>((_resolve: (value: string | PromiseLike<string>) => void, reject: (reason?: unknown) => void): void => {
    setTimeout((): void => reject(new Error("late task failure")), 0);
  });
const result: string = await raceAbort(task, {
  signal: controller.signal,
  cancelled: "cancelled",
  rejected: "rejected",
});
await Bun.sleep(20);
await Bun.write(Bun.stdout, JSON.stringify({ unhandled, result }));
