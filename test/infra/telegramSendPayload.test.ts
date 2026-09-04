/**
 * 出站 payload 改成「定形一次初始化 + 缺席用 undefined」之后，真正发到网络上的
 * 请求体必须与「整个不带这个键」逐字节相同。
 *
 * 这条断言是那次改写的全部安全性依据：字段从「不存在」变成「存在但为 undefined」
 * 是一次真实的载荷变化，只是恰好被 grammY 的两条序列化路径各自过滤掉了。
 * **依据在依赖内部**，升级 grammY 时没有任何编译期信号会提醒这里，所以钉成用例：
 * 哪天上游改了过滤口径，这里先红。
 *
 * 判据取**注入 fetch 拿到的真实请求体**，不 import grammY 的内部模块：那些路径
 * 不在它的 exports 映射里，照着写等于把测试绑在依赖的目录结构上。
 */

import { describe, expect, test } from "bun:test";
import { Api } from "grammy";
import { InputFile } from "grammy/types";

const TOKEN: string = "123456789:test-only-telegram-bot-token";

interface CapturedRequest {
  readonly contentType: string;
  readonly body: string;
}

/** 用一个只记录不发送的 fetch 跑一次 raw 调用，取回它构造出的请求体。 */
async function capture(
  call: (api: Api) => Promise<unknown>
): Promise<CapturedRequest> {
  let captured: CapturedRequest | undefined;
  async function record(
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> {
    const headers: Headers = new Headers(init?.headers);
    const body: string = await new Response(init?.body ?? null).text();
    captured = {
      contentType: headers.get("content-type") ?? "",
      // 每次随机生成的 multipart boundary 与 attach 句柄不属于载荷差异。
      body: body
        .replace(/-{10}[a-z0-9]{32}/g, "<boundary>")
        .replace(/attach:\/\/[a-z0-9]+/g, "attach://<id>")
        .replace(/name="[a-z0-9]{16}"/g, 'name="<id>"'),
    };
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 } }),
      { headers: { "content-type": "application/json" } }
    );
  }
  // Bun 的 `typeof fetch` 还带一个 preconnect 成员；补上它才满足 grammY 的
  // `fetch?: typeof fetch`，不必在这里放一个 as unknown as 的双重断言。
  const capturingFetch: typeof fetch = Object.assign(record, {
    preconnect: fetch.preconnect,
  });
  const api: Api = new Api(TOKEN, { fetch: capturingFetch });
  await call(api);
  if (captured === undefined) throw new Error("fetch was never called");
  return captured;
}

describe("grammY 丢弃值为 undefined 的出站字段", () => {
  test("JSON 路径：定形 payload 与省略写法产出同一请求体", async () => {
    // 定形写法：五个可选字段恒定出现，缺席用 undefined 表达。
    const fixedShape: CapturedRequest = await capture((api: Api): Promise<unknown> =>
      api.raw.sendMessage({
        chat_id: -100_123,
        text: "本天才才不是在夸你呢♡",
        message_thread_id: undefined,
        reply_parameters: undefined,
        reply_markup: undefined,
        entities: undefined,
        link_preview_options: undefined,
      }));
    // 改写前的写法：条件展开的结果就是这些键根本不存在。
    const omitted: CapturedRequest = await capture((api: Api): Promise<unknown> =>
      api.raw.sendMessage({
        chat_id: -100_123,
        text: "本天才才不是在夸你呢♡",
      }));

    expect(fixedShape.contentType).toContain("application/json");
    expect(fixedShape.body).toBe(omitted.body);
  });

  test("JSON 路径：真正有值的字段照常进请求体", async () => {
    const sent: CapturedRequest = await capture((api: Api): Promise<unknown> =>
      api.raw.sendMessage({
        chat_id: -100_123,
        text: "喵",
        message_thread_id: 77,
        reply_parameters: { message_id: 5, allow_sending_without_reply: true },
        reply_markup: undefined,
        entities: undefined,
        link_preview_options: { is_disabled: true },
      }));

    expect(JSON.parse(sent.body)).toEqual({
      chat_id: -100_123,
      text: "喵",
      message_thread_id: 77,
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
      link_preview_options: { is_disabled: true },
    });
  });

  test("multipart 路径：sendAudio 的七个可选字段同样丢弃 undefined", async () => {
    const audio = (): InputFile => new InputFile(new Uint8Array([1, 2, 3]), "song.mp3");
    const fixedShape: CapturedRequest = await capture((api: Api): Promise<unknown> =>
      api.raw.sendAudio({
        chat_id: -100_123,
        audio: audio(),
        caption: "封面",
        message_thread_id: undefined,
        title: undefined,
        performer: undefined,
        duration: undefined,
        thumbnail: undefined,
        reply_parameters: undefined,
      }));
    const omitted: CapturedRequest = await capture((api: Api): Promise<unknown> =>
      api.raw.sendAudio({
        chat_id: -100_123,
        audio: audio(),
        caption: "封面",
      }));

    expect(fixedShape.contentType).toContain("multipart/form-data");
    expect(fixedShape.body).toBe(omitted.body);
  });

  test("undefined 字段不会把纯 JSON 载荷误判成需要 multipart 上传", async () => {
    const sent: CapturedRequest = await capture((api: Api): Promise<unknown> =>
      api.raw.sendMessage({
        chat_id: -100_123,
        text: "x",
        entities: undefined,
        reply_markup: undefined,
      }));
    expect(sent.contentType).toContain("application/json");
  });
});
