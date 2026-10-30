/**
 * 内建工具名称常量
 *
 * 集中声明工具名，避免散落在各个工具文件 / 子 Agent 提示词中硬编码字符串。
 * 参考 CCR src/tools/<tool>/constants.ts 的做法。
 */

export const BASH_TOOL_NAME = "bash";
export const FILE_READ_TOOL_NAME = "file_read";
export const FILE_WRITE_TOOL_NAME = "file_write";
export const FILE_EDIT_TOOL_NAME = "file_edit";
export const LIST_DIR_TOOL_NAME = "list_dir";
export const FILE_MKDIR_TOOL_NAME = "file_mkdir";
export const FILE_MOVE_TOOL_NAME = "file_move";
export const FILE_COPY_TOOL_NAME = "file_copy";
export const GLOB_TOOL_NAME = "glob";
export const GREP_TOOL_NAME = "grep";
export const WEB_FETCH_TOOL_NAME = "web_fetch";
export const WEB_SEARCH_TOOL_NAME = "web_search";
export const SPAWN_AGENT_TOOL_NAME = "spawn_agent";
export const SEND_MESSAGE_TOOL_NAME = "send_message";
export const TODO_WRITE_TOOL_NAME = "todo_write";
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export const SKILL_SEARCH_TOOL_NAME = "skill_search";
/** P2 能力面裁剪：把折叠的工具一次检索取回（恒在常驻位，见 tool-loadout 的 pinned） */
export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const SKILL_INVOKE_TOOL_NAME = "skill_invoke";
/** 可执行技能入口（与 skill_invoke 区分） */
export const EXECUTE_SKILL_TOOL_NAME = "execute_skill";
/** task_complete 恒在常驻位（结束回合是任何 Agent 都需要的），故导出供 tool-loadout 的 pinned 用 */
export const TASK_COMPLETE_TOOL_NAME = "task_complete";const CHANNEL_LIST_TOOL_NAME = "channel_list";
const CHANNEL_SEND_TOOL_NAME = "channel_send";
