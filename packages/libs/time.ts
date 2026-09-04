import { DAY_MS } from "../consts/diskIO/common";
import { TOKYO_UTC_OFFSET_MS } from "../consts/time";

/**
 * 把毫秒数格式化成中文时长文案，如 90_000 -> "1分30秒"，30_000 -> "30秒"。
 * 秒数向上取整：调用方多是「还要等多久」的倒计时/时限文案，宁可报多一点，
 * 也不要在还剩几百毫秒时报出「0秒」。整千毫秒的常量不受影响。
 */
export function formatMinSec(ms: number): string {
  const totalSeconds: number = Math.ceil(ms / 1000);
  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  if (minutes === 0) return `${seconds}秒`;
  if (seconds === 0) return `${minutes}分钟`;
  return `${minutes}分${seconds}秒`;
}

/** getTokyoDateKey 的格式器：模块加载时构造一次复用（Intl.DateTimeFormat
 *  的构造远贵于 format 调用本身，同下方另外两个格式器的理由）——
 *  日志落盘按条调用它算文件名日期，不能每条日志都重新构造一个格式器。 */
const TOKYO_DATE_KEY_FORMATTER: Intl.DateTimeFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * 毫秒时间戳（缺省当前时刻）对应的东京时区日期串（YYYY-MM-DD）。
 * /luck_challenge 的每日缓存与 diskIOWorker 的运势落盘（按东京日期分文件）
 * 共用同一个日期划分，见 commands/luckChallenge/、workers/diskIOWorker.ts。
 */
export function getTokyoDateKey(date: Date = new Date()): string {
  return TOKYO_DATE_KEY_FORMATTER.format(date);
}

/** 严格判断 YYYY-MM-DD 是否为可往返的公历日期，拒绝 02-30 等归一化输入。 */
export function isCanonicalDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed: Date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * 非负 epoch 毫秒对应的东京自然日序号；用于每消息日期比较，不分配 Date 或进入 ICU。
 * 商与余数分开偏移，避免接近安全整数上限时直接相加溢出。
 */
export function getTokyoDayIndex(timestampMs: number): number {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new RangeError("Tokyo day timestamp must be a non-negative safe integer.");
  }
  const wholeDays: number = Math.floor(timestampMs / DAY_MS);
  const shiftedRemainder: number = timestampMs % DAY_MS + TOKYO_UTC_OFFSET_MS;
  return wholeDays + Math.floor(shiftedRemainder / DAY_MS);
}

/** 时间戳所在东京自然日的 UTC 起点；取余计算避免安全整数上界附近的乘法溢出。 */
export function getTokyoDayStartTimestamp(timestampMs: number): number {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new RangeError("Tokyo day timestamp must be a non-negative safe integer.");
  }
  const shiftedRemainder: number = timestampMs % DAY_MS + TOKYO_UTC_OFFSET_MS;
  return timestampMs - shiftedRemainder % DAY_MS;
}

/**
 * 0~99 的两位零填充串定表；只服务下方固定宽度的时间串。
 *
 * 模块加载时建一次（同本文件那几个 Intl 格式器提到模块级的理由）。月、日、时、
 * 分、秒五个字段每条进滚动记忆的群消息都要取一遍，查表只做一次下标读取，不为
 * 每个字段现造一个补零串。表只在本文件内使用，声明成只读容器，元素是字符串因而
 * 没有更深一层的可写字段。
 */
const TWO_DIGIT_STRINGS: readonly string[] = ((): readonly string[] => {
  const table: string[] = new Array<string>(100);
  for (let value: number = 0; value < 100; value += 1) {
    table[value] = value < 10 ? `0${value}` : `${value}`;
  }
  return table;
})();

