import { describe, expect, test } from "bun:test";
import {
  classifyProviderApiFailure,
  numericErrorStatus,
  providerApiFailureResult,
} from "../../../../packages/aiChat/ai/utils/mediaSupportError";
import type { ProviderApiFailureKind } from
  "../../../../packages/aiChat/ai/utils/mediaSupportError";

/**
 * 归因级联的**顺序本身是语义**（见 mediaSupportError.ts 的头注）：三个模型客户端
 * 必须得出同一档结论，否则同一个 HTTP 状态在不同供应商上会分叉。这里直接钉住那条
 * 级联与它的三档结果映射，不经由任何 SDK 替身——客户端单测覆盖的是各自的日志与
 * 结果形态，覆盖不到「先判 404 还是先判模态」这种排序。
 */

/** 同时命中「不支持」与「媒体输入」两类语义的典型上游文案。 */
const UNSUPPORTED_MEDIA_MESSAGE: string =
  "This model does not support image input for the requested modality.";

describe("供应商 API 失败的状态读取", () => {
  test("只认数值 status，其余形态一律读成未知", () => {
    expect(numericErrorStatus({ status: 404 })).toBe(404);
    expect(numericErrorStatus({ status: "404" })).toBeUndefined();
    expect(numericErrorStatus({})).toBeUndefined();
    expect(numericErrorStatus(new Error("network"))).toBeUndefined();
  });
});

describe("供应商 API 失败的归因级联", () => {
  test("路径级 404/405 最先判，压过同一条消息里的模态语义", () => {
    // 这条正文本身足以判成 unsupported；级联必须仍然先给出 misconfigured，
    // 否则部署把 model 或 base_url 写错会被记成「这个模型没有视觉能力」。
    for (const status of [404, 405]) {
      expect(classifyProviderApiFailure(status, UNSUPPORTED_MEDIA_MESSAGE, true))
        .toBe("misconfigured");
      expect(classifyProviderApiFailure(status, "not found", false))
        .toBe("misconfigured");
    }
  });

  test("只有媒体能力才可能得出 unsupported，且要求正文同时命中两类语义", () => {
    for (const status of [400, 415, 422]) {
      expect(classifyProviderApiFailure(status, UNSUPPORTED_MEDIA_MESSAGE, true))
        .toBe("unsupported");
      // 同一条正文换成非媒体能力：模态结论根本不该出现。
      expect(classifyProviderApiFailure(status, UNSUPPORTED_MEDIA_MESSAGE, false))
        .toBe("rejected");
      // 只有「不支持」没有「媒体输入」，或反过来，都不足以下模态结论。
      expect(classifyProviderApiFailure(status, "unsupported parameter: temperature", true))
        .toBe("rejected");
      expect(classifyProviderApiFailure(status, "image is too large", true))
        .toBe("rejected");
    }
  });

  test("其余非故障状态一律 rejected：这一份输入不合适，不推动模态退避", () => {
    expect(classifyProviderApiFailure(400, "invalid request", true)).toBe("rejected");
    expect(classifyProviderApiFailure(401, UNSUPPORTED_MEDIA_MESSAGE, true)).toBe("rejected");
    expect(classifyProviderApiFailure(403, UNSUPPORTED_MEDIA_MESSAGE, true)).toBe("rejected");
    // 403 不在 unsupported 的白名单状态里，正文命中也不改结论。
    expect(classifyProviderApiFailure(413, "payload too large", true)).toBe("rejected");
  });

  test("拿不到状态码、408/429 与 5xx 都归端点故障", () => {
    expect(classifyProviderApiFailure(undefined, "socket hang up", true)).toBe("endpointFailure");
    expect(classifyProviderApiFailure(408, "timeout", false)).toBe("endpointFailure");
    expect(classifyProviderApiFailure(429, "rate limited", false)).toBe("endpointFailure");
    expect(classifyProviderApiFailure(500, "internal", false)).toBe("endpointFailure");
    expect(classifyProviderApiFailure(503, UNSUPPORTED_MEDIA_MESSAGE, true)).toBe("endpointFailure");
  });
});

describe("归因档位到失败结果的映射", () => {
  test("三档可直接返回的结论各自带着固定诊断串", () => {
    expect(providerApiFailureResult("misconfigured")).toEqual({
      ok: false,
      failureKind: "misconfigured",
      diagnostic: "endpoint or model is unavailable",
    });
    expect(providerApiFailureResult("unsupported")).toEqual({
      ok: false,
      failureKind: "unsupported",
      diagnostic: "media input is unsupported",
    });
    expect(providerApiFailureResult("rejected")).toEqual({
      ok: false,
      failureKind: "rejected",
      diagnostic: "request was rejected",
    });
  });

  test("endpointFailure 不映射成结果，交由调用点走自己的兜底路径", () => {
    const kind: ProviderApiFailureKind = "endpointFailure";
    expect(providerApiFailureResult(kind)).toBeUndefined();
  });
});
