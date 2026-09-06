import { beforeEach, describe, expect, test } from "bun:test";
import {
  cachedAdmins,
  candidate,
  classifiedTexts,
  classifyAdText,
  disposeAdSender,
  resetAdDetectQueueHarness,
  warnReferencedAdSender,
} from "../../helpers/adDetectQueueHarness";
import {
  AD_DETECT_MESSAGE_MAX_CHARS,
  AD_DETECT_SENDER_NAME_MAX_CHARS,
} from "../../../packages/consts/antiRaid/adDetect";
import { formatAdSenderName } from "../../../packages/workers/antiRaid/adDetect/senderName";
import type { AdVerdict } from "../../../packages/types/antiRaid/adDetect";
import type { DisposeAdSenderParams } from "../../../packages/workers/antiRaid/adDetect/disposal";
import type { TelegramIdentityMetadata } from "../../../packages/types/identityPolicy";

const { enqueueAdCandidate, runAdDetectBatch, stopAdDetectQueue } =
  await import("../../../packages/workers/antiRaid/adDetect/queue");
const { pendingAdMessages } =
  await import("../../../packages/cache/workers/antiRaid/adDetect");

beforeEach((): void => resetAdDetectQueueHarness(stopAdDetectQueue));

describe("发言者姓名参与广告检测", (): void => {
  for (const field of ["firstName", "lastName"] as const) {
    test(`${field} 含广告而正文正常时送检并按本人广告处置`, async (): Promise<void> => {
      const meta: TelegramIdentityMetadata = {
        firstName: "普通名字",
        lastName: "普通姓氏",
        username: "",
        [field]: "日入过千 加V xxx996",
      };
      classifyAdText.mockImplementation(async (text: string): Promise<AdVerdict> => ({
        isAd: text.includes("日入过千 加V xxx996"), reason: "姓名引流",
      }));
      enqueueAdCandidate(candidate({ meta, text: "大家早上好" }), 1_000);
      await runAdDetectBatch(1_000);

      expect(classifiedTexts).toEqual([`1. ${meta.firstName} ${meta.lastName} 大家早上好`]);
      expect(disposeAdSender).toHaveBeenCalledTimes(1);
      expect(warnReferencedAdSender).not.toHaveBeenCalled();
      const params: DisposeAdSenderParams = disposeAdSender.mock.calls[0]![0] as DisposeAdSenderParams;
      expect(params.judged[0]?.text).toBe(`${meta.firstName} ${meta.lastName} 大家早上好`);
      expect(params.judged[0]?.directText).toBe(params.judged[0]?.text);
    });
  }

  test("姓名改变后保留每条消息当时的姓名", async (): Promise<void> => {
    enqueueAdCandidate(candidate({
      meta: { firstName: "日入过千", lastName: "加V xxx996", username: "" },
      text: "早上好",
    }), 1_000);
    enqueueAdCandidate(candidate({
      messageId: 2,
      meta: { firstName: "普通名字", lastName: "", username: "" },
      text: "大家好",
    }), 1_001);
    await runAdDetectBatch(1_001);
    expect(classifiedTexts).toEqual(["1. 日入过千 加V xxx996 早上好\n2. 普通名字 大家好"]);
  });

  test("重复引文且姓名未变不重复送检，改名仍保留新的判定入口", async (): Promise<void> => {
    const meta: TelegramIdentityMetadata = { firstName: "普通名字", lastName: "", username: "" };
    enqueueAdCandidate(candidate({ meta, text: "", sampleContext: { quote: "已读引文" } }), 1_000);
    await runAdDetectBatch(1_000);
    enqueueAdCandidate(candidate({
      meta, messageId: 2, text: "", sampleContext: { quote: "已读引文" },
    }), 1_001);
    await runAdDetectBatch(1_001);
    expect(classifiedTexts).toEqual(["1. 普通名字 已读引文"]);
    expect(pendingAdMessages.get("-1001:7")?.entries).toHaveLength(1);

    enqueueAdCandidate(candidate({
      messageId: 3, text: "", sampleContext: { quote: "已读引文" },
      meta: { firstName: "日入过千", lastName: "加V xxx996", username: "" },
    }), 1_002);
    await runAdDetectBatch(1_002);
    expect(classifiedTexts).toHaveLength(2);
    expect(classifiedTexts[1]).toContain("日入过千 加V xxx996");
  });

  test("转发中的本人姓名参与第二次直接归因", async (): Promise<void> => {
    classifyAdText.mockImplementation(async (text: string): Promise<AdVerdict> => ({
      isAd: text.includes("日入过千"), reason: "姓名引流",
    }));
    enqueueAdCandidate(candidate({
      isForwarded: true,
      meta: { firstName: "日入过千", lastName: "加V xxx996", username: "" },
      text: "别人写的正常消息",
    }), 1_000);
    await runAdDetectBatch(1_000);
    expect(classifiedTexts).toEqual([
      "1. 日入过千 加V xxx996 别人写的正常消息",
      "1. 日入过千 加V xxx996",
    ]);
    expect(disposeAdSender).toHaveBeenCalledTimes(1);
    expect(warnReferencedAdSender).not.toHaveBeenCalled();
  });

  test("普通姓名和正常正文不会被引用广告直接归因", async (): Promise<void> => {
    classifyAdText.mockImplementation(async (text: string): Promise<AdVerdict> => ({
      isAd: text.includes("日入过千"), reason: "引用推广",
    }));
    enqueueAdCandidate(candidate({
      meta: { firstName: "普通名字", lastName: "普通姓氏", username: "" },
      text: "这是什么",
      sampleContext: { quote: "日入过千 加V xxx996" },
    }), 1_000);
    await runAdDetectBatch(1_000);
    expect(classifiedTexts).toEqual([
      "1. 普通名字 普通姓氏 这是什么 日入过千 加V xxx996",
      "1. 普通名字 普通姓氏 这是什么",
    ]);
    expect(disposeAdSender).not.toHaveBeenCalled();
    expect(warnReferencedAdSender).toHaveBeenCalledTimes(1);
  });

  test("姓名独立限长，满长正文不会挤掉 first_name 或 last_name", (): void => {
    const filler: string = "文".repeat(AD_DETECT_MESSAGE_MAX_CHARS);
    enqueueAdCandidate(candidate({
      meta: { firstName: "姓".repeat(1_000), lastName: "名".repeat(1_000), username: "" },
      text: filler,
    }), 1_000);
    expect(pendingAdMessages.get("-1001:7")?.entries[0]?.text).toBe(
      `${"姓".repeat(AD_DETECT_SENDER_NAME_MAX_CHARS)} ${"名".repeat(AD_DETECT_SENDER_NAME_MAX_CHARS)} ${filler}`
    );
  });

  test("姓名归一为单行，空字段和截断处代理对保持正确", (): void => {
    expect(formatAdSenderName({ firstName: "张\n三", lastName: "李\t四", username: "" })).toBe("张 三 李 四");
    expect(formatAdSenderName({ firstName: "", lastName: "李四", username: "" })).toBe("李四");
    expect(formatAdSenderName({ firstName: "", lastName: "", username: "" })).toBe("");
    const prefix: string = "名".repeat(AD_DETECT_SENDER_NAME_MAX_CHARS - 1);
    expect(formatAdSenderName({ firstName: `${prefix}😀`, lastName: "", username: "" })).toBe(prefix);
  });

  test("频道马甲不把 Telegram 代发用户姓名或频道标题当作真人姓名", async (): Promise<void> => {
    enqueueAdCandidate(candidate({
      isChannel: true, senderId: -200,
      meta: { firstName: "频道名称", lastName: "代发者", username: "channel" },
      text: "正常频道消息",
    }), 1_000);
    await runAdDetectBatch(1_000);
    expect(classifiedTexts).toEqual(["1. 正常频道消息"]);
  });

  test("已知管理员在姓名整形之前退出", (): void => {
    cachedAdmins.set(-1001, new Set([7]));
    const meta: TelegramIdentityMetadata = {
      get firstName(): string { throw new Error("Unexpected name access"); },
      lastName: "", username: "",
    };
    enqueueAdCandidate(candidate({ meta }), 1_000);
    expect(pendingAdMessages.size).toBe(0);
  });
});
