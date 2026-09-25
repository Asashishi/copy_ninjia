import { describe, expect, test } from "bun:test";
import {
  isTelegramRequestRejected,
  isTelegramRetryPreconditionChanged,
  telegramErrorDetails,
  TelegramRetryPreconditionChangedError,
} from "../../packages/infra/telegram/errors";

describe("Telegram 错误诊断字段", () => {
  test("主线程 GrammyError 形状取 error_code 与 description", () => {
    const error: Error = Object.assign(new Error("Bad Request"), {
      error_code: 400,
      description: "Bad Request: chat not found",
    });
    expect(telegramErrorDetails(error)).toEqual({ errorCode: 400, description: "Bad Request: chat not found" });
  });

  test("Worker 双工重建的错误取 telegramErrorCode 与 telegramDescription", () => {
    const error: Error = Object.assign(new Error("Telegram request failed"), {
      telegramErrorCode: 403,
      telegramDescription: "Forbidden: bot was kicked",
    });
    expect(telegramErrorDetails(error)).toEqual({ errorCode: 403, description: "Forbidden: bot was kicked" });
  });

  test("字段类型不符、缺字段或不是 Error 时返回 undefined", () => {
    expect(telegramErrorDetails(new Error("plain"))).toBeUndefined();
    expect(telegramErrorDetails(Object.assign(new Error("x"), {
      telegramErrorCode: "403",
      telegramDescription: "Forbidden",
    }))).toBeUndefined();
    expect(telegramErrorDetails(Object.assign(new Error("x"), { telegramErrorCode: 403 }))).toBeUndefined();
    expect(telegramErrorDetails({ error_code: 400, description: "Bad Request" })).toBeUndefined();
    expect(telegramErrorDetails(undefined)).toBeUndefined();
  });
});

describe("破坏性重试的前置条件失效判定", () => {
  test("原始错误与经 Worker 线协议按 name 重建的错误都能识别", () => {
    expect(isTelegramRetryPreconditionChanged(new TelegramRetryPreconditionChangedError())).toBeTrue();
    const rebuilt: Error = new Error("Telegram destructive retry precondition changed.");
    rebuilt.name = "TelegramRetryPreconditionChangedError";
    expect(isTelegramRetryPreconditionChanged(rebuilt)).toBeTrue();
    expect(isTelegramRetryPreconditionChanged(new Error("other"))).toBeFalse();
    expect(isTelegramRetryPreconditionChanged({ name: "TelegramRetryPreconditionChangedError" })).toBeFalse();
  });
});

describe("Bot API 明确拒收判定", () => {
  test("4xx 与 429 视为拒收，两种错误形状都认", () => {
    expect(isTelegramRequestRejected(Object.assign(new Error("x"), {
      error_code: 400,
      description: "Bad Request: query is too old",
    }))).toBeTrue();
    expect(isTelegramRequestRejected(Object.assign(new Error("x"), {
      telegramErrorCode: 429,
      telegramDescription: "Too Many Requests: retry after 3",
    }))).toBeTrue();
  });

  test("5xx、网络失败与本地错误不视为拒收", () => {
    expect(isTelegramRequestRejected(Object.assign(new Error("x"), {
      error_code: 502,
      description: "Bad Gateway",
    }))).toBeFalse();
    expect(isTelegramRequestRejected(new Error("socket hang up"))).toBeFalse();
    expect(isTelegramRequestRejected(undefined)).toBeFalse();
  });
});
