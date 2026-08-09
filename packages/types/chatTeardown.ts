export type ChatRuntimeOwner = "copy" | "gag" | "aiChat" | "antiRaid";
export type ChatTeardownCallback = (chatId: number) => void | Promise<void>;
