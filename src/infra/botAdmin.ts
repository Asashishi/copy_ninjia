import type { Context } from "grammy";
import { logger } from "./logger";
import { bot } from "./telegram";
import { deleteChatState, getChatState, getOrCreateChatState, saveStateInBackground } from "./storage/stateStore";
import { botAdminFetches } from "../cache/botAdmin";
import { invalidateAiChat } from "../aiChat";

/**
 * 机器人自己在各群的管理员身份追踪。入群守卫（antiRaid）和 /kick 都需要
 * 管理员权限才有意义：不是管理员时收不到别人的 chat_member 更新、踢不了人
 * 也删不了消息，硬跑只会刷一堆注定失败的 API 报错——所以这两处都以这里的
 * 判定做门控。身份记在各群的 ChatState.botIsAdmin 里（随 state.json 持久
 * 化）：Bot API 无法枚举机器人所在的群，这份记录同时也是「/kick 在所有
 * 管理员群同步生效」的群清单，必须落盘才能跨重启存活。
 *
 * 维护路径有三条，互为补充：
 * 1. my_chat_member 更新（handleMyChatMemberUpdate）——机器人自己被任免/
 *    移出时 Telegram 必发，近实时且权威；
 * 2. 收到别人的 chat_member 更新本身就是管理员身份的证明（Telegram 只向
 *    管理员机器人推送），见 markBotAdminObserved，零成本自愈；
 * 3. 两者都没来过的存量群（比如此功能上线前就已是管理员的群），首次判定
 *    时按需 getChatMember 现查一次并回填（isBotAdminIn）。
 *
 * 三条路径最终都经 recordBotAdminStatus 落盘，而它只认已 /init enable 过
 * 的群：my_chat_member 更新会绕过 index.ts 的 isInitEnabled 网关（机器人被拉进
 * 任何群，不管有没有人 /init，Telegram 都会推送），若不在这里把关，
 * state.json 就会为「只是被拉进去、从没人管过」的群凭空长出条目。
 */

/**
 * 记录一次确证的管理员身份观测结果，与已知值不同时才写入并落盘。
 * 未初始化的群（isInitEnabled !== true）一律不落盘：my_chat_member 更新（机器人
 * 被拉进群/任免管理员）会绕过 index.ts 的 isInitEnabled 网关送到这里，若不设防，
 * 光是被拉进一个群、还没人 /init enable，state.json 就会凭空多出一条只有
 * botIsAdmin 的记录——先于任何超级管理员操作自己"写"进去了。用 getChatState
 * （只读）判定，不经过 getOrCreateChatState，未初始化的群连内存里的 Map
 * 条目都不建。群后续被 /init enable 后，isBotAdminIn 的按需回填分支
 * （见本文件顶部注释的第 3 条路径）会在真正需要时现查一次并正确落盘，
 * 这里的省略不损失任何信息。
 */
function recordBotAdminStatus(chatId: number, isAdmin: boolean): void {
  if (getChatState(chatId).isInitEnabled !== true) return;
  const chatState = getOrCreateChatState(chatId);
  if (chatState.botIsAdmin === isAdmin) return;
  chatState.botIsAdmin = isAdmin;
  saveStateInBackground("bot admin status refresh");
}

/**
 * 处理 my_chat_member 更新（机器人自己在某个聊天里的成员状态变化）：
 * 被授予/撤销管理员、被移出群聊时刷新本群的 botIsAdmin 记录。这类更新
 * 必须显式列进 allowed_updates 才会送达（见 index.ts）。
 */
export function handleMyChatMemberUpdate(ctx: Context): void {
  const update = ctx.myChatMember;
  if (!update) return;
  // 私聊没有管理员概念，频道里机器人不做任何守卫/踢人，都不记录。
  if (update.chat.type !== "group" && update.chat.type !== "supergroup") return;
  if (update.new_chat_member.status === "left" || update.new_chat_member.status === "kicked") {
    invalidateAiChat(update.chat.id, true);
    // 机器人已不在这个群里：删除整条持久化状态（见 deleteChatState 注释），
    // 而不是只把 botIsAdmin 降级为 false——否则该群的 ChatState 条目会随
    // 「加群又退群」永久留存，内存与 state.json 单调增长。
    deleteChatState(update.chat.id);
    return;
  }
  recordBotAdminStatus(update.chat.id, update.new_chat_member.status === "administrator");
}

/**
 * 收到一条别人的 chat_member 更新即证明机器人此刻是该群管理员（Telegram
 * 只向管理员机器人推送这类更新），顺手记录，不打任何 API。
 */
export function markBotAdminObserved(chatId: number): void {
  recordBotAdminStatus(chatId, true);
}

/**
 * 机器人在某群是否为管理员。已有记录（无论真假）直接同步返回；从未记录过
 * 的群现查一次 getChatMember 并回填（带在途去重，同群并发判定共享同一次
 * 请求）。现查失败按「不是管理员」处理（fail closed：门控宁可漏跑一次守卫
 * /拒一次 /kick，也不带着没权限的身份硬跑），且不落盘——下次照常重查。
 *
 * 现查在途期间，若 my_chat_member/chat_member 的权威信号（本文件顶部注释
 * 的路径 1/2）先一步落地：本地事件处理顺序不保证跟 Telegram 内部时序完全
 * 一致，这次现查的响应可能反映的是权威信号到达前的旧快照——回填前重新读
 * 一次当前值，非 undefined 就说明权威信号已经赢了，直接采用它（不用现查
 * 结果覆盖状态，也把它作为这次调用的返回值，保证跟落盘的状态一致）。
 */
export async function isBotAdminIn(chatId: number): Promise<boolean> {
  const known: boolean | undefined = getChatState(chatId).botIsAdmin;
  if (known !== undefined) return known;

  let inFlight = botAdminFetches.get(chatId);
  if (!inFlight) {
    inFlight = bot.api
      .getChatMember(chatId, bot.botInfo.id)
      .then((member) => {
        const currentKnown: boolean | undefined = getChatState(chatId).botIsAdmin;
        if (currentKnown !== undefined) return currentKnown;
        const isAdmin: boolean = member.status === "administrator";
        recordBotAdminStatus(chatId, isAdmin);
        return isAdmin;
      })
      .catch((error: unknown) => {
        logger.error(`Failed to check bot's own admin status in chat ${chatId}:`, error);
        return false;
      })
      .finally(() => botAdminFetches.delete(chatId));
    botAdminFetches.set(chatId, inFlight);
  }
  return inFlight;
}
