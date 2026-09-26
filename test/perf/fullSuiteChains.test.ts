import { describe, expect, test } from "bun:test";
import { createStorageChain } from
  "../../scripts/perf/fullSuite/storageChains";
import {
  CHAIN_NAMES,
  PRODUCTION_HOT_PATH_SCENARIOS,
} from "../../scripts/perf/fullSuite/sections";
import type { StorageChainDependencies } from
  "../../scripts/perf/fullSuite/storageChains";
import type { ChainDefinition } from
  "../../scripts/perf/fullSuite/chainDefinition";
import type { StoredTemporaryAdBypassActivity } from
  "../../packages/types/temporaryAdBypass";
import type { AdDetectionMessageContext } from
  "../../packages/types/antiRaid/adDetect";
import type { ChatState } from "../../packages/types/chatState";
import type { DiskIOMessage } from "../../packages/types/diskIO";
import { chatStateOf } from "../helpers/chatState";
import { createCommandChain } from "../../scripts/perf/fullSuite/commandChains";
import type { CommandChainDependencies } from "../../scripts/perf/fullSuite/commandChains";
import type { DeliverCronActionOptions } from "../../packages/cron/delivery";
import type { CronDeliveryOutcome } from "../../packages/types/cron";
import type { EncodedVoiceMessage, VoiceSynthesisResult } from "../../packages/types/aiChat/voiceMessage";

describe("全量性能链路编排", () => {
  test("临时广告免检 CPU 与 durable 场景分别登记且不重名", () => {
    expect(PRODUCTION_HOT_PATH_SCENARIOS)
      .toContain("temporary-whitelist-activity");
    expect(CHAIN_NAMES).toContain("temporary-whitelist-write");
    expect(new Set(PRODUCTION_HOT_PATH_SCENARIOS).size)
      .toBe(PRODUCTION_HOT_PATH_SCENARIOS.length);
    expect(new Set(CHAIN_NAMES).size).toBe(CHAIN_NAMES.length);
  });

  test("durable 场景从资格入口等到精确 ACK，并核验最终记录数", async () => {
    const whitelist: Map<number, unknown> = new Map<number, unknown>();
    const blocklist: Map<number, unknown> = new Map<number, unknown>();
    const temporary: Map<number, unknown> = new Map<number, unknown>();
    const unacknowledged: Set<number> = new Set<number>();
    const rows: StoredTemporaryAdBypassActivity[] = [];
    let readinessCalls: number = 0;
    const dependencies: StorageChainDependencies = {
      chainWarmupOperations: 0,
      chainTemporaryAdBypassWrites: 1,
      benchmarkChatId: (index: number): number => -1_000 - index,
      benchmarkUserId: (index: number): number => 10_000 + index,
      ensureAdDetectAgentConfig: (): never => {
        readinessCalls++;
        return undefined as never;
      },
      hydrateIdentityStorageCounts: (): void => {},
      whitelistEntryCache: whitelist as never,
      blocklistEntryCache: blocklist as never,
      temporaryAdBypassActivityCache: temporary as never,
      unacknowledgedTemporaryAdBypassWrites: unacknowledged as never,
      recordEligibleTemporaryAdBypassActivity: ({
        message,
      }: AdDetectionMessageContext): boolean => {
        expect(message.text).toBe("性能基准普通群发言");
        const id: number = message.from!.id;
        unacknowledged.add(id);
        rows.push({
          id,
          adBypass: false,
          adBypassGrantedAt: null,
          qualifiedDays: 0,
          sendCount: 1,
          countedAt: 1_800_000_000_000,
          qualifiedAt: null,
        });
        return true;
      },
      flushDiskIODomain: async (): Promise<"flushed"> => {
        unacknowledged.clear();
        return "flushed";
      },
      readIdentityPolicies: async (): Promise<{
        readonly whitelist: readonly [];
        readonly blocklist: readonly [];
        readonly temporaryAdBypass: readonly StoredTemporaryAdBypassActivity[];
      }> => ({ whitelist: [], blocklist: [], temporaryAdBypass: rows }),
    } as unknown as StorageChainDependencies;
    const definition: ChainDefinition = createStorageChain(
      "temporary-whitelist-write",
      dependencies
    )!;

    await definition.prepare?.();
    await definition.run(0);
    await definition.verify?.();

    expect(readinessCalls).toBe(1);
    expect(whitelist.has(10_000)).toBeTrue();
    expect(blocklist.has(10_000)).toBeTrue();
    expect(temporary.has(10_000)).toBeTrue();
    expect(unacknowledged.size).toBe(0);
    expect(rows).toHaveLength(1);
  });
});

