// コンソールの「サンプル」。symbol-sdk v3 の書き方で、よく使う操作を順に並べている。
//   - 変数は const を付けずに書く（コンソール上で何度も書き直して試せるように）。
//   - alice は、ウォレットで使っているアカウント。署名（alice.signTransaction(tx)）のたびに確認ダイアログが開く。
//   - facade / NODE / sdkCore / sdkSymbol / clog は最初から使える（準備のコードは書かなくていい）。
//   - 変数は実行をまたいで残るので、前のサンプルで作った bob や tx を、次のサンプルで使う。
// 名前（title）は i18n の console.sample_<id>。
export interface ConsoleSample { id: string; code: string }
import { SAMPLES_7_TO_13, SYMBOL_EXTRA_SAMPLE_IDS } from './samples7to13';
import { NEM_SAMPLES_7_TO_13, NEM_EXTRA_SAMPLE_IDS } from './samplesNem7to13';
export { SYMBOL_EXTRA_SAMPLE_IDS, NEM_EXTRA_SAMPLE_IDS };
/** Symbol にしかないサンプルの id（NEM に当たる操作が無いもの）。Symbol の追加サンプルのうち、NEM 版が無いもの。 */
export const SYMBOL_ONLY_SAMPLE_IDS: readonly string[] = SYMBOL_EXTRA_SAMPLE_IDS.filter((id) => !NEM_EXTRA_SAMPLE_IDS.includes(id));

// 署名とアナウンス（txVar の中身を署名して、ノードに送る）。トランザクションを作るサンプルの最後にそのまま付ける。
const signAndAnnounce = (txVar: string): string => `
// 署名とアナウンス
sig = alice.signTransaction(${txVar}); // ← ここで確認ダイアログが開く
jsonPayload = facade.transactionFactory.static.attachSignature(${txVar}, sig);
res = await fetch(
  new URL('/transactions', NODE),
  {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: jsonPayload,
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
console.log(res);
`;

