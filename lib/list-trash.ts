import { db } from "@/lib/db";

// Deleting a list first marks it with deleted_at, so the "Deleted · Undo" toast can bring it
// back exactly as it was (same id, slug, items and place). It is removed for good when the
// toast closes, or, for a tab that closed first, the next time its owner loads or deletes lists.

/** How long a soft-deleted list can be restored. Longer than the toast, to absorb slow networks. */
export const LIST_RESTORE_WINDOW_SECONDS = 120;

const expired = `deleted_at <= datetime('now', '-${LIST_RESTORE_WINDOW_SECONDS} seconds')`;

/** Removes the owner's soft-deleted lists for good: one list by id, or those past the window. */
export async function purgeDeletedLists(owner: string, id?: number) {
  const where = `owner = ? AND deleted_at IS NOT NULL AND ${id === undefined ? expired : "id = ?"}`;
  const args = id === undefined ? [owner] : [owner, id];
  await db().batch(
    [
      { sql: `DELETE FROM list_items WHERE list_id IN (SELECT id FROM lists WHERE ${where})`, args },
      { sql: `DELETE FROM lists WHERE ${where}`, args },
    ],
    "write"
  );
}

/** Undo: true when the list was restored, false once it is gone for good. */
export async function restoreDeletedList(owner: string, id: number) {
  const res = await db().execute({
    sql: `UPDATE lists SET deleted_at = NULL WHERE id = ? AND owner = ? AND deleted_at IS NOT NULL AND NOT (${expired})`,
    args: [id, owner],
  });
  return res.rowsAffected > 0;
}

/**
 * A timestamp the client sends back to restore a removed row in its old place. It must be one
 * SQLite's datetime('now') could have written, and not in the future.
 */
export function restoredTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const ms = Date.parse(value.replace(" ", "T") + "Z");
  return Number.isFinite(ms) && ms <= Date.now() + 60_000 ? value : null;
}
