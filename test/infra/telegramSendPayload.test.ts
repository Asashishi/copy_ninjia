/**
 * 出站 payload 采用「可选字段定形一次初始化、缺席用 undefined 表达」的写法时，
 * 真正发到网络上的请求体与「整个不带这个键」逐字节相同。
 *
 * grammY 的两条序列化路径（JSON / multipart）各自过滤 undefined 字段；该行为依赖其内部实现，
 * 因此用例直接判定网络层的真实请求体。
 *
 * 判据取注入 fetch 拿到的真实请求体，不 import grammY 的内部模块（那些路径不在它的 exports 映射里）。
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
  // Bun 的 `typeof fetch` 带 preconnect 成员；补上它以满足 grammY 的 `fetch?: typeof fetch`。
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
    // 可选字段恒定出现，缺席用 undefined 表达。
    const fixedShape: CapturedRequest = await capture((api: Api): Promise<unknown> =>
      api.raw.sendMessage({
        chat_id: -100_123,
        text: "本天才才不是在夸你呢♡",
        message_thread_id: undefined,
        reply_parameters: undefined,
        reply_markup: undefined,
        entities: undefined,
        parse_mode: undefined,
        link_preview_options: undefined,
      }));
    // 对照写法：这些键在对象字面量里整个不出现。
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
        parse_mode: "MarkdownV2",
        link_preview_options: { is_disabled: true },
      }));

    expect(JSON.parse(sent.body)).toEqual({
      chat_id: -100_123,
      text: "喵",
      message_thread_id: 77,
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
    });
  });

  test("multipart 路径：sendVoice 的可选字段同样丢弃 undefined", async () => {
    const voice = (): InputFile => new InputFile(new Uint8Array([1, 2, 3]), "voice.ogg");
    const fixedShape: CapturedRequest = await capture((api: Api): Promise<unknown> =>
      api.raw.sendVoice({
        chat_id: -100_123,
        voice: voice(),
        message_thread_id: undefined,
        duration: undefined,
        reply_parameters: undefined,
      }));
    const omitted: CapturedRequest = await capture((api: Api): Promise<unknown> =>
      api.raw.sendVoice({
        chat_id: -100_123,
        voice: voice(),
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
