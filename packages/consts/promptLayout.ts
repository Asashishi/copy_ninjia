/**
 * 部署方提示词的目录名与文件名；纯字面量、不读环境变量。运行时路径由 consts/paths.ts 拼出，
 * 发行包必需文件表（consts/release.ts）与二进制自检（scripts/checkBinary.ts）取同一组名字。
 */

/** 部署方提示词目录名，位于项目根下，属部署方数据、不受版本控制。 */
export const PROMPT_DIR_NAME: string = "prompt";
/** 发行包随附的提示词示例目录名，与 PROMPT_DIR_NAME 下的文件一一对应。 */
export const PROMPT_EXAMPLE_DIR_NAME: string = "prompt_example";
/** 自定义 AI 人设的文件名，见 consts/paths.ts 的 PERSONA_PATH。 */
export const PERSONA_FILE_NAME: string = "persona.md";
/** send_voice 工具说明的文件名，见 consts/paths.ts 的 VOICE_TOOL_PROMPT_PATH。 */
export const VOICE_TOOL_PROMPT_FILE_NAME: string = "voice_tool.md";
