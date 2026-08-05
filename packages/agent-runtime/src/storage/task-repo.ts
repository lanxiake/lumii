/**
 * TaskRepo — 任务列表 CRUD
 *
 * 多 Agent 共享的任务管理，存储在 SQLite tasks 表。
 */

import type { DatabaseAdapter } from "./local-database.js";

// ─── 类型定义 ───

export type TaskStatus = "pending" | "in_progress" | "blocked" | "done" | "cancelled";

export interface TaskRow {
  readonly id: string;
  readonly conversation_id: string | null;
  readonly subject: string;
  readonly description: string | null;
  readonly status: TaskStatus;
  readonly owner: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

// ─── Repo 实现 ───

export class TaskRepo {
  private nextId = 1;

  constructor(private readonly db: DatabaseAdapter) {
    this.loadNextId();
  }

  private loadNextId(): void {
    const row = this.db
      .prepare<{ maxId: number | null }>("SELECT MAX(CAST(id AS INTEGER)) as maxId FROM tasks")
      .get();
    this.nextId = (row?.maxId ?? 0) + 1;
  }

  create(params: {
    readonly conversationId?: string;
    readonly subject: string;
    readonly description?: string;
    readonly owner?: string;
  }): TaskRow {
    const id = String(this.nextId++);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO tasks (id, conversation_id, subject, description, status, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        id,
        params.conversationId ?? null,
        params.subject,
        params.description ?? null,
        params.owner ?? null,
        now,
        now,
      );

    return {
      id,
      conversation_id: params.conversationId ?? null,
      subject: params.subject,
      description: params.description ?? null,
      status: "pending",
      owner: params.owner ?? null,
      created_at: now,
      updated_at: now,
    };
  }

  getById(id: string): TaskRow | undefined {
    return this.db
      .prepare<TaskRow>(
        "SELECT id, conversation_id, subject, description, status, owner, created_at, updated_at FROM tasks WHERE id = ?",
      )
      .get(id);
  }

  list(conversationId?: string): readonly TaskRow[] {
    const cols =
      "id, conversation_id, subject, description, status, owner, created_at, updated_at";
    if (conversationId) {
      return this.db
        .prepare<TaskRow>(
          `SELECT ${cols} FROM tasks WHERE conversation_id = ? ORDER BY CAST(id AS INTEGER)`,
        )
        .all(conversationId);
    }
    return this.db
      .prepare<TaskRow>(`SELECT ${cols} FROM tasks ORDER BY CAST(id AS INTEGER)`)
      .all();
  }

  update(
    id: string,
    updates: {
      readonly status?: TaskStatus;
      readonly owner?: string | null;
      readonly description?: string;
    },
  ): TaskRow | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const status = updates.status ?? existing.status;
    const owner = updates.owner !== undefined ? updates.owner : existing.owner;
    const description = updates.description ?? existing.description;

    this.db
      .prepare(
        `UPDATE tasks SET status = ?, owner = ?, description = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, owner, description, now, id);

    return {
      ...existing,
      status,
      owner,
      description,
      updated_at: now,
    };
  }

  delete(id: string): boolean {
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return result.changes > 0;
  }
}
