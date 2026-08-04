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
export const GLOB_TOOL_NAME = "glob";
export const GREP_TOOL_NAME = "grep";
export const WEB_FETCH_TOOL_NAME = "web_fetch";
export const WEB_SEARCH_TOOL_NAME = "web_search";
export const SPAWN_AGENT_TOOL_NAME = "spawn_agent";
export const SEND_MESSAGE_TOOL_NAME = "send_message";
export const TODO_WRITE_TOOL_NAME = "todo_write";
export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
export const SKILL_LIST_TOOL_NAME = "skill_list";
export const SKILL_SEARCH_TOOL_NAME = "skill_search";
export const SKILL_INVOKE_TOOL_NAME = "skill_invoke";
/** 可执行技能入口（与 skill_invoke 区分） */
export const EXECUTE_SKILL_TOOL_NAME = "execute_skill";
export const TASK_COMPLETE_TOOL_NAME = "task_complete";