export const CONSOLE_SAMPLES: ConsoleSample[] = [
  {
    // ノード情報の取得
    id: 'node',
    code: `// ノード情報の取得: つながっているノードの情報
console.log(NODE);
nodeInfo = await fetch(
  new URL('/node/info', NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
console.log(nodeInfo);
`,
  },
  {
    // アカウント
    id: 'account',
    code: `// アカウント: alice は、ウォレットで使っているアカウント（秘密鍵はコードには渡りません）
console.log(alice.address.toString());
console.log(alice.publicKey.toString());

// 対話用の Bob アカウントを新規生成（Bob の鍵はコードの中にあるので、確認なしで署名できます）
bob = facade.createAccount(sdkCore.PrivateKey.random());
console.log(bob.address.toString());
console.log(bob.publicKey.toString());
`,
  },
  {
    // アカウント情報と残高
    id: 'accountinfo',
    code: `// アカウント情報と残高: 所有モザイク一覧の取得
accountInfo = await fetch(
  new URL('/accounts/' + alice.address.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json.account;
});
console.log(accountInfo);

// 表示桁数の調整（可分性を取得して、小数点を入れる）
mosaicAmount = accountInfo.mosaics[0].amount;
mosaicInfo = await fetch(
  new URL('/mosaics/' + accountInfo.mosaics[0].id, NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json.mosaic;
});

divisibility = mosaicInfo.divisibility; // 可分性
if (divisibility > 0) {
  displayAmount = mosaicAmount.slice(0, mosaicAmount.length - divisibility)
  + "." + mosaicAmount.slice(-divisibility);
} else {
  displayAmount = mosaicAmount;
}
console.log(displayAmount);
`,
  },
  {
    // 署名と検証
    id: 'keys',
    code: `// 署名と検証: Bob の秘密鍵でメッセージに署名し、Bob の公開鍵と署名で検証する
bob = facade.createAccount(sdkCore.PrivateKey.random());
payload = new TextEncoder().encode("Hello Symbol!");
signature = bob.keyPair.sign(payload);
console.log(signature.toString());

verifier = new sdkSymbol.Verifier(bob.publicKey);
isVerified = verifier.verify(payload, signature);
console.log(isVerified);
`,
  },
  {
    // 暗号化と復号
    id: 'crypt',
    code: `// 暗号化と復号: alice の秘密鍵・bob の公開鍵で暗号化し、alice の公開鍵・bob の秘密鍵で復号する
// alice の鍵を使う暗号化には、確認ダイアログが開きます（秘密鍵はコードには渡らず、暗号文だけが返ります）
bob = facade.createAccount(sdkCore.PrivateKey.random());

message = 'Hello Symbol!';
encryptedMessage = alice.messageEncoder().encode(bob.publicKey, new TextEncoder().encode(message)); // ← ここで確認ダイアログが開く
console.log(encryptedMessage);

// 復号化（bob は自分で作った鍵なので、確認なしで復号できる）
decryptMessageData = bob.messageEncoder().tryDecode(alice.publicKey, encryptedMessage);
console.log(decryptMessageData);
if (decryptMessageData.isDecoded) {
  decryptMessage = new TextDecoder().decode(decryptMessageData.message);
  console.log(decryptMessage);
} else {
  console.log("decrypt failed!");
}
`,
  },
  {
    // 送金トランザクションの作成
    id: 'tx_create',
    code: `// 送金トランザクションの作成: Bob への送金トランザクション（まだ送りません。送るのは「署名とアナウンス」）
bob = facade.createAccount(sdkCore.PrivateKey.random());
console.log(bob.address.toString());

messageData = "\\0Hello, Symbol!"; // 平文メッセージ
// 暗号文メッセージにするには（確認ダイアログが開く）:
// messageData = alice.messageEncoder().encode(bob.publicKey, new TextEncoder().encode('Hello Symbol!'));

// トランザクション Descriptor 設定
descriptor = new sdkSymbol.descriptors.TransferTransactionV1Descriptor(  // Txタイプ:転送Tx
  bob.address,      // 受取アドレス
  [
    // 1XYM送金（外すと、メッセージだけの送信になります）
    new sdkSymbol.descriptors.UnresolvedMosaicDescriptor(
      new sdkSymbol.models.UnresolvedMosaicId(0xE74B99BA41F4AFEEn),  // symbol.xym のエイリアス
      new sdkSymbol.models.Amount(1000000n)
    )
  ],
  messageData       // メッセージ
);

tx = facade.createTransactionFromTypedDescriptor(
  descriptor,       // トランザクション Descriptor 設定
  alice.publicKey,  // 署名者公開鍵
  100,              // 手数料乗数
  60 * 60 * 2       // Deadline:有効期限(秒単位)
);
console.log(tx);
`,
  },
  {
    // 署名とアナウンス
    id: 'tx_announce',
    code: `// 署名とアナウンス: 「送金トランザクションの作成」で作った tx を送る（先にそれを実行しておく）${signAndAnnounce('tx')}`,
  },
  {
    // ステータスの確認
    id: 'tx_status',
    code: `// ステータスの確認: 「署名とアナウンス」で送った tx のステータスを確認する
body = {
  "hashes": facade.hashTransaction(tx).toString()
};
transactionStatus = await fetch(
  new URL('/transactionStatus', NODE),
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
if (transactionStatus.length <= 0) {
  console.error("not exist tx.");
} else {
  console.log(transactionStatus[0]); // group が confirmed なら承認済み
}

// エクスプローラーなどで確認するときの URL
clog(tx);
`,
  },
  {
    // モザイク生成
    id: 'mosaic',
    code: `// モザイク生成: モザイクを定義して、数量を増やす（アグリゲートトランザクション）
// モザイクフラグ設定
f = sdkSymbol.models.MosaicFlags.NONE.value;
f += sdkSymbol.models.MosaicFlags.SUPPLY_MUTABLE.value; // 供給量変更の可否
// f += sdkSymbol.models.MosaicFlags.TRANSFERABLE.value;   // 第三者への譲渡可否
f += sdkSymbol.models.MosaicFlags.RESTRICTABLE.value;   // 制限設定の可否
f += sdkSymbol.models.MosaicFlags.REVOKABLE.value;      // 発行者からの還収可否
flags = new sdkSymbol.models.MosaicFlags(f);

// ナンス設定
array = new Uint8Array(sdkSymbol.models.MosaicNonce.SIZE);
crypto.getRandomValues(array);
nonce = sdkSymbol.models.MosaicNonce.deserialize(array);

// モザイク定義
mosaicDefDescriptor = new sdkSymbol.descriptors.MosaicDefinitionTransactionV1Descriptor(  // Txタイプ:モザイク定義Tx
  new sdkSymbol.models.MosaicId(sdkSymbol.generateMosaicId(alice.address, nonce.value)),  // モザイクID
  new sdkSymbol.models.BlockDuration(0n), // duration:有効期限（0 = 無期限）
  nonce,  // ナンス
  flags,  // モザイクフラグ
  2       // divisibility:可分性
);
mosaicDefTx = facade.createEmbeddedTransactionFromTypedDescriptor(
  mosaicDefDescriptor,  // トランザクション Descriptor 設定
  alice.publicKey,      // 署名者公開鍵
);

// モザイク変更（数量を増やす）
mosaicChangeDescriptor = new sdkSymbol.descriptors.MosaicSupplyChangeTransactionV1Descriptor( // Txタイプ:モザイク変更Tx
  new sdkSymbol.models.UnresolvedMosaicId(mosaicDefTx.id.value),  // モザイクID
  new sdkSymbol.models.Amount(10000n),                // 数量（可分性 2 なので 100.00）
  sdkSymbol.models.MosaicSupplyChangeAction.INCREASE  // アクション
);
mosaicChangeTx = facade.createEmbeddedTransactionFromTypedDescriptor(
  mosaicChangeDescriptor, // トランザクション Descriptor 設定
  alice.publicKey,        // 署名者公開鍵
);

// 上の2つをまとめて、アグリゲートTx作成
embeddedTransactions = [
  mosaicDefTx,
  mosaicChangeTx
];
descriptor = new sdkSymbol.descriptors.AggregateCompleteTransactionV3Descriptor(
  facade.static.hashEmbeddedTransactions(embeddedTransactions),
  embeddedTransactions
);
aggregateTx = facade.createTransactionFromTypedDescriptor(
  descriptor,       // トランザクション Descriptor 設定
  alice.publicKey,  // 署名者公開鍵
  100,              // 手数料乗数
  60 * 60 * 2,      // Deadline:有効期限(秒単位)
  0                 // 連署者数
);
console.log("モザイクID:", mosaicDefTx.id.value.toString(16).toUpperCase());
${signAndAnnounce('aggregateTx')}`,
  },
  {
    // ネームスペースの手数料の計算
    id: 'ns_fee',
    code: `// ネームスペースの手数料の計算: ルートネームスペースのレンタル料
rentalFees = await fetch(
  new URL('/network/fees/rental', NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});

rootNsperBlock = Number(rentalFees.effectiveRootNamespaceRentalFeePerBlock);
rentalDays = 365;
rentalBlock = rentalDays * 24 * 60 * 60 / 30;
rootNsRenatalFeeTotal = rentalBlock * rootNsperBlock;
console.log("rentalBlock:" + rentalBlock);
console.log("rootNsRenatalFeeTotal:" + rootNsRenatalFeeTotal);

// サブネームスペースの取得手数料
childNamespaceRentalFee = Number(rentalFees.effectiveChildNamespaceRentalFee);
console.log(childNamespaceRentalFee);
`,
  },
  {
    // ネームスペースのレンタル
    id: 'namespace',
    code: `// ネームスペースのレンタル: ルートネームスペース（小文字・数字・_ と - が使える。レンタル料がかかります）
// 他の人が使っている名前は取れないので、ランダムな数字を付けています。好きな名前に書き換えてください
name = "mytest" + Math.floor(Math.random() * 100000); // 作成するルートネームスペース

// Tx作成
descriptor = new sdkSymbol.descriptors.NamespaceRegistrationTransactionV1Descriptor(  // Txタイプ:ネームスペース登録Tx
  new sdkSymbol.models.NamespaceId(sdkSymbol.generateNamespaceId(name)),  // ネームスペースID
  sdkSymbol.models.NamespaceRegistrationType.ROOT,  // 登録タイプ : ルートネームスペース
  new sdkSymbol.models.BlockDuration(86400n),       // duration:レンタル期間（ブロック数。約30日）
  undefined,                                        // 親ネームスペース (ルートの場合は省略可)
  name                                              // ネームスペース
);
tx = facade.createTransactionFromTypedDescriptor(
  descriptor,       // トランザクション Descriptor 設定
  alice.publicKey,  // 署名者公開鍵
  100,              // 手数料乗数
  60 * 60 * 2       // Deadline:有効期限(秒単位)
);
console.log("ネームスペース:", name);
${signAndAnnounce('tx')}`,
  },
  // メタデータ・ロック・マルチシグ・監視・制限・オフライン署名・検証（samples7to13.ts）
  ...SAMPLES_7_TO_13,
];

