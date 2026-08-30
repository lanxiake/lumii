/**
 * 生成资料/队列删除确认文案。
 */
export function buildWikiRemoveConfirmContent(
  inboxCount: number,
  sourceCount: number,
): string {
  if (inboxCount > 0 && sourceCount > 0) {
    return `将丢弃 ${inboxCount} 条待整理队列条目，并永久删除 ${sourceCount} 条已入库资料，不可恢复。`
  }
  if (inboxCount > 0) {
    return `将丢弃 ${inboxCount} 条待整理队列条目，不可恢复。`
  }
  if (sourceCount === 1) {
    return '将永久删除这条资料，不可恢复。'
  }
  return `将永久删除 ${sourceCount} 条资料，不可恢复。`
}
