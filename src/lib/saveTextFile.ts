/**
 * Offers `text` to the person as a downloaded file (works without a network).
 * `bom`: put a UTF-8 byte order mark in front, so that editors which guess the encoding (Windows Notepad, for one,
 * opens a plain UTF-8 file as Shift_JIS) show Japanese text correctly. Used for the カスタムテーマ template.
 */
export function saveTextFile(text: string, fileName: string, type = 'application/json', bom = false): void {
  const blob = new Blob(bom ? ['\uFEFF', text] : [text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
