// コンソールの「サンプル」のうち、マルチシグ・監視・オフライン署名・検証のぶんの NEM（NIS1）版。
// Symbol のコード（samples7to13.ts）の写しではなく、NEM のしくみに合わせて書き直したもの。
//   - 書き方は samples.ts の NEM サンプルと同じ（symbol-sdk v3 の symbol-sdk/nem / const を付けない / alice・facade・NODE・sdkCore・sdkNem はそのまま使える）。
//   - 前のサンプルで作った変数（bob・carol1・jsonPayload など）を、次のサンプルで使うものがある。コメントに「先に実行する」サンプルを書いてある。
//   - 自分で作った鍵（bob・carol1…）はコードの中にあるので、確認なしで署名できる。ページを開き直すと消えるので、使い捨てとして使う。
//   - サンプル名は i18n の console.sample_<id>。Symbol と同じ操作のものは、同じ id（名前）を使う。
//
// NEM のマルチシグは、Symbol のアグリゲート（1つのトランザクションに複数の署名を入れる形）ではない。
//   外側: マルチシグトランザクション（連署者の1人が署名する。手数料 0.15 XEM はその人が払う）
//   内側: マルチシグアカウント名義のトランザクション（署名しない。手数料はマルチシグアカウントが払う）
//   連署: ほかの連署者が、内側のトランザクションのハッシュに署名した「連署」トランザクションを、それぞれ別に送る（手数料 0.15 XEM は連署した人が払う）
// 承認に必要な署名の数（minCosignatories）がそろうと、ブロックに入る。連署者の追加・削除は、構成変更のトランザクションを同じ形で送る。
//   - 連署者を追加するときは、追加される人の連署も要る。削除は1回に1人までで、追加と同時には行えない（差替えは、追加と削除の2回）。
//   - マルチシグ化は、そのアカウント自身が署名する普通のトランザクション（連署者の署名は要らない）。元に戻すことはできない。
import type { ConsoleSample } from './samples';

// NIS1 へのアナウンス（body は、署名済みの { data, signature } の JSON）。label は、結果を出すときの前置き（JS の式）。
const announce = (body: string, label = ''): string => `res = await fetch(
  new URL('/transaction/announce', NODE),
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: ${body},
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
console.log(${label}res); // code: 1 が成功（受け付けられた）。それ以外は message に理由が出ます
`;

const indent = (code: string): string => code.split('\n').map((l) => (l === '' ? l : `  ${l}`)).join('\n');

// 外側のマルチシグトランザクションを alice（起案者）が署名して、jsonPayload にする。innerTx（内側）を先に作っておく。
const wrapAndSign = (): string => `
// 内側（署名しない）を、署名欄の無い形にして、外側のマルチシグトランザクションに入れる
innerNonVerifiable = facade.transactionFactory.static.toNonVerifiableTransaction(innerTx);
outerTx = facade.createTransactionFromTypedDescriptor(
  new sdkNem.descriptors.MultisigTransactionV1Descriptor(innerNonVerifiable),  // Txタイプ:マルチシグTx
  alice.publicKey,  // 起案者（連署者の1人）の公開鍵
  150000n,          // 手数料（0.15 XEM。起案者が払います）
  60 * 60 * 2       // Deadline:有効期限(秒単位)
);

// 起案者 alice の署名（外側にだけ署名します）
sig = alice.signTransaction(outerTx); // ← ここで確認ダイアログが開く
jsonPayload = facade.transactionFactory.static.attachSignature(outerTx, sig);
console.log("innerHash:", facade.hashTransaction(innerTx).toString()); // 連署するときに使う、内側のハッシュ
`;

// cosigners（配列）の連署者が、内側のハッシュに連署して、それぞれアナウンスする。innerTx・bob（マルチシグ）を先に作っておく。
const cosignAndAnnounce = (): string => `
// 連署: 連署者が、内側のトランザクションのハッシュに署名して、連署のトランザクションを送る（手数料 0.15 XEM は、連署者が払います）
// 承認に必要な数の署名がそろうと、ブロックに入ります。外側を送ったあとなら、連署はいつでも足せます（期限は 2 時間）
innerHash = facade.hashTransaction(innerTx);
for (i = 0; i < cosigners.length; i++) {
  cosignatureTx = facade.createTransactionFromTypedDescriptor(
    new sdkNem.descriptors.CosignatureV1Descriptor(innerHash, bob.address),  // Txタイプ:連署Tx（内側のハッシュと、マルチシグアカウントのアドレス）
    cosigners[i].publicKey,  // 連署者の公開鍵
    150000n,                 // 手数料（0.15 XEM。連署者が払います）
    60 * 60 * 2              // Deadline:有効期限(秒単位)
  );
  cosignatureSig = facade.signTransaction(cosigners[i].keyPair, cosignatureTx);
  cosignaturePayload = facade.transactionFactory.static.attachSignature(cosignatureTx, cosignatureSig);
${indent(announce('cosignaturePayload', '"cosignature " + (i + 1) + ":", '))}}
`;

