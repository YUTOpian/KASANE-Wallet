// Small per-device flags for the backup reminder. Stored in localStorage (every access is
// guarded: the storage can be missing or blocked, in which case the guide just behaves as "not seen").
const backupKey = (profileKey: string) => `kasane.backupDone.${profileKey}`;
// "あとで" only silences the reminder until the app is reloaded.
let backupSnoozed = false;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: the prompt will simply come back */ }
}

export const backupDone = (profileKey: string) => read(backupKey(profileKey)) === '1';
export const markBackupDone = (profileKey: string) => { if (profileKey) write(backupKey(profileKey), '1'); };
export const isBackupSnoozed = () => backupSnoozed;
export const snoozeBackup = () => { backupSnoozed = true; };
