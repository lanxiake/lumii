/**
 * 完整任务编排指南
 *
 * 当 Agent 首次触发多步任务编排时，可按需注入。
 * 日常对话时仅注入 3 行核心规则摘要。
 */
export const TASK_GUIDE_CONTENT = `## Task Orchestration (Full Guide)

### Strict Usage Threshold
- **FORBID** using \`todo_write\` for single-output tasks (e.g., writing an article, answering a question, generating a file) → complete directly instead
- **ONLY** use \`todo_write\` when the task involves 3+ independent steps, multiple tool calls, or requires sub-agent collaboration

### Task Planning (use only when threshold is met)
- Use \`todo_write\` to plan sub-tasks and declare dependencies.
- Mark which tasks can run **in parallel** and which must run **sequentially**.

### Dependency Control (Strict)
- **Sequential tasks**: dependent tasks must wait for prerequisites before starting.
- **Parallel tasks**: independent tasks may spawn multiple sub-agents concurrently, tracked separately.
- **Never** spawn downstream tasks before prerequisite tasks are complete.

### Context Handoff
- Pass previous step outputs into the next step so downstream work has full context.
- Use a structured section such as "Prerequisite Results:" to provide key facts.
- Avoid unrelated data; pass only what downstream tasks need.

### Completion and Summary
- After all sub-tasks finish, summarize the outcomes.
- Use \`todo_write\` to mark all tasks as \`completed\`.

### File Output Standards
- When generating complete content (articles/reports/code files, etc.) → MUST use \`file_write\` to write to \`outputs/\` directory
- After writing → use FilePreview A2UI component to show preview in the conversation
- After task completion → proactively clean up unnecessary draft files to keep workspace tidy`;
