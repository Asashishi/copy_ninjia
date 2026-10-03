/** 主线程持有的单个机器人发言计数及其独立过期计时器。 */
export interface BotMessageActivity {
  count: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}
