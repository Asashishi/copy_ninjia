/**
 * 指令处理入口：packages/commands/ 下各 /指令 处理器的统一出口，
 * app/registerHandlers.ts 只从这里接线，不直接触及内部模块。
 */
export { handleCjkActionCommand, handleCjkActionUsageCommand } from "./cjkAction";
export { handleCopyCommand, handleStopCommand } from "./copy";
export { handleResetIconCommand } from "./resetIcon";
export { handleStealIconCommand } from "./stealIcon";
export { handleQuietCommand, handleUnquietCommand } from "./quiet";
export { handleMuteCommand, handleUnmuteCommand } from "./mute";
export {
  handleGagCommand,
  handleGagInlineQuery,
  handleGagMessageIngress,
  handleUngagCommand,
  resetGagSessions,
  teardownGagInChat,
} from "./gag";
export {
  handleQaBoardCallback,
  handleQaMessageIngress,
  handleQueryQaCommand,
  handleRemoveQaCommand,
  handleSetQaCommand,
  teardownQaInChat,
} from "./qa";
export { handleInlineQuery } from "./inline";
export { handleBlockCommand } from "./block";
export { handleBatchKickCommand } from "./batchKick";
export { handleUnblockCommand } from "./unblock";
export { handleAiChatCommand } from "./aiChat";
export { handleAdDetectCommand } from "./adDetect";
export { handleFloodControlCommand } from "./floodControl";
export { handleAntiRaidCommand } from "./antiRaid";
export { handleBotStatusCommand } from "./botStatus";
export { handleQueryMoodCommand, handleSwitchMoodCommand } from "./mood";
export { handleJaCopyCommand } from "./jaCopy";
export { handleInitCommand } from "./init";
export { handleSendCommand } from "./send";
export { handlePermissionCommand } from "./permission";
export { handleWhiteCommand } from "./white";
export { confirmLuckDraw, handleLuckChallengeInlineQuery, handleLuckChosenInlineResult, restoreLuckState } from "./luckChallenge/index";
