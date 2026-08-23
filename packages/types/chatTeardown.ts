export type ChatRuntimeOwner = "copy" | "gag" | "aiChat" | "antiRaid" | "qa";
export type ChatTeardownReason = "explicitDisable" | "lostAuthority";
export type ChatTeardownCallback = (
  chatId: number,
  reason: ChatTeardownReason
) => void | Promise<void>;