test.each(["complete", "missing", "stale"])("AI 快照链路先持久化群行，并拒绝未落盘或旧内容：%s", async (outcome: string): Promise<void> => {
  const states: Map<number, ChatState> = new Map<number, ChatState>();
  const durableStates: Set<number> = new Set<number>();
  const snapshots: Map<number, string> = new Map<number, string>();
  const writes: string[] = [];
  let pending: Readonly<{ chatId: number; snapshot: string }> | undefined;
  const dependencies: StorageChainDependencies = {
    stateManagedChatLimit: 2,
    chainWarmupOperations: 2,
    chainAiMemorySnapshots: 4,
    benchmarkChatId: (index: number): number => -1_000 - index,
    buildAiMemorySnapshot: (sequence: number): string => `snapshot-${sequence}`,
    getOrCreateChatState: (chatId: number): ChatState => {
      let state: ChatState | undefined = states.get(chatId);
      if (state === undefined) {
        state = chatStateOf();
        states.set(chatId, state);
      }
      return state;
    },
    persistChatState: async (chatId: number): Promise<void> => {
      await Promise.resolve();
      expect(states.get(chatId)).toMatchObject({ isInitEnabled: true, isAIChatEnabled: true });
      durableStates.add(chatId);
    },
    postDiskIO: (message: DiskIOMessage): boolean => {
      if (message.type !== "aiMemory") throw new Error("Unexpected benchmark message");
      expect(durableStates.has(message.chatId)).toBeTrue();
      pending = { chatId: message.chatId, snapshot: message.snapshot };
      return true;
    },
    flushDiskIODomain: async (domain: string): Promise<"flushed"> => {
      expect(domain).toBe("aiMemory");
      if (pending === undefined) throw new Error("Missing pending write");
      snapshots.set(pending.chatId, pending.snapshot);
      writes.push(pending.snapshot);
      pending = undefined;
      return "flushed";
    },
    readBenchmarkAiMemories: (): ReadonlyMap<number, string> => snapshots,
  } as unknown as StorageChainDependencies;
  const definition: ChainDefinition = createStorageChain("ai-memory-snapshot", dependencies)!;
  await definition.prepare!();
  for (let sequence: number = 0; sequence < 6; sequence++) await definition.run(sequence);
  expect(writes).toEqual(["snapshot-0", "snapshot-1", "snapshot-2", "snapshot-3", "snapshot-4", "snapshot-5"]);
  if (outcome === "missing") snapshots.delete(-1_000);
  if (outcome === "stale") snapshots.set(-1_000, "snapshot-2");
  if (outcome === "complete") expect((): void => { definition.verify!(); }).not.toThrow();
  else expect((): void => { definition.verify!(); }).toThrow(outcome === "missing" ? "persisted 1 of 2" : "final snapshot");
});

describe("cron 语音链路", () => {
  const ENCODED: EncodedVoiceMessage = { bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]), durationSeconds: 11 };
  const VOICE: VoiceSynthesisResult = { ok: true, voice: ENCODED };

  function voiceChain(overrides: Partial<CommandChainDependencies>): {
    definition: ChainDefinition;
    calls: Map<string, number>;
    geminiClients: { current: unknown };
  } {
    const calls: Map<string, number> = new Map<string, number>();
    const geminiClients: { current: unknown } = { current: null };
    const dependencies: CommandChainDependencies = {
      chainCronVoiceCommands: 1,
      cronVoiceWarmupOperations: 0,
      cronVoicePcmBytes: 480,
      benchmarkChatId: (index: number): number => -1_000 - index,
      ensureAgentDeploymentConfig: async (): Promise<void> => {},
      geminiClientCache: geminiClients as never,
      ttsDailyUsage: { current: { windowStartedAt: Date.now(), count: 100 } },
      cannedTelegramCalls: calls,
      resolveSpeechSynthesizer: () => ({ ok: true, synthesize: async () => null }),
      synthesizeVoiceMessage: async (): Promise<VoiceSynthesisResult> => VOICE,
      deliverCronAction: async (options: DeliverCronActionOptions): Promise<CronDeliveryOutcome> => {
        expect(options.voices.get(options.action)).toEqual({ voice: ENCODED, fileId: undefined });
        calls.set("sendVoice", (calls.get("sendVoice") ?? 0) + 1);
        return { kind: "sent" };
      },
      ...overrides,
    } as unknown as CommandChainDependencies;
    return { definition: createCommandChain("cron-send-voice", dependencies)!, calls, geminiClients };
  }

  test("罐头 WAV 装进 tts 客户端，合成结果登记进本轮语音表后经 cron 边界发出", async () => {
    const { definition, calls, geminiClients } = voiceChain({});
    await definition.prepare?.();
    const client = (geminiClients.current as Map<string, { interactions: { create(): Promise<unknown> } }>).get("tts")!;
    const response = await client.interactions.create() as { output_audio: { data: string; mime_type: string } };
    expect(response.output_audio.mime_type).toBe("audio/wav");
    expect(new TextDecoder().decode(Uint8Array.fromBase64(response.output_audio.data).subarray(0, 4))).toBe("RIFF");
    await definition.run(0);
    expect(calls.get("sendVoice")).toBe(1);
  });

  test("合成失败、投递未成功或没有真正发出语音都使基准失败", async () => {
    const failed = voiceChain({ synthesizeVoiceMessage: async () => ({ ok: false, reason: "synthesis failed" }) });
    await failed.definition.prepare?.();
    await expect(failed.definition.run(0)).rejects.toThrow("produced no voice: synthesis failed");

    const undelivered = voiceChain({ deliverCronAction: async () => ({ kind: "permanent", detail: "403" }) });
    await undelivered.definition.prepare?.();
    await expect(undelivered.definition.run(0)).rejects.toThrow("was not delivered: permanent");

    const silent = voiceChain({ deliverCronAction: async () => ({ kind: "sent" }) });
    await silent.definition.prepare?.();
    await expect(silent.definition.run(0)).rejects.toThrow("produced no outgoing voice message");

    const unavailable = voiceChain({ resolveSpeechSynthesizer: () => ({ ok: false, reason: "tts unconfigured", providerName: undefined }) });
    await expect(unavailable.definition.prepare?.()).rejects.toThrow("speech synthesis is unavailable: tts unconfigured");
  });

  test("链路登记进出数顺序", () => {
    expect(CHAIN_NAMES).toContain("cron-send-voice");
  });
});
