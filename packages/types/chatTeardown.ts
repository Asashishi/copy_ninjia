export type ChatRuntimeOwner = "copy" | "translate" | "gag" | "aiChat" | "antiRaid" | "qa" | "wed";
export type ChatTeardownReason = "explicitDisable" | "lostAuthority";
export type ChatTeardownCallback = (
  chatId: number,
  reason: ChatTeardownReason
) => void | Promise<void>;
