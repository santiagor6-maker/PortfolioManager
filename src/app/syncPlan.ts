/** What a sync check should do, given this device's state and the version stored in the cloud. Pure. */
export type SyncAction = 'idle' | 'pull' | 'push' | 'conflict' | 'first-push';

export interface LocalSyncState {
  /** The cloud version this device last matched (0: never synced). */
  baseVersion: number;
  /** Local changes not yet uploaded. */
  dirty: boolean;
}

/**
 * `remote` is the cloud version, 0 when there is no copy. Never merges and never lets an older copy win on its
 * own: both sides changed, or the cloud went back (deleted, recreated, older than what this device saw), is a
 * conflict the user resolves.
 */
export function decideSync(local: LocalSyncState, remote: number): SyncAction {
  if (remote === 0) return local.baseVersion === 0 ? 'first-push' : 'conflict';
  if (remote < local.baseVersion) return 'conflict';
  if (remote === local.baseVersion) return local.dirty ? 'push' : 'idle';
  return local.dirty ? 'conflict' : 'pull';
}
