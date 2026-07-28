/** 广告检测流水线（入群守卫线程侧）的纯数据形状。 */

import type { AdSampleContext } from "../antiRaid";

/** 一条参与广告判定的消息。 */
export interface AdCandidateEntry extends AdSampleContext {
  messageId: number;
  /** 本串内单调递增的序号，判定进度按它记账（见 AdMessageBundle.checkedSeq）。 */
  seq: number;
  /** 已按 AD_DETECT_MESSAGE_MAX_CHARS 截断的正文（文本或图片说明）。 */
  text: string;
  /** Worker 观测时刻；只用于回收去重窗口外已经消费过的上下文。 */
  receivedAt: number;
}

/** 某个发言者在一个群里累积的待检消息串（队列里只排它的键）。 */
export interface AdMessageBundle {
  chatId: number;
  /** 用户 id；频道马甲发言时是该频道的负数 id。 */
  senderId: number;
  /** 处置播报里的展示标签，由主线程按可见发送者算好。 */
  label: string;
  /** 发送者是频道马甲（sender_chat）而非真人。 */
  isChannel: boolean;
  /**
   * 这一串里是否有任何一条是「刚进群、还没通过验证」时发出的。取并集而不是取
   * 最后一条：验证会在窗口内通过，先发广告后通过验证的人不该因此洗白。
   */
  justJoined: boolean;
  entries: AdCandidateEntry[];
  /**
   * 被单 key 条数上限挤出 entries、却从来没送过判定的消息 id。
   *
   * 判定依据（judged）与此刻串里还剩的（entries）都覆盖不到它们，不单独留一份
   * 的话，这些消息既进不了判定也进不了处置的删除集合，命中之后会永久留在群里
   * ——频道马甲尤其如此，banChatSenderChat 没有 revoke_messages。
   * 容量见 AD_DETECT_MAX_PENDING_DELETE_IDS。
   */
  pendingDeleteIds: number[];
  /**
   * 这一串已经因为待删列表撑满而丢过 id。只为让那行错误日志每个发送者最多记
   * 一次：溢出之后**每条**新消息都会再挤掉一个，逐条记就是往 logs/ 里刷屏，
   * 而运维需要知道的只是「这个人有广告删不掉了」这一件事。
   */
  pendingDeleteOverflowed?: boolean;
  /** 下一条消息要用的序号；只增不减，上下文裁剪不回退它。 */
  nextSeq: number;
  /**
   * 已送检过的最大序号；只有序号比它大的消息才值得重新入队。
   *
   * 用序号而不是「已检条数」记账：一次判定要等一趟 DeepSeek 往返，这期间
   * 发送者可能又说了几句，已消费上下文也可能被裁掉。按数组下标记账会把裁剪
   * 腾出来的位置算成「已经检过」，让新消息永远送不出去。
   */
  checkedSeq: number;
}

/** 一次 DeepSeek 判定的结果；请求失败时调用方拿到 null，不做任何处置。 */
export interface AdVerdict {
  isAd: boolean;
  reason: string;
}