/**
 * 毫秒时间戳 → 东京时区的「2026/07/16 21:35:04」。AI 对话缓存条目
 * （BufferedMessage.at）在记录时格式化一次、直接以此形态落盘/入转录行，
 * 模型可直接读，之后拼上下文不再有任何格式化开销。
 *
 * **按固定 UTC+9 算术产出，不走 Intl，也不建 Date。** 这一句跑在每条进滚动记忆
 * 的群消息上（workers/aiChat/bufferedMessage.ts 的 buildBufferedMessage）：既不进
 * ICU 字段格式化，也不为取六个字段先分配一个 Date 再走六次访问器；两位数字段
 * 直接查 TWO_DIGIT_STRINGS，五次「数字转串 + 条件补零」一并省掉。
 *
 * 等价性不是推断出来的：`test/libs/time.test.ts` 拿 53 万个时间戳对拍
 * （1970–2100 均匀采样 + 伪随机散点 + 跨秒/跨分/跨日/闰日/年末各 ±2000 ms
 * 逐毫秒）确认与原 `zh-CN` 格式器逐字符相同。
 *
 * **成立的前提是「只格式化本进程当下的时刻」**：日本 1948-1951 实行过夏令时，
 * 那段时间本函数与 Intl 相差一小时（1950-07-01 03:00 UTC：Intl 给 13:00、
 * 本实现给 12:00）。全部调用点传的都是 `Date.now()` 派生值，落在 1951 之后。
 * 若将来要格式化用户提供的历史时间，必须换回 Intl 并重测。
 *
 * 同文件其余三个格式器仍走 Intl：它们要么按天/按小时调用（getTokyoDateKey、
 * getTokyoHour），要么产出带本地化词汇的长格式（getCurrentTime 的 dateStyle:
 * "full"），算术替换不了，也没有对应的热点证据。
 */
export function formatTokyoTime(timestampMs: number): string {
  const shifted: number = timestampMs + TOKYO_UTC_OFFSET_MS;
  // 自 1970-01-01 起的天序号与当天已过毫秒；`Math.floor` 对 1970 前的负值同样
  // 向下取整，因此余数恒落在 [0, DAY_MS)，1950 年那条边界用例照旧成立。
  const days: number = Math.floor(shifted / DAY_MS);
  // 下面除 days 与 era 之外的商全部落在 [0, 146_096]，取整用 `| 0` 而不是
  // Math.floor：被除数非负时截断即向下取整，而 `| 0` 直接产出 int32，
  // 省掉 Math.floor 那条产出 double 的路径。
  // days 与 era 在 1970 之前是负数，截断会向零取整，必须留 Math.floor。
  const secondOfDay: number = ((shifted - days * DAY_MS) / 1_000) | 0;
  // Howard Hinnant 的 civil_from_days：纯整数运算，不建 Date 也不进 ICU。
  // 以 3 月为年首（shiftedMonth 0=3 月 … 11=2 月），闰日因此落在年末，
  // 月份换回 1~12 时 1、2 月归入下一年。
  const shiftedDays: number = days + 719_468;
  const era: number = Math.floor(shiftedDays / 146_097);
  const dayOfEra: number = shiftedDays - era * 146_097;
  const yearOfEra: number =
    ((dayOfEra - ((dayOfEra / 1_460) | 0) + ((dayOfEra / 36_524) | 0) -
      ((dayOfEra / 146_096) | 0)) / 365) | 0;
  const dayOfYear: number = dayOfEra -
    (365 * yearOfEra + ((yearOfEra / 4) | 0) - ((yearOfEra / 100) | 0));
  const shiftedMonth: number = ((5 * dayOfYear + 2) / 153) | 0;
  const day: number = dayOfYear - (((153 * shiftedMonth + 2) / 5) | 0) + 1;
  const month: number = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  const year: number = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  // 五个下标都由上面的算术封在 0~99 内，`!` 只是让 noUncheckedIndexedAccess
  // 不把定表读出的 `string | undefined` 静默拼成 "undefined"。
  return `${year}/${TWO_DIGIT_STRINGS[month]!}/` +
    `${TWO_DIGIT_STRINGS[day]!} ${TWO_DIGIT_STRINGS[(secondOfDay / 3_600) | 0]!}:` +
    `${TWO_DIGIT_STRINGS[((secondOfDay / 60) | 0) % 60]!}:${TWO_DIGIT_STRINGS[secondOfDay % 60]!}`;
}