// 連署者の追加・削除のサンプルが使う、構成変更の書き方。
const cosignerChange = `// 連署者の追加・削除 1 件分
cosignerChange = (type, publicKey) => new sdkNem.descriptors.SizePrefixedMultisigAccountModificationDescriptor(
  new sdkNem.descriptors.MultisigAccountModificationDescriptor(type, publicKey)
);
`;

// 内側の送金の手数料の計算（NEM の送金は、1 単位 = 0.05 XEM）。amount・message を先に決めておく。
const transferFee = (): string => `// 内側の手数料（マルチシグアカウントが払う。送金の手数料）
//   金額: 10,000 XEM ごとに 1 単位（最低 1 単位、最大 25 単位）/ メッセージ: 32 バイトごとに 1 単位（0〜31 バイトで 1 単位）
amountUnits = amount / 1000000n / 10000n;
if (amountUnits < 1n) amountUnits = 1n;
if (amountUnits > 25n) amountUnits = 25n;
messageUnits = BigInt(Math.floor(new TextEncoder().encode(message).length / 32) + 1);
innerFee = (amountUnits + messageUnits) * 50000n;
`;

// NIS1 の WebSocket に載せる STOMP のフレームの読み書き（「リスナーの準備」で定義する）。
export const NEM_SAMPLES_7_TO_13: ConsoleSample[] = [
  // ---------- マルチシグ ----------
  {
    id: 'multisig_fund',
    code: `// 練習用アカウントの準備: マルチシグの練習に使う使い捨てのアカウントを作って、alice から XEM を送る（承認されてから、次の「マルチシグ化」へ）
// NEM のマルチシグは、手数料を払う人が多くなります。そのぶんの XEM を、それぞれに送っておきます
//   bob    … マルチシグにするアカウント。マルチシグ化の手数料 0.5 XEM と、マルチシグから動かす XEM、内側のトランザクションの手数料を払う
//   carol1 … 連署者。連署のたびに、連署の手数料 0.15 XEM を払う
//   carol2 … 連署者（連署はしない。あとで外す）
//   carol3 … あとで連署者に加える人。加わるときの連署の手数料 0.15 XEM を払う
//   alice  … 連署者（起案者）。マルチシグ名義のトランザクションを起こすたびに、手数料 0.15 XEM を払う
bob = facade.createAccount(sdkCore.PrivateKey.random());
carol1 = facade.createAccount(sdkCore.PrivateKey.random());
carol2 = facade.createAccount(sdkCore.PrivateKey.random());
carol3 = facade.createAccount(sdkCore.PrivateKey.random());
console.log("bob:", bob.address.toString());
console.log("carol1:", carol1.address.toString());
console.log("carol2:", carol2.address.toString());
console.log("carol3:", carol3.address.toString());
// 練習用の使い捨ての鍵です。ページを開き直すと、ここにしか無い鍵は消えます（控えておくと、続きができます）
console.log("bob key:", bob.keyPair.privateKey.toString());
console.log("carol1 key:", carol1.keyPair.privateKey.toString());
console.log("carol2 key:", carol2.keyPair.privateKey.toString());
console.log("carol3 key:", carol3.keyPair.privateKey.toString());

// alice から送る（送る額は 1/1,000,000 XEM 単位。bob 5 XEM、carol1 1 XEM、carol3 1 XEM）。送るたびに確認ダイアログが開きます
// alice に XEM が足りないときは、テストネットなら https://testnet.nem.tools で、alice のアドレスに受け取れます
fundList = [
  [bob, 5000000n],
  [carol1, 1000000n],
  [carol3, 1000000n],
];
for (i = 0; i < fundList.length; i++) {
  fundTx = facade.createTransactionFromTypedDescriptor(
    new sdkNem.descriptors.TransferTransactionV1Descriptor(  // Txタイプ:転送Tx
      fundList[i][0].address,                        // 受取アドレス
      new sdkNem.models.Amount(fundList[i][1])       // 送る額
    ),
    alice.publicKey,  // 署名者公開鍵
    50000n,           // 手数料（0.05 XEM。メッセージなしの送金は、金額の 1 単位だけ）
    60 * 60 * 2       // Deadline:有効期限(秒単位)
  );
  sig = alice.signTransaction(fundTx); // ← ここで確認ダイアログが開く
  jsonPayload = facade.transactionFactory.static.attachSignature(fundTx, sig);
${indent(announce('jsonPayload', '"fund " + (i + 1) + ":", '))}}
`,
  },
  {
    id: 'multisig_create',
    code: `// マルチシグ化: bob を、alice・carol1・carol2 が連署者のマルチシグアカウントにする（承認に必要な署名は 2）
// 先に「練習用アカウントの準備」を実行して、承認されてから実行する（bob が手数料 0.5 XEM を払います）
// NEM のマルチシグ化は、bob 自身が署名する普通のトランザクションです（Symbol のように、連署者の署名を集める必要はありません）
// マルチシグ化は元に戻せません（連署者を減らして、設定を変えることはできます）。bob はこのあと、単独では送金できなくなります
cosignerChange = (type, publicKey) => new sdkNem.descriptors.SizePrefixedMultisigAccountModificationDescriptor(
  new sdkNem.descriptors.MultisigAccountModificationDescriptor(type, publicKey)
);

// マルチシグ設定Tx作成
multisigDescriptor = new sdkNem.descriptors.MultisigAccountModificationTransactionV2Descriptor(  // Txタイプ:マルチシグ設定Tx
  2,  // 承認に必要な署名数の増分（最初は 0 = 全員なので、0 → 2。連署者の数より多くはできません）
  [   // 連署者の変更（追加）
    cosignerChange(sdkNem.models.MultisigAccountModificationType.ADD_COSIGNATORY, alice.publicKey),
    cosignerChange(sdkNem.models.MultisigAccountModificationType.ADD_COSIGNATORY, carol1.publicKey),
    cosignerChange(sdkNem.models.MultisigAccountModificationType.ADD_COSIGNATORY, carol2.publicKey),
  ]
);
multisigTx = facade.createTransactionFromTypedDescriptor(
  multisigDescriptor,  // トランザクション Descriptor 設定
  bob.publicKey,       // マルチシグ化したいアカウントの公開鍵を指定
  500000n,             // 手数料（0.5 XEM。bob が払います）
  60 * 60 * 2          // Deadline:有効期限(秒単位)
);

// bob の署名とアナウンス
sig = facade.signTransaction(bob.keyPair, multisigTx);
jsonPayload = facade.transactionFactory.static.attachSignature(multisigTx, sig);
${announce('jsonPayload')}`,
  },
  {
    id: 'multisig_info',
    code: `// マルチシグ情報の確認: 「マルチシグ化」でできた bob の構成（連署者と、承認に必要な署名数）と、署名待ちのトランザクション、連署者側（carol1）から見た情報
// マルチシグ側から: 連署者は誰か
multisigAccount = await fetch(
  new URL('/account/get?address=' + bob.address.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
cosignatories = multisigAccount.meta.cosignatories || [];
if (cosignatories.length === 0) {
  console.log("まだマルチシグではありません（「マルチシグ化」が承認されてから確認します）");
} else {
  multisigInfo = multisigAccount.account.multisigInfo;
  console.log("minCosignatories:", multisigInfo.minCosignatories, "cosignatoriesCount:", multisigInfo.cosignatoriesCount); // 承認に必要な署名数 / 連署者の数
  for (i = 0; i < cosignatories.length; i++) {
    console.log("cosignatory:", cosignatories[i].address);
  }
}

// 署名待ちのトランザクション（外側が承認待ちのもの）: 署名の数と、承認に必要な数
pendingTxs = await fetch(
  new URL('/account/unconfirmedTransactions?address=' + bob.address.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json.data;
});
for (i = 0; i < pendingTxs.length; i++) {
  if (pendingTxs[i].transaction.type === 4100) { // 0x1004: マルチシグトランザクション
    signatureCount = 1 + (pendingTxs[i].transaction.signatures || []).length; // 外側の起案者 + 連署
    console.log("waiting. innerHash:", pendingTxs[i].meta.innerHash.data, "signatures:", signatureCount);
  }
}

// 連署者側から: どのマルチシグの連署者か（cosignatoryOf に bob が入る）
cosignerAccount = await fetch(
  new URL('/account/get?address=' + carol1.address.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
console.log(cosignerAccount.meta.cosignatoryOf);
`,
  },
  {
    id: 'multisig_send',
    code: `// マルチシグからの送信: マルチシグ化した bob から alice へ、1 XEM とメッセージを送る
// 起案者は alice（外側に署名して、手数料 0.15 XEM を払う）、連署者は carol1（連署の手数料 0.15 XEM を払う）。承認に必要な署名は 2 なので、alice と carol1 で成立
// 動かすのは bob の XEM（内側の手数料も bob が払う）。先に「マルチシグ化」を実行して、承認されてから実行する
cosigners = [carol1]; // 連署する人（alice は起案者として署名するので、ここには入れません）

// 内側のトランザクション: bob から alice への送金（署名しません）
amount = 1000000n;       // 1 XEM
message = "from multisig";
${transferFee()}
innerDescriptor = new sdkNem.descriptors.TransferTransactionV1Descriptor(  // Txタイプ:転送Tx
  alice.address,                                                   // 受取アドレス
  new sdkNem.models.Amount(amount),                                // 送る額
  new sdkNem.descriptors.MessageDescriptor(sdkNem.models.MessageType.PLAIN, message)  // 平文メッセージ
);
innerTx = facade.createTransactionFromTypedDescriptor(
  innerDescriptor,  // トランザクション Descriptor 設定
  bob.publicKey,    // 送信元は、マルチシグ化したアカウント bob
  innerFee,         // 手数料
  60 * 60 * 2       // Deadline:有効期限(秒単位)
);
${wrapAndSign()}
// アナウンス（外側）
${announce('jsonPayload')}${cosignAndAnnounce()}`,
  },
  {
    id: 'multisig_add',
    code: `// 連署者の追加: bob の連署者に、新しい carol3 を加える（承認に必要な署名は 2 のまま。連署者は 3 人 → 4 人）
// 起案者は alice、連署は carol1（承認 2 は、alice と carol1 で成立）。さらに、加わる carol3 の連署も要ります（carol3 が連署の手数料 0.15 XEM を払います）
// 先に「マルチシグ化」を実行して、承認されてから実行する。内側の手数料 0.5 XEM は bob が払います
cosigners = [carol1, carol3]; // 連署する人（carol3 は、加わることに同意する連署）
${cosignerChange}
// マルチシグ設定Tx作成（内側）
multisigDescriptor = new sdkNem.descriptors.MultisigAccountModificationTransactionV2Descriptor(  // Txタイプ:マルチシグ設定Tx
  0,  // 承認に必要な署名数の増分（変えない）
  [   // 連署者の変更（追加）
    cosignerChange(sdkNem.models.MultisigAccountModificationType.ADD_COSIGNATORY, carol3.publicKey),
  ]
);
innerTx = facade.createTransactionFromTypedDescriptor(
  multisigDescriptor,  // トランザクション Descriptor 設定
  bob.publicKey,       // 構成を変えるマルチシグアカウントの公開鍵を指定
  500000n,             // 手数料（0.5 XEM。bob が払います）
  60 * 60 * 2          // Deadline:有効期限(秒単位)
);
${wrapAndSign()}
// アナウンス（外側）
${announce('jsonPayload')}${cosignAndAnnounce()}`,
  },
  {
    id: 'multisig_remove',
    code: `// 連署者の削除: bob の連署者から carol2 を外す（連署者は 4 人 → 3 人。承認に必要な署名は 2 のまま）
// 起案者は alice、連署は carol1（承認 2 は、alice と carol1 で成立）。外される carol2 は署名しません
// 先に「連署者の追加」を実行して、承認されてから実行する。内側の手数料 0.5 XEM は bob が払います
// 削除は 1 回に 1 人までで、追加と同時にはできません。連署者の差替えは「追加」→「削除」の 2 回、縮小は「削除」だけです
// 承認に必要な署名数を変えるときは、増分で書く（例: 下の 0 を -1 にすると、2 → 1）。連署者の数より多い人数は、指定できません
cosigners = [carol1]; // 連署する人
${cosignerChange}
// マルチシグ設定Tx作成（内側）
multisigDescriptor = new sdkNem.descriptors.MultisigAccountModificationTransactionV2Descriptor(  // Txタイプ:マルチシグ設定Tx
  0,  // 承認に必要な署名数の増分（変えない）
  [   // 連署者の変更（削除）
    cosignerChange(sdkNem.models.MultisigAccountModificationType.DELETE_COSIGNATORY, carol2.publicKey),
  ]
);
innerTx = facade.createTransactionFromTypedDescriptor(
  multisigDescriptor,  // トランザクション Descriptor 設定
  bob.publicKey,       // 構成を変えるマルチシグアカウントの公開鍵を指定
  500000n,             // 手数料（0.5 XEM。bob が払います）
  60 * 60 * 2          // Deadline:有効期限(秒単位)
);
${wrapAndSign()}
// アナウンス（外側）
${announce('jsonPayload')}${cosignAndAnnounce()}`,
  },

  // ---------- 監視 ----------
  {
    id: 'listener',
    code: `// リスナーの準備: NIS1 の WebSocket につなぐ（STOMP という決まりで話します。Symbol のような uid のやりとりはありません）。つないだあとに、下の2つの監視サンプルを使う
// WebSocket のエンドポイント: https のノードは wss の 7779 番、http のノードは ws の 7778 番（どちらも /w/messages/websocket）
nodeUrl = new URL(NODE);
wsEndpoint = (nodeUrl.protocol === 'https:'
  ? 'wss://' + nodeUrl.hostname + ':7779'
  : 'ws://' + nodeUrl.hostname + ':7778') + '/w/messages/websocket';
console.log(wsEndpoint);

// STOMP のフレーム: コマンド、ヘッダー、空行、本文、最後に NUL 文字
NUL = '\\u0000';
stompFrame = (command, headers, body) =>
  command + '\\n'
  + Object.keys(headers).map((key) => key + ':' + headers[key] + '\\n').join('')
  + (body ? 'content-length:' + new TextEncoder().encode(body).length + '\\n' : '')
  + '\\n' + (body || '') + NUL;

// 届いたテキストを、フレームに分ける（ハートビートの改行だけのものは、フレームにならない）
readFrames = (text) => text.split(NUL)
  .map((chunk) => chunk.replace(/^[\\r\\n]+/, ''))
  .filter((chunk) => chunk !== '')
  .map((chunk) => {
    headEnd = chunk.search(/\\r?\\n\\r?\\n/);
    headLines = (headEnd === -1 ? chunk : chunk.slice(0, headEnd)).split(/\\r?\\n/);
    frameHeaders = {};
    for (n = 1; n < headLines.length; n++) {
      colon = headLines[n].indexOf(':');
      if (colon > 0 && !frameHeaders.hasOwnProperty(headLines[n].slice(0, colon))) {
        frameHeaders[headLines[n].slice(0, colon)] = headLines[n].slice(colon + 1);
      }
    }
    return {
      command: headLines[0].trim(),
      headers: frameHeaders,
      body: headEnd === -1 ? '' : chunk.slice(headEnd).replace(/^\\r?\\n\\r?\\n/, ''),
    };
  });

// 購読先（/unconfirmed/アドレス など）ごとのコールバック
funcs = {};
subscribeCount = 0;
subscribe = (destination, callback) => {
  if (!funcs.hasOwnProperty(destination)) {
    funcs[destination] = [];
  }
  funcs[destination].push(callback);
  subscribeCount = subscribeCount + 1;
  listener.send(stompFrame('SUBSCRIBE', { id: 'sub-' + subscribeCount, destination: destination }));
};

// WebSocket初期化
pingTimer = 0;
listener = new WebSocket(wsEndpoint);
// つながったら、STOMP の CONNECT を送る
listener.onopen = function() {
  listener.send(stompFrame('CONNECT', { 'accept-version': '1.1,1.0', 'heart-beat': '20000,0' }));
};
// メッセージ受信時処理
listener.onmessage = function(e) {
  readFrames(String(e.data)).forEach((frame) => {
    if (frame.command === 'CONNECTED') {
      console.log("connected.");
      // つなぎっぱなしにするため、20 秒ごとに改行（ハートビート）を送る
      pingTimer = setInterval(() => { listener.send('\\n'); }, 20000);
    } else if (frame.command === 'MESSAGE') {
      // subscribe しているところからのメッセージであれば、コールバックを実行する
      if (funcs.hasOwnProperty(frame.headers.destination)) {
        funcs[frame.headers.destination].forEach((f) => {
          f(JSON.parse(frame.body));
        });
      }
    } else if (frame.command === 'ERROR') {
      console.error(frame.headers.message || frame.body);
    }
  });
};
// エラー時処理
listener.onerror = function(error) {
  console.error(error.data);
};
// クローズ時処理
listener.onclose = function(closeEvent) {
  clearInterval(pingTimer);
  funcs = {};
  console.log(closeEvent);
};

// 監視をやめるときは、listener.close(); を実行します
`,
  },
  {
    id: 'listen_tx',
    code: `// トランザクションの監視: alice 宛て・alice のトランザクションが、未承認になったとき・承認されたときに表示する（先に「リスナーの準備」）
// 先に、どのアカウントを見るか NIS1 に伝える
listener.send(stompFrame('SEND', { destination: '/w/api/account/subscribe' }, "{'account':'" + alice.address.toString() + "'}"));

// 未承認トランザクション検知時の処理（マルチシグの署名待ちも、ここに届きます）
subscribe('/unconfirmed/' + alice.address.toString(), (tx) => {
  console.log("unconfirmed added", tx);
});

// 承認トランザクション検知時の処理
subscribe('/transactions/' + alice.address.toString(), (tx) => {
  console.log("confirmed added", tx);
});
`,
  },
  {
    id: 'listen_block',
    code: `// ブロックの監視: 新しいブロックができるたびに表示する（約1分ごと。先に「リスナーの準備」）
// ブロック生成検知時の処理
subscribe('/blocks/new', (block) => {
  console.log("block", block);
});
`,
  },

  // ---------- オフライン署名 ----------
  {
    id: 'offline_sign',
    code: `// オフライン署名（ペイロードの作成）: alice が署名した、bob のマルチシグからの送金を作る（まだアナウンスしません。通信もしません）
// NEM のペイロードは、アナウンスの本文そのもの { "data": "（署名する中身の16進数）", "signature": "（署名の16進数）" } です
// 先に「マルチシグ化」を実行して、承認されてから実行する。ここでは、bob から alice へ 1 XEM を送る内側を、alice が外側に署名します
amount = 1000000n;   // 1 XEM
message = "offline";
${transferFee()}
innerDescriptor = new sdkNem.descriptors.TransferTransactionV1Descriptor(  // Txタイプ:転送Tx
  alice.address,                                                   // 受取アドレス
  new sdkNem.models.Amount(amount),                                // 送る額
  new sdkNem.descriptors.MessageDescriptor(sdkNem.models.MessageType.PLAIN, message)  // 平文メッセージ
);
innerTx = facade.createTransactionFromTypedDescriptor(
  innerDescriptor,  // トランザクション Descriptor 設定
  bob.publicKey,    // 送信元は、マルチシグ化したアカウント bob
  innerFee,         // 手数料
  60 * 60 * 2       // Deadline:有効期限(秒単位。作ってから 2 時間のうちに、アナウンスします)
);
${wrapAndSign()}
signedHash = facade.hashTransaction(outerTx).toString();
signedInnerHash = facade.hashTransaction(innerTx).toString();
console.log(jsonPayload);
console.log("hash:", signedHash);
`,
  },
  {
    id: 'offline_restore',
    code: `// ペイロードの復元と検証: 「オフライン署名」で作ったペイロードから、トランザクションを復元して、署名とハッシュを確かめる
// 受け取ったペイロードを使うときは、jsonPayload = '{"data": "（16進数）", "signature": "（16進数）"}'; と書き換える（そのとき、下の signedHash・signedInnerHash との一致の確認は、無視してください）
payloadBody = JSON.parse(jsonPayload);
dataBytes = sdkCore.utils.hexToUint8(payloadBody.data);
tx = sdkNem.models.NonVerifiableTransactionFactory.deserialize(dataBytes); // data は、署名欄の無い形のトランザクション
console.log(tx);

// 署名者の署名が正しいか（署名するのは、data のバイト列そのもの）
verifier = new sdkNem.Verifier(tx.signerPublicKey);
res = verifier.verify(dataBytes, new sdkCore.Signature(sdkCore.utils.hexToUint8(payloadBody.signature)));
console.log(res);

// ハッシュ（NEM のハッシュは、data のバイト列の Keccak-256）。署名したときのハッシュと一致するはず
sha3 = await import('https://cdn.skypack.dev/@noble/hashes/sha3');
restoredHash = sdkCore.utils.uint8ToHex(sha3.keccak_256(dataBytes));
console.log(restoredHash.toLowerCase() === signedHash.toLowerCase());

// 内側のハッシュ（連署するときに使う）。外側のマルチシグトランザクションの中の、内側のトランザクションから求める
restoredInnerHash = sdkCore.utils.uint8ToHex(sha3.keccak_256(tx.innerTransaction.serialize()));
console.log(restoredInnerHash.toLowerCase() === signedInnerHash.toLowerCase());
`,
  },
  {
    id: 'offline_cosign',
    code: `// オフラインでの連署: 「ペイロードの復元と検証」で求めた内側のハッシュに、carol1 が連署する（連署のペイロードだけを控える。通信しません）
// 連署するのは、そのマルチシグ（bob）の連署者。連署の手数料 0.15 XEM は carol1 が払います
cosignatureTx = facade.createTransactionFromTypedDescriptor(
  new sdkNem.descriptors.CosignatureV1Descriptor(new sdkCore.Hash256(restoredInnerHash), bob.address),  // Txタイプ:連署Tx
  carol1.publicKey,  // 連署者の公開鍵
  150000n,           // 手数料（0.15 XEM。連署者が払います）
  60 * 60 * 2        // Deadline:有効期限(秒単位)
);
cosignatureSig = facade.signTransaction(carol1.keyPair, cosignatureTx);
cosignaturePayload = facade.transactionFactory.static.attachSignature(cosignatureTx, cosignatureSig);
console.log(cosignaturePayload);
`,
  },
  {
    id: 'offline_announce',
    code: `// 連署を足してアナウンス: alice が署名した外側のペイロード（jsonPayload）と、carol1 の連署（cosignaturePayload）を、順にノードへ送る（先に「オフラインでの連署」）
// NEM は、Symbol のように連署を 1 つのペイロードに足すのではなく、連署を別のトランザクションとして送ります（先に外側、あとで連署）
${announce('jsonPayload', '"outer:", ')}
// ノードが外側を受け付けてから、連署を送る
await new Promise((resolve) => setTimeout(resolve, 2000));
${announce('cosignaturePayload', '"cosignature:", ')}`,
  },

  // ---------- 検証 ----------
  {
    id: 'verify_payload',
    code: `// ペイロードの検証: 署名済みのペイロード（jsonPayload。「署名とアナウンス」などで作ったもの）から、ハッシュと署名を自分で確かめる
// 他の人から受け取ったペイロードを検証するときは、jsonPayload = '{"data": "（16進数）", "signature": "（16進数）"}'; と書き換える
payloadBody = JSON.parse(jsonPayload);
dataBytes = sdkCore.utils.hexToUint8(payloadBody.data);

tx = sdkNem.models.NonVerifiableTransactionFactory.deserialize(dataBytes);
console.log(tx);

// ハッシュ（NEM のハッシュは、data のバイト列の Keccak-256）
sha3 = await import('https://cdn.skypack.dev/@noble/hashes/sha3');
hash = sdkCore.utils.uint8ToHex(sha3.keccak_256(dataBytes));
console.log(hash);

// 署名者の検証（署名者の公開鍵と、署名が合うか）
verifier = new sdkNem.Verifier(tx.signerPublicKey);
res = verifier.verify(dataBytes, new sdkCore.Signature(sdkCore.utils.hexToUint8(payloadBody.signature)));
console.log(res);

// ノードに、このハッシュのトランザクションがあるか（承認されていれば、ブロックの高さが出ます）
found = await fetch(
  new URL('/transaction/get?hash=' + hash.toLowerCase(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
if (found.transaction) {
  console.log("confirmed. height:", found.meta.height);
} else {
  console.log("まだブロックにありません（アナウンス前か、承認待ちです）");
}
`,
  },
];

/** NEM にもある（Symbol と同じ id の）サンプルの id。 */
export const NEM_EXTRA_SAMPLE_IDS: readonly string[] = NEM_SAMPLES_7_TO_13.map((s) => s.id);