// --- NEM（NIS1） -------------------------------------------------------------------------------------
// Symbol のサンプルと同じ並び・同じ操作（id も同じ）を、NEM の SDK（symbol-sdk/nem）と NIS1 の API で書いたもの。
//   - 名前空間は sdkNem（models / descriptors / Address / calculateTransactionFee …）。facade は NemFacade。
//   - 違い: 手数料は自分で決める（calculateTransactionFee が最小額を計算する）/ アナウンスは POST /transaction/announce /
//     結果は code: 1 が成功 / モザイクは名前空間の下に作る（先に「ネームスペースのレンタル」が要る）。
const nemSignAndAnnounce = (txVar: string): string => `
// 署名とアナウンス
sig = alice.signTransaction(${txVar}); // ← ここで確認ダイアログが開く
jsonPayload = facade.transactionFactory.static.attachSignature(${txVar}, sig);
res = await fetch(
  new URL('/transaction/announce', NODE),
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: jsonPayload,
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
console.log(res); // code: 1 が成功（受け付けられた）。それ以外は message に理由が出ます
`;

export const NEM_CONSOLE_SAMPLES: ConsoleSample[] = [
  {
    // ノード情報の取得
    id: 'node',
    code: `// ノード情報の取得: つながっているノード（NIS1）の情報
console.log(NODE);
nodeInfo = await fetch(
  new URL('/node/info', NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
console.log(nodeInfo);
`,
  },
  {
    // アカウント
    id: 'account',
    code: `// アカウント: alice は、ウォレットで使っているアカウント（秘密鍵はコードには渡りません）
console.log(alice.address.toString());
console.log(alice.publicKey.toString());

// 対話用の Bob アカウントを新規生成（Bob の鍵はコードの中にあるので、確認なしで署名できます）
bob = facade.createAccount(sdkCore.PrivateKey.random());
console.log(bob.address.toString());
console.log(bob.publicKey.toString());
`,
  },
  {
    // アカウント情報と残高
    id: 'accountinfo',
    code: `// アカウント情報と残高: XEM の残高と、所有モザイク一覧の取得
accountInfo = await fetch(
  new URL('/account/get?address=' + alice.address.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json.account;
});
console.log(accountInfo);

// 表示桁数の調整（XEM の可分性は 6。balance は 1/1,000,000 XEM 単位）
xemAmount = String(accountInfo.balance);
divisibility = 6;
displayAmount = xemAmount.padStart(divisibility + 1, "0").slice(0, -divisibility)
  + "." + xemAmount.padStart(divisibility + 1, "0").slice(-divisibility);
console.log(displayAmount + " XEM");

// 所有モザイク（XEM 以外）の一覧
ownedMosaics = await fetch(
  new URL('/account/mosaic/owned?address=' + alice.address.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json.data;
});
console.log(ownedMosaics);

if (ownedMosaics.length > 0) {
  // 1つ目のモザイクの可分性を取得して、小数点を入れる
  mosaicAmount = String(ownedMosaics[0].quantity);
  mosaicId = ownedMosaics[0].mosaicId; // { namespaceId, name }
  mosaicInfo = await fetch(
    new URL('/namespace/mosaic/definition/page?namespace=' + mosaicId.namespaceId + '&pageSize=100', NODE),
    {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }
  )
  .then((res) => res.json())
  .then((json) => {
    return json.data.map((d) => d.mosaic).find((m) => m.id.name === mosaicId.name);
  });

  divisibility = Number(mosaicInfo.properties.find((p) => p.name === 'divisibility').value); // 可分性
  if (divisibility > 0) {
    padded = mosaicAmount.padStart(divisibility + 1, "0");
    displayAmount = padded.slice(0, -divisibility) + "." + padded.slice(-divisibility);
  } else {
    displayAmount = mosaicAmount;
  }
  console.log(mosaicId.namespaceId + ":" + mosaicId.name + " = " + displayAmount);
}
`,
  },
  {
    // 署名と検証
    id: 'keys',
    code: `// 署名と検証: Bob の秘密鍵でメッセージに署名し、Bob の公開鍵と署名で検証する
bob = facade.createAccount(sdkCore.PrivateKey.random());
payload = new TextEncoder().encode("Hello NEM!");
signature = bob.keyPair.sign(payload);
console.log(signature.toString());

verifier = new sdkNem.Verifier(bob.publicKey);
isVerified = verifier.verify(payload, signature);
console.log(isVerified);
`,
  },
  {
    // 暗号化と復号
    id: 'crypt',
    code: `// 暗号化と復号: alice の秘密鍵・bob の公開鍵で暗号化し、alice の公開鍵・bob の秘密鍵で復号する
// alice の鍵を使う暗号化には、確認ダイアログが開きます（秘密鍵はコードには渡らず、暗号文だけが返ります）
bob = facade.createAccount(sdkCore.PrivateKey.random());

message = 'Hello NEM!';
encryptedMessage = alice.messageEncoder().encode(bob.publicKey, new TextEncoder().encode(message)); // ← ここで確認ダイアログが開く
console.log(encryptedMessage);

// 復号化（bob は自分で作った鍵なので、確認なしで復号できる）
decryptMessageData = bob.messageEncoder().tryDecode(alice.publicKey, encryptedMessage);
console.log(decryptMessageData);
if (decryptMessageData.isDecoded) {
  decryptMessage = new TextDecoder().decode(decryptMessageData.message);
  console.log(decryptMessage);
} else {
  console.log("decrypt failed!");
}
`,
  },
  {
    // 送金トランザクションの作成
    id: 'tx_create',
    code: `// 送金トランザクションの作成: Bob への送金トランザクション（まだ送りません。送るのは「署名とアナウンス」）
bob = facade.createAccount(sdkCore.PrivateKey.random());
console.log(bob.address.toString());

// 平文メッセージ
messageData = new sdkNem.descriptors.MessageDescriptor(sdkNem.models.MessageType.PLAIN, "Hello, NEM!");
// 暗号文メッセージにするには（確認ダイアログが開く）:
// encrypted = alice.messageEncoder().encode(bob.publicKey, new TextEncoder().encode('Hello NEM!'));
// messageData = new sdkNem.descriptors.MessageDescriptor(sdkNem.models.MessageType.ENCRYPTED, encrypted.message);

// トランザクション Descriptor 設定
descriptor = new sdkNem.descriptors.TransferTransactionV1Descriptor(  // Txタイプ:転送Tx
  bob.address,                         // 受取アドレス
  new sdkNem.models.Amount(1000000n),  // 1XEM送金（0n にすると、メッセージだけの送信になります）
  messageData                          // メッセージ
);

tx = facade.createTransactionFromTypedDescriptor(
  descriptor,       // トランザクション Descriptor 設定
  alice.publicKey,  // 署名者公開鍵
  0n,               // 手数料（下で計算して入れます）
  60 * 60 * 2       // Deadline:有効期限(秒単位)
);

// 手数料の計算（NEM の送金は、1 単位 = 0.05 XEM）
//   金額: 10,000 XEM ごとに 1 単位（最低 1 単位、最大 25 単位）
//   メッセージ: 32 バイトごとに 1 単位（0〜31 バイトで 1 単位。メッセージなしは 0）
amountUnits = tx.amount.value / 1000000n / 10000n;
if (amountUnits < 1n) amountUnits = 1n;
if (amountUnits > 25n) amountUnits = 25n;
messageUnits = tx.message ? BigInt(Math.floor(tx.message.message.length / 32) + 1) : 0n;
tx.fee = new sdkNem.models.Amount((amountUnits + messageUnits) * 50000n);
console.log(tx);
`,
  },
  {
    // 署名とアナウンス
    id: 'tx_announce',
    code: `// 署名とアナウンス: 「送金トランザクションの作成」で作った tx を送る（先にそれを実行しておく）${nemSignAndAnnounce('tx')}`,
  },
  {
    // ステータスの確認
    id: 'tx_status',
    code: `// ステータスの確認: 「署名とアナウンス」で送った tx が承認されたか確認する
hash = facade.hashTransaction(tx).toString().toLowerCase();
confirmedTx = await fetch(
  new URL('/transaction/get?hash=' + hash, NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
if (confirmedTx.transaction) {
  console.log("confirmed. height:", confirmedTx.meta.height); // ブロックに入っている（承認済み）
} else {
  // まだなら、承認待ち（unconfirmed）の中にあるか確認する
  unconfirmedTxs = await fetch(
    new URL('/account/unconfirmedTransactions?address=' + alice.address.toString(), NODE),
    {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }
  )
  .then((res) => res.json())
  .then((json) => {
    return json.data;
  });
  pending = unconfirmedTxs.filter((d) => d.meta.hash.data === hash);
  if (pending.length > 0) {
    console.log("unconfirmed. 次のブロックを待っています");
  } else {
    console.error("not exist tx."); // アナウンスが断られたか、期限切れ
  }
}

// エクスプローラーなどで確認するときの URL
clog(tx);
`,
  },
  {
    // モザイク生成
    id: 'mosaic',
    code: `// モザイク生成: モザイクを定義する（NEM では、自分のネームスペースの下に作ります。レンタル料 10 XEM がかかります）
// 先に「ネームスペースのレンタル」でルートネームスペースを借りておき、その名前を書いてください（承認されてから実行）
parentNamespace = "mytest"; // 自分が持っているネームスペース
mosaicName = "mymosaic";    // モザイク名（小文字・数字・_ と - が使えます）

// モザイクのレンタル料の宛先（ネットワークごとに決まっている、誰も秘密鍵を持たないアドレス）
mosaicSink = networkType === 0x68 ? 'NBMOSAICOD4F54EE5CDMR23CCBGOAM2XSIUX6TRS' : 'TBMOSAICOD4F54EE5CDMR23CCBGOAM2XSJBR5OLC';

property = (name, value) => new sdkNem.descriptors.SizePrefixedMosaicPropertyDescriptor(
  new sdkNem.descriptors.MosaicPropertyDescriptor(name, value)
);

// モザイク定義（初期供給量 100、可分性 2）
definition = new sdkNem.descriptors.MosaicDefinitionDescriptor(
  alice.publicKey,  // 作成者公開鍵
  new sdkNem.descriptors.MosaicIdDescriptor(
    new sdkNem.descriptors.NamespaceIdDescriptor(parentNamespace),  // ネームスペース
    mosaicName                                                      // モザイク名
  ),
  "my first mosaic",  // 説明（空にはできません）
  [
    property('divisibility', '2'),       // 可分性
    property('initialSupply', '100'),    // 初期供給量（整数。可分性 2 なので、表示は 100.00）
    property('supplyMutable', 'true'),   // 供給量変更の可否
    property('transferable', 'true'),    // 第三者への譲渡可否
  ]
);
descriptor = new sdkNem.descriptors.MosaicDefinitionTransactionV1Descriptor(  // Txタイプ:モザイク定義Tx
  definition,
  new sdkNem.Address(mosaicSink),
  new sdkNem.models.Amount(sdkNem.calculateMosaicRentalFee())  // レンタル料（10 XEM）
);
tx = facade.createTransactionFromTypedDescriptor(
  descriptor,       // トランザクション Descriptor 設定
  alice.publicKey,  // 署名者公開鍵
  0n,               // 手数料（下で計算して入れます）
  60 * 60 * 2       // Deadline:有効期限(秒単位)
);
tx.fee = new sdkNem.models.Amount(sdkNem.calculateTransactionFee(tx));
console.log("モザイクID:", parentNamespace + ":" + mosaicName);
${nemSignAndAnnounce('tx')}`,
  },
  {
    // モザイクの数量を増やす。NEM は定義と数量変更が別のトランザクション
    id: 'mosaic_supply',
    code: `// モザイクの数量を増やす: モザイクの数量を増やす（定義が承認されてから実行。先に「モザイク生成」を実行しておく）
descriptor = new sdkNem.descriptors.MosaicSupplyChangeTransactionV1Descriptor(  // Txタイプ:モザイク数量変更Tx
  new sdkNem.descriptors.MosaicIdDescriptor(
    new sdkNem.descriptors.NamespaceIdDescriptor(parentNamespace),
    mosaicName
  ),
  sdkNem.models.MosaicSupplyChangeAction.INCREASE,  // アクション
  new sdkNem.models.Amount(100n)                    // 増やす数量（整数。可分性 2 なので 100.00）
);
tx = facade.createTransactionFromTypedDescriptor(
  descriptor,       // トランザクション Descriptor 設定
  alice.publicKey,  // 署名者公開鍵（モザイクの作成者）
  0n,               // 手数料（下で計算して入れます）
  60 * 60 * 2       // Deadline:有効期限(秒単位)
);
tx.fee = new sdkNem.models.Amount(sdkNem.calculateTransactionFee(tx));
${nemSignAndAnnounce('tx')}`,
  },
  {
    // ネームスペースの手数料の計算
    id: 'ns_fee',
    code: `// ネームスペースの手数料の計算: ネームスペースとモザイクのレンタル料（NEM は固定額。単位は 1/1,000,000 XEM）
rootNsRentalFee = sdkNem.calculateNamespaceRentalFee(true);   // ルートネームスペース（365 日）
console.log("rootNsRentalFee:" + rootNsRentalFee);

// サブネームスペースの取得手数料
childNsRentalFee = sdkNem.calculateNamespaceRentalFee(false);
console.log("childNsRentalFee:" + childNsRentalFee);

// モザイクの定義（作成）手数料
mosaicRentalFee = sdkNem.calculateMosaicRentalFee();
console.log("mosaicRentalFee:" + mosaicRentalFee);

// ルートネームスペースは約 365 日（1 日 1440 ブロック × 365 = 525,600 ブロック）で、期間は選べません
console.log("rentalBlock:" + 1440 * 365);
`,
  },
  {
    // ネームスペースのレンタル
    id: 'namespace',
    code: `// ネームスペースのレンタル: ルートネームスペース（小文字・数字・_ と - が使える。16 文字まで。レンタル料 100 XEM がかかります）
// 他の人が使っている名前は取れないので、ランダムな数字を付けています。好きな名前に書き換えてください
name = "mytest" + Math.floor(Math.random() * 100000); // 作成するルートネームスペース

// ネームスペースのレンタル料の宛先（ネットワークごとに決まっている、誰も秘密鍵を持たないアドレス）
namespaceSink = networkType === 0x68 ? 'NAMESPACEWH4MKFMBCVFERDPOOP4FK7MTBXDPZZA' : 'TAMESPACEWH4MKFMBCVFERDPOOP4FK7MTDJEYP35';

// Tx作成
descriptor = new sdkNem.descriptors.NamespaceRegistrationTransactionV1Descriptor(  // Txタイプ:ネームスペース登録Tx
  new sdkNem.Address(namespaceSink),                              // レンタル料の宛先
  new sdkNem.models.Amount(sdkNem.calculateNamespaceRentalFee(true)),  // レンタル料（ルート: 100 XEM）
  name,                                                           // ネームスペース
  undefined                                                       // 親ネームスペース (ルートの場合は省略可)
);
tx = facade.createTransactionFromTypedDescriptor(
  descriptor,       // トランザクション Descriptor 設定
  alice.publicKey,  // 署名者公開鍵
  0n,               // 手数料（下で計算して入れます）
  60 * 60 * 2       // Deadline:有効期限(秒単位)
);
tx.fee = new sdkNem.models.Amount(sdkNem.calculateTransactionFee(tx));
console.log("ネームスペース:", name);
${nemSignAndAnnounce('tx')}`,
  },
  // マルチシグ・監視・オフライン署名・検証（NEM のしくみに合わせて書いたもの。lib/console/samplesNem7to13.ts）
  ...NEM_SAMPLES_7_TO_13,
];

/** そのチェーンのサンプル。 */
export const consoleSamplesFor = (chain: 'symbol' | 'nem'): ConsoleSample[] => (chain === 'nem' ? NEM_CONSOLE_SAMPLES : CONSOLE_SAMPLES);