/** getTokyoHour 的格式器：模块加载时构造一次复用（理由同上）。hourCycle 显式
 *  指定 h23（0~23），避免部分 ICU 实现在 hour12:false 场景下午夜返回 "24"
 *  而不是 "0" 的已知坑。 */
const TOKYO_HOUR_FORMATTER: Intl.DateTimeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo",
  hourCycle: "h23",
  hour: "numeric",
});

/**
 * 东京时区的小时数（0~23）。心情系统按时段调整心情抽选概率用（见
 * aiChat/ai/mood.ts），接受可选的 date 参数仅为可测试性，生产调用省略即取当前时刻。
 */
export function getTokyoHour(date: Date = new Date()): number {
  const hourPart: string | undefined = TOKYO_HOUR_FORMATTER.formatToParts(date).find((part: Intl.DateTimeFormatPart): boolean => part.type === "hour")?.value;
  // % 24 兜底：即便某些环境仍返回 "24"，也不会产出越界的小时数。
  if (hourPart) return Number(hourPart) % 24;
  // 取不到 hour 段时按固定 UTC+9 算术补，**不能退回 date.getHours()**：那是
  // 宿主本地小时，在非 JST 机器上会静默给出另一个时区的小时数，而调用方
  // （aiChat/ai/mood.ts 的时段分档）拿不到任何异常提示，只会按错档抽心情。
  // 口径与本文件 formatTokyoTime 的固定偏移算术一致；1970 之前时间戳为负，
  // 取余会得到负数，再加一轮 24 归一到 0~23。
  const hour: number = Math.floor((date.getTime() + TOKYO_UTC_OFFSET_MS) / 3_600_000) % 24;
  return (hour + 24) % 24;
}

export interface CurrentTimeResult {
  iso: string;
  timezone: string;
  formatted: string;
}

/** getCurrentTime 的格式器：模块加载时构造一次复用（理由同上）——每次
 *  模型请求拼运行时状态都会调它，构造开销不该按请求付。 */
const TOKYO_FULL_TIME_FORMATTER: Intl.DateTimeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Tokyo",
  dateStyle: "full",
  timeStyle: "medium",
});

/**
 * 获取当前时间。统一用东京时区（UTC+9），与天气工具及群里日常报时口径
 * 保持一致。不是 function calling 工具——当前时间恒定拼进每次模型请求，
 * 模型不需要自己判断要不要查。两条链路经 workers/aiChat/timeSentence.ts
 * 共用同一句措辞，但**落点不同**：
 *
 * - 回复链路拼进 **user 内容**的运行时状态区块（workers/aiChat/runtimeState.ts
 *   的 buildRuntimeStateBlock）。**不得挪回 systemInstruction**：那一段连同
 *   人设与工具声明必须逐字恒定，掺进一个精确到秒的串就等于让稳定前缀每秒
 *   换一次指纹，两家供应商的自动前缀缓存从此全程落空（见
 *   workers/aiChat/replyModel.ts 的头注与 runtimeState.ts 的模块注释）。
 * - 冷历史压缩拼进 **userContent 末尾**、整批转录之后（workers/aiChat/compaction.ts
 *   的 summarizeBatch）。那条路的 systemPrompt 是逐字恒定的 SUMMARY_SYSTEM_PROMPT，
 *   也是该请求唯一可被隐式缓存的前缀段，同样不得掺进这个精确到秒的串。
 */
export function getCurrentTime(): CurrentTimeResult {
  const now: Date = new Date();
  return {
    iso: now.toISOString(),
    timezone: "Asia/Tokyo",
    formatted: TOKYO_FULL_TIME_FORMATTER.format(now),
  };
}
