// サンプルを TypeScript の書き方にするための、決まり事（手で決めたものと、書き換えの処理）。通信なし。
//   - 変数の型は、samplesTypes.generated.ts（dev-tools/gen-sample-types.ts が、symbol-sdk の型から割り出して作る）。
//   - ここには、割り出せない・割り出した型が読みにくいものの手書きと、書き換えの処理を置く。
// サンプルは `name = …;` と、const を付けずに書いてある（コンソールで何度も書き直して試せるように）。
// TypeScript にするときは、各サンプルで最初に出てくる行頭の `name = …;` を `let name: 型 = …;` にする
// （let は、前に動かした同じ名前の変数があっても、書き直せる）。2回目以降の代入は、そのまま。

/** 関数を入れる変数は、変数ではなく仮引数に型を付ける（戻り値は割り出しに任せる）。 */
export const FN_PARAMS: Readonly<Record<string, string>> = {
  addCallback: '(channel: string, callback: (data: any) => void)',
  le: '(value: number | bigint, size: number)',
  concat: '(...parts: Uint8Array[])',
  property: '(name: string, value: string)',
  cosignerChange: '(type: sdkNem.models.MultisigAccountModificationType, publicKey: sdkCore.PublicKey)',
  stompFrame: '(command: string, headers: Record<string, string>, body?: string)',
  readFrames: '(text: string)',
  subscribe: '(destination: string, callback: (frame: any) => void)',
};

/** 割り出した型が読みにくい・合わないものの、手書きの型。名前で決める。 */
export const TYPE_OVERRIDES: Readonly<Record<string, string>> = {
  funcs: 'Record<string, Array<(...args: any[]) => void>>',
  ListenerChannelName: 'Record<string, string>',
  decryptMessageData: '{ isDecoded: boolean; message: Uint8Array }',
};

/** 割り出した型の表記をそろえる（Uint8Array<ArrayBuffer> などの細かい指定は外す）。 */
export function normalizeType(t: string): string {
  return t.replace(/Uint8Array<[^<>]*>/g, 'Uint8Array');
}

const ASSIGN_RE = /^([A-Za-z_$][\w$]*) = /;
const ARROW_RE = /^([A-Za-z_$][\w$]* = )(\([^)]*\)|[A-Za-z_$][\w$]*)( =>.*)$/;

/**
 * 各サンプルの中で、最初に出てくる行頭の `name = …` を `let name: 型 = …` にする。
 * typeOf が undefined / 空を返した名前は、型を付けずに `let name = …` にする（型の割り出しに使う）。
 * 関数を入れる変数（FN_PARAMS）は、仮引数に型を付ける。
 * hoisted は、ループや関数の中で初めて代入している変数（JavaScript では、宣言なしの代入でグローバルになる）。
 * 先頭のコメントの直後に `let name: 型;` を置いて、宣言する（代入はそのまま）。
 */
export function annotateAssignments(
  code: string,
  typeOf: (name: string) => string | undefined,
  hoisted: Readonly<Record<string, string>> = {},
): { code: string; names: string[] } {
  const seen = new Set<string>();
  const out = code.split('\n').map((line) => {
    const m = ASSIGN_RE.exec(line);
    if (m === null || seen.has(m[1])) return line;
    const name = m[1];
    seen.add(name);
    const fn = FN_PARAMS[name];
    if (fn !== undefined) {
      const a = ARROW_RE.exec(line);
      return a === null ? `let ${line}` : `let ${a[1]}${fn}${a[3]}`;
    }
    const t = typeOf(name);
    return t ? `let ${name}: ${t} = ${line.slice(m[0].length)}` : `let ${line}`;
  });
  const decls = Object.entries(hoisted).filter(([name]) => !seen.has(name)).map(([name, t]) => `let ${name}: ${t};`);
  if (decls.length > 0) {
    let at = 0;
    while (at < out.length && out[at].startsWith('//')) at++;
    out.splice(at, 0, ...decls);
  }
  return { code: out.join('\n'), names: [...seen] };
}
