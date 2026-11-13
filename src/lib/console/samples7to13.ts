// コンソールの「サンプル」のうち、メタデータ・ロック・マルチシグ・監視・制限・オフライン署名・検証のぶん（Symbol のみ）。
// 書き方は samples.ts と同じ（symbol-sdk v3 / const を付けない / alice・facade・NODE・sdkCore・sdkSymbol はそのまま使える）。
//   - 前のサンプルで作った変数（bob・tx・aggregateTx・jsonPayload など）を、次のサンプルで使うものがある。コメントに「先に実行する」サンプルを書いてある。
//   - alice（ウォレットのアカウント）に制限（アドレス制限・モザイク制限・トランザクション制限）はかけない。制限は、使い捨ての carol にだけかける。
//   - 自分で作った鍵（bob・carol・carol1…）はコードの中にあるので、確認なしで署名できる。ページを開き直すと消えるので、使い捨てとして使う。
//   - サンプル名は i18n の console.sample_<id>。他のサンプルを指すときは、サンプル名で書く（章番号は書かない）。
// NEM にも同じ操作があるもの（マルチシグ化・情報の確認・マルチシグからの送信・監視・オフライン署名・ペイロードの検証）は、NEM のしくみに合わせて書き直した版が samplesNem7to13.ts にある。
// NEM に当たる操作が無いもの（メタデータ・ハッシュロック／シークレットロック・各種の制限・マークル証明・ステートの検証など）は、Symbol のまま（samples.ts の SYMBOL_ONLY_SAMPLE_IDS）。
import type { ConsoleSample } from './samples';

// トランザクション（署名済みの JSON・ペイロード）をノードへ PUT する共通部分。path は '/transactions'（普通）か '/transactions/partial'（ボンデッド）。
const put = (path: string, body: string): string => `res = await fetch(
  new URL('${path}', NODE),
  {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: ${body},
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
console.log(res);
`;

// alice が署名して、そのままアナウンス（アグリゲートコンプリートで連署が要らないものと、普通のトランザクション）。
const aliceSignAndAnnounce = (txVar: string): string => `
// 署名とアナウンス
sig = alice.signTransaction(${txVar}); // ← ここで確認ダイアログが開く
jsonPayload = facade.transactionFactory.static.attachSignature(${txVar}, sig);
${put('/transactions', 'jsonPayload')}`;

// 使い捨ての carol を作って、手数料用の XYM を受け取るためのサンプル共通部分（テストネットなら FAUCET の URL を出す）。
const faucetFor = (name: string, amount: number): string => `// ${name} には手数料の XYM が要ります。テストネットなら、次の FAUCET の URL で受け取れます
if (identifier === 'testnet') {
  console.log("https://testnet.symbol.tools/?recipient=" + ${name}.address.toString() + "&amount=${amount}");
} else {
  console.log("${name} に、手数料のぶんの XYM を送ってください:", ${name}.address.toString());
}`;

export const SAMPLES_7_TO_13: ConsoleSample[] = [
  // ---------- メタデータ ----------
  {
    id: 'metadata',
    code: `// アカウントメタデータの登録: alice 自身に、キー "key_account"・値 "test" のメタデータを登録する（アグリゲートトランザクション）
// ターゲットと作成者アドレスの設定
targetAddress = alice.address;  // メタデータ記録先アドレス
sourceAddress = alice.address;  // メタデータ作成者アドレス

// キーと値の設定
key = sdkSymbol.metadataGenerateKey("key_account");
value = new TextEncoder().encode("test");

// 同じキーのメタデータが登録されているか確認
query = new URLSearchParams({
  "targetAddress": targetAddress.toString(),
  "sourceAddress": sourceAddress.toString(),
  "scopedMetadataKey": key.toString(16).toUpperCase(),
  "metadataType": 0
});
metadataInfo = await fetch(
  new URL('/metadata?' + query.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json.data;
});
// 登録済の場合は差分データを作成する
sizeDelta = value.length;
if (metadataInfo.length > 0) {
  sizeDelta -= metadataInfo[0].metadataEntry.valueSize;
  value = sdkSymbol.metadataUpdateValue(sdkCore.utils.hexToUint8(metadataInfo[0].metadataEntry.value), value);
}

// アカウントメタデータ登録Tx作成
descriptor = new sdkSymbol.descriptors.AccountMetadataTransactionV1Descriptor(  // Txタイプ:アカウントメタデータ登録Tx
  targetAddress,  // ターゲットアドレス
  key,            // キー
  sizeDelta,      // サイズ差分
  value           // 値
);
tx = facade.createEmbeddedTransactionFromTypedDescriptor(
  descriptor,       // トランザクション Descriptor 設定
  alice.publicKey,  // 署名者公開鍵
);

embeddedTransactions = [
  tx
];

// アグリゲートTx作成
aggregateDescriptor = new sdkSymbol.descriptors.AggregateCompleteTransactionV3Descriptor(
  facade.static.hashEmbeddedTransactions(embeddedTransactions),
  embeddedTransactions
);
aggregateTx = facade.createTransactionFromTypedDescriptor(
  aggregateDescriptor,  // トランザクション Descriptor 設定
  alice.publicKey,      // 署名者公開鍵
  100,                  // 手数料乗数
  60 * 60 * 2,          // Deadline:有効期限(秒単位)
  0                     // 連署者数
);
${aliceSignAndAnnounce('aggregateTx')}`,
  },
  {
    id: 'metadata_list',
    code: `// メタデータの一覧: alice が alice 自身に登録したメタデータを、キーと値（文字列）で一覧にする
query = new URLSearchParams({
  "targetAddress": alice.address.toString(),
  "sourceAddress": alice.address.toString(),
});
res = await fetch(
  new URL('/metadata?' + query.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
console.log(res);

// キー（16進数）と値（文字列に戻したもの）
res.data.forEach(m => {
  console.log(
    m.metadataEntry.scopedMetadataKey,
    new TextDecoder().decode(sdkCore.utils.hexToUint8(m.metadataEntry.value))
  );
});
`,
  },

  // ---------- ロック ----------
  {
    id: 'bonded',
    code: `// アグリゲートボンデッドの作成: alice → bob への 1XYM と、bob → alice へのメッセージを、1つのトランザクションにまとめる
// 連署が必要なので、アナウンスの前にハッシュロックが要る（次の「ハッシュロック」）。ここでは作って、alice が署名するところまで
bob = facade.createAccount(sdkCore.PrivateKey.random());
console.log(bob.address.toString());

namespaceIds = sdkSymbol.generateNamespacePath("symbol.xym");
namespaceId = namespaceIds[namespaceIds.length - 1];

// アグリゲートTxに含めるTxを作成
descriptor1 = new sdkSymbol.descriptors.TransferTransactionV1Descriptor(  // Txタイプ:転送Tx
  bob.address,      // Bobへの送信
  [
    // 1XYM送金
    new sdkSymbol.descriptors.UnresolvedMosaicDescriptor(
      new sdkSymbol.models.UnresolvedMosaicId(namespaceId),
      new sdkSymbol.models.Amount(1000000n)
    )
  ],
  new Uint8Array()  // メッセージ無し
);
tx1 = facade.createEmbeddedTransactionFromTypedDescriptor(
  descriptor1,      // トランザクション Descriptor 設定
  alice.publicKey   // Aliceから
);

descriptor2 = new sdkSymbol.descriptors.TransferTransactionV1Descriptor(  // Txタイプ:転送Tx
  alice.address,    // Aliceへの送信
  [],
  new TextEncoder().encode('thank you!') // 平文メッセージ
);
tx2 = facade.createEmbeddedTransactionFromTypedDescriptor(
  descriptor2,      // トランザクション Descriptor 設定
  bob.publicKey     // Bobから
);

embeddedTransactions = [
  tx1,
  tx2
];

// アグリゲートTx作成
aggregateDescriptor = new sdkSymbol.descriptors.AggregateBondedTransactionV3Descriptor(
  facade.static.hashEmbeddedTransactions(embeddedTransactions),
  embeddedTransactions
);
aggregateTx = facade.createTransactionFromTypedDescriptor(
  aggregateDescriptor,  // トランザクション Descriptor 設定
  alice.publicKey,      // 署名者公開鍵
  100,                  // 手数料乗数
  60 * 60 * 2,          // Deadline:有効期限(秒単位)
  1                     // 連署者数
);

// 署名（まだ送りません）
sig = alice.signTransaction(aggregateTx); // ← ここで確認ダイアログが開く
jsonPayload = facade.transactionFactory.static.attachSignature(aggregateTx, sig);
console.log(facade.hashTransaction(aggregateTx).toString());
`,
  },
  {
    id: 'hash_lock',
    code: `// ハッシュロック: 「アグリゲートボンデッドの作成」で作った aggregateTx のハッシュをロックする（10XYM。承認されれば返ってきます）
// 先に「アグリゲートボンデッドの作成」を実行しておく
namespaceIds = sdkSymbol.generateNamespacePath("symbol.xym");
namespaceId = namespaceIds[namespaceIds.length - 1];

// ハッシュロックTx作成
hashLockDescriptor = new sdkSymbol.descriptors.HashLockTransactionV1Descriptor( // Txタイプ:ハッシュロックTx
  new sdkSymbol.descriptors.UnresolvedMosaicDescriptor(
    new sdkSymbol.models.UnresolvedMosaicId(namespaceId), // UnresolvedMosaic:未解決モザイク
    new sdkSymbol.models.Amount(10n * 1000000n)           // 10xym固定値
  ),
  new sdkSymbol.models.BlockDuration(480n),               // ロック有効期限
  facade.hashTransaction(aggregateTx)                     // アグリゲートトランザクションのハッシュ値を登録
);
hashLockTx = facade.createTransactionFromTypedDescriptor(
  hashLockDescriptor, // トランザクション Descriptor 設定
  alice.publicKey,    // 署名者公開鍵
  100,                // 手数料乗数
  60 * 60 * 2         // Deadline:有効期限(秒単位)
);

// 署名
hashLockSig = alice.signTransaction(hashLockTx); // ← ここで確認ダイアログが開く
hashLockJsonPayload = facade.transactionFactory.static.attachSignature(hashLockTx, hashLockSig);

// ハッシュロックTXをアナウンス（承認されるまで、30秒ほど待ちます）
${put('/transactions', 'hashLockJsonPayload')}`,
  },
  {
    id: 'bonded_announce',
    code: `// ボンデッドのアナウンス: 「ハッシュロック」が承認されたら、アグリゲートボンデッドをアナウンスする
${put('/transactions/partial', 'jsonPayload').replace("new URL('/transactions/partial', NODE),", "new URL('/transactions/partial', NODE), // アグリゲートボンデッドTxはアナウンスする際のURLが違う")}`,
  },
  {
    id: 'bonded_cosign',
    code: `// 連署: 「ボンデッドのアナウンス」で署名待ちになった aggregateTx に、bob が連署する（連署が集まると承認されます）
// アグリゲートボンデッドトランザクションの取得
txInfo = await fetch(
  new URL('/transactions/partial/' + facade.hashTransaction(aggregateTx).toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});

// 連署者の署名
txHash = new sdkCore.Hash256(sdkCore.utils.hexToUint8(txInfo.meta.hash));
cosignature = bob.cosignTransactionHash(txHash, true);

// アナウンス
body = {
  "parentHash": cosignature.parentHash.toString(),
  "signature": cosignature.signature.toString(),
  "signerPublicKey": cosignature.signerPublicKey.toString(),
  "version": cosignature.version.toString()
};
${put('/transactions/cosignature', 'JSON.stringify(body)')}`,
  },
  {
    id: 'secret',
    code: `// シークレットとプルーフの作成: シークレットロックに使う、ロック用キーワード（secret）と解除用キーワード（proof）
bob = facade.createAccount(sdkCore.PrivateKey.random());
console.log(bob.address.toString());
${faucetFor('bob', 10)}  // bob は、解除（シークレットプルーフ）の手数料を払います

sha3_256 = (await import('https://cdn.skypack.dev/@noble/hashes/sha3')).sha3_256; // 同梱の SHA3 が返ります

proof = crypto.getRandomValues(new Uint8Array(20)); // 解除用キーワード
hash = sha3_256.create();
hash.update(proof);
secret = hash.digest();                             // ロック用キーワード
console.log("secret:" + sdkCore.utils.uint8ToHex(secret));
console.log("proof:" + sdkCore.utils.uint8ToHex(proof));
`,
  },
  {
    id: 'secret_lock',
    code: `// シークレットロック: 「シークレットとプルーフの作成」の secret で、bob 宛てに 1XYM をロックする（先に実行しておく）
namespaceIds = sdkSymbol.generateNamespacePath("symbol.xym");
namespaceId = namespaceIds[namespaceIds.length - 1];

// シークレットロックTx作成
lockDescriptor = new sdkSymbol.descriptors.SecretLockTransactionV1Descriptor( // Txタイプ:シークレットロックTx
  bob.address,                                // 解除時の転送先:Bob
  secret,                                     // ロック用キーワード
  new sdkSymbol.descriptors.UnresolvedMosaicDescriptor( // ロックするモザイク
    new sdkSymbol.models.UnresolvedMosaicId(namespaceId),
    new sdkSymbol.models.Amount(1000000n)
  ),
  new sdkSymbol.models.BlockDuration(480n),   // ロック期間(ブロック数)
  sdkSymbol.models.LockHashAlgorithm.SHA3_256 // ロックキーワード生成に使用したアルゴリズム
);
lockTx = facade.createTransactionFromTypedDescriptor(
  lockDescriptor,   // トランザクション Descriptor 設定
  alice.publicKey,  // 署名者公開鍵
  100,              // 手数料乗数
  60 * 60 * 2       // Deadline:有効期限(秒単位)
);
${aliceSignAndAnnounce('lockTx')}
// ロックの確認（承認されてから）
params = new URLSearchParams({
  "secret": sdkCore.utils.uint8ToHex(secret),
});
result = await fetch(
  new URL('/lock/secret?' + params.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
result.data.forEach(lock => {
  console.log(lock);
});
`,
  },
  {
    id: 'secret_proof',
    code: `// シークレットプルーフ: 「シークレットロック」が承認されたら、bob が proof で解除する（bob の署名。確認なし）
proofDescriptor = new sdkSymbol.descriptors.SecretProofTransactionV1Descriptor( // Txタイプ:シークレットプルーフTx
  bob.address,                                  // 解除アカウント（受信アカウント）
  secret,                                       // ロックキーワード
  sdkSymbol.models.LockHashAlgorithm.SHA3_256,  // ロックキーワード生成に使用したアルゴリズム
  proof                                         // 解除用キーワード
);
proofTx = facade.createTransactionFromTypedDescriptor(
  proofDescriptor,  // トランザクション Descriptor 設定
  bob.publicKey,    // 署名者公開鍵
  100,              // 手数料乗数
  60 * 60 * 2       // Deadline:有効期限(秒単位)
);

// 署名
proofSig = bob.signTransaction(proofTx);
proofJsonPayload = facade.transactionFactory.static.attachSignature(proofTx, proofSig);

// シークレットプルーフTXをアナウンス
${put('/transactions', 'proofJsonPayload')}`,
  },

  // ---------- マルチシグ ----------
  {
    id: 'multisig_create',
    code: `// マルチシグ化: 使い捨ての bob を、alice・carol1・carol2 が連署者のマルチシグアカウントにする（承認 2・除名 2）
// 手数料を払うのは、アグリゲートに署名する alice。bob・carol1・carol2 は連署するだけです
bob = facade.createAccount(sdkCore.PrivateKey.random());
carol1 = facade.createAccount(sdkCore.PrivateKey.random());
carol2 = facade.createAccount(sdkCore.PrivateKey.random());
console.log("bob:", bob.address.toString());
console.log("carol1:", carol1.address.toString());
console.log("carol2:", carol2.address.toString());
// 練習用の使い捨ての鍵です。ページを開き直すと、ここにしか無い鍵は消えます（控えておくと、続きができます）
console.log("bob key:", bob.keyPair.privateKey.toString());
console.log("carol1 key:", carol1.keyPair.privateKey.toString());
console.log("carol2 key:", carol2.keyPair.privateKey.toString());

// マルチシグ設定Tx作成
multisigDescriptor = new sdkSymbol.descriptors.MultisigAccountModificationTransactionV1Descriptor(  // Txタイプ:マルチシグ設定Tx
  2,  // minRemoval:除名のために必要な最小署名者数増分
  2,  // minApproval:承認のために必要な最小署名者数増分
  [   // 追加対象アドレスリスト
    alice.address,
    carol1.address,
    carol2.address,
  ],
  []  // 除名対象アドレスリスト
);
multisigTx = facade.createEmbeddedTransactionFromTypedDescriptor(
  multisigDescriptor, // トランザクション Descriptor 設定
  bob.publicKey,      // マルチシグ化したいアカウントの公開鍵を指定
);

embeddedTransactions = [
  multisigTx
];

// アグリゲートTx作成
aggregateDescriptor = new sdkSymbol.descriptors.AggregateCompleteTransactionV3Descriptor(
  facade.static.hashEmbeddedTransactions(embeddedTransactions),
  embeddedTransactions
);
aggregateTx = facade.createTransactionFromTypedDescriptor(
  aggregateDescriptor,  // トランザクション Descriptor 設定
  alice.publicKey,      // 署名者公開鍵（alice は、起案者として署名するので、連署に数えなくていい）
  100,                  // 手数料乗数
  60 * 60 * 2,          // Deadline:有効期限(秒単位)
  3                     // 連署者数（bob・carol1・carol2）
);

// 起案者 alice の署名
sig = alice.signTransaction(aggregateTx); // ← ここで確認ダイアログが開く
jsonPayload = facade.transactionFactory.static.attachSignature(aggregateTx, sig);

// マルチシグ化したいアカウントと、追加する連署者による連署
coSigBob = bob.cosignTransaction(aggregateTx, false);
aggregateTx.cosignatures.push(coSigBob);
coSig1 = carol1.cosignTransaction(aggregateTx, false);
aggregateTx.cosignatures.push(coSig1);
coSig2 = carol2.cosignTransaction(aggregateTx, false);
aggregateTx.cosignatures.push(coSig2);

// アナウンス
${put('/transactions', 'JSON.stringify({"payload": sdkCore.utils.uint8ToHex(aggregateTx.serialize())})')}`,
  },
  {
    id: 'multisig_info',
    code: `// マルチシグ情報の確認: 「マルチシグ化」でできた bob のマルチシグの構成と、連署者側（carol1）から見た情報
// マルチシグ側から: 連署者は誰か
multisigInfo = await fetch(
  new URL('/account/' + bob.address.toString() + '/multisig', NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json.multisig;
});
console.log(multisigInfo);
console.log("minApproval:", multisigInfo.minApproval, "minRemoval:", multisigInfo.minRemoval);

// 連署者側から: どのマルチシグの連署者か（multisigAddresses に bob が入る）
cosignerInfo = await fetch(
  new URL('/account/' + carol1.address.toString() + '/multisig', NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json.multisig;
});
console.log(cosignerInfo);
`,
  },
  {
    id: 'multisig_send',
    code: `// マルチシグからの送信: マルチシグ化した bob から alice へ、1XYM とメッセージを送る（アグリゲートコンプリート）
// 起案者は alice、連署者は carol1（承認は 2 なので、alice と carol1 の 2 人の署名で成立）。先に「マルチシグ化」を実行しておく
// 動かすのは bob の XYM（手数料は、起案者の alice が払う）
${faucetFor('bob', 10)}

namespaceIds = sdkSymbol.generateNamespacePath("symbol.xym");
namespaceId = namespaceIds[namespaceIds.length - 1];

// アグリゲートTxに含めるTxを作成
descriptor = new sdkSymbol.descriptors.TransferTransactionV1Descriptor( // Txタイプ:転送Tx
  alice.address,    // 受取アドレス
  [
    // 1XYM送金
    new sdkSymbol.descriptors.UnresolvedMosaicDescriptor(
      new sdkSymbol.models.UnresolvedMosaicId(namespaceId),
      new sdkSymbol.models.Amount(1000000n)
    )
  ],
  '\\0test'  // 平文メッセージ
);
tx = facade.createEmbeddedTransactionFromTypedDescriptor(
  descriptor,     // トランザクション Descriptor 設定
  bob.publicKey,  // 送信元は、マルチシグ化したアカウント bob
);

embeddedTransactions = [
  tx
];

// アグリゲートTx作成
aggregateDescriptor = new sdkSymbol.descriptors.AggregateCompleteTransactionV3Descriptor(
  facade.static.hashEmbeddedTransactions(embeddedTransactions),
  embeddedTransactions
);
aggregateTx = facade.createTransactionFromTypedDescriptor(
  aggregateDescriptor,  // トランザクション Descriptor 設定
  alice.publicKey,      // 起案者アカウントの公開鍵を指定
  100,                  // 手数料乗数
  60 * 60 * 2,          // Deadline:有効期限(秒単位)
  1                     // 連署者数
);

// 起案者アカウントによる署名
sig = alice.signTransaction(aggregateTx); // ← ここで確認ダイアログが開く
jsonPayload = facade.transactionFactory.static.attachSignature(aggregateTx, sig);

// 連署者アカウントによる連署
coSig1 = carol1.cosignTransaction(aggregateTx, false);
aggregateTx.cosignatures.push(coSig1);

// アナウンス
${put('/transactions', 'JSON.stringify({"payload": sdkCore.utils.uint8ToHex(aggregateTx.serialize())})')}`,
  },

  {
    id: 'multisig_replace',
    code: `// マルチシグの構成変更（差替え）: bob の連署者を、carol2 から、新しい carol3 に入れ替える（承認・除名の人数は、そのまま）
// 先に「マルチシグ化」を実行して、承認されてから実行する。起案者は alice、承認は alice と carol1 の 2 人（承認 2）
// 新しく加わる carol3 は、同意の連署が要ります（外される carol2 の連署は要りません）
carol3 = facade.createAccount(sdkCore.PrivateKey.random());
console.log("carol3:", carol3.address.toString());
console.log("carol3 key:", carol3.keyPair.privateKey.toString()); // 練習用の使い捨ての鍵です（ページを開き直すと消えます）

// マルチシグ設定Tx作成
multisigDescriptor = new sdkSymbol.descriptors.MultisigAccountModificationTransactionV1Descriptor(  // Txタイプ:マルチシグ設定Tx
  0,  // minRemoval:除名のために必要な最小署名者数増分（変えない）
  0,  // minApproval:承認のために必要な最小署名者数増分（変えない）
  [   // 追加対象アドレスリスト
    carol3.address,
  ],
  [   // 除名対象アドレスリスト
    carol2.address,
  ]
);
multisigTx = facade.createEmbeddedTransactionFromTypedDescriptor(
  multisigDescriptor, // トランザクション Descriptor 設定
  bob.publicKey,      // 構成を変えるマルチシグアカウントの公開鍵を指定
);

embeddedTransactions = [
  multisigTx
];

// アグリゲートTx作成
aggregateDescriptor = new sdkSymbol.descriptors.AggregateCompleteTransactionV3Descriptor(
  facade.static.hashEmbeddedTransactions(embeddedTransactions),
  embeddedTransactions
);
aggregateTx = facade.createTransactionFromTypedDescriptor(
  aggregateDescriptor,  // トランザクション Descriptor 設定
  alice.publicKey,      // 起案者アカウントの公開鍵を指定
  100,                  // 手数料乗数
  60 * 60 * 2,          // Deadline:有効期限(秒単位)
  2                     // 連署者数（carol1・carol3）
);

// 起案者アカウントによる署名
sig = alice.signTransaction(aggregateTx); // ← ここで確認ダイアログが開く
jsonPayload = facade.transactionFactory.static.attachSignature(aggregateTx, sig);

// 承認する連署者（carol1）と、新しく加わる連署者（carol3）による連署
coSig1 = carol1.cosignTransaction(aggregateTx, false);
aggregateTx.cosignatures.push(coSig1);
coSig3 = carol3.cosignTransaction(aggregateTx, false);
aggregateTx.cosignatures.push(coSig3);

// アナウンス
${put('/transactions', 'JSON.stringify({"payload": sdkCore.utils.uint8ToHex(aggregateTx.serialize())})')}`,
  },
  {
    id: 'multisig_shrink',
    code: `// マルチシグの構成変更（縮小）: bob の連署者から carol3 を外して、3 人（alice・carol1・carol3）から 2 人（alice・carol1）にする
// 先に「マルチシグの構成変更（差替え）」を実行して、承認されてから実行する。起案者は alice、連署は carol1（承認・除名とも 2 なので、alice と carol1 で成立）
// 連署者を外すとき、外される carol3 の連署は要りません
// 承認・除名の最小人数を変えるときは、差分で書く（例: 下の 0, 0 を -1, -1 にすると、2 → 1）。連署者の数より多い人数は、指定できません

// マルチシグ設定Tx作成
multisigDescriptor = new sdkSymbol.descriptors.MultisigAccountModificationTransactionV1Descriptor(  // Txタイプ:マルチシグ設定Tx
  0,  // minRemoval:除名のために必要な最小署名者数増分（変えない）
  0,  // minApproval:承認のために必要な最小署名者数増分（変えない）
  [], // 追加対象アドレスリスト
  [   // 除名対象アドレスリスト
    carol3.address,
  ]
);
multisigTx = facade.createEmbeddedTransactionFromTypedDescriptor(
  multisigDescriptor, // トランザクション Descriptor 設定
  bob.publicKey,      // 構成を変えるマルチシグアカウントの公開鍵を指定
);

embeddedTransactions = [
  multisigTx
];

// アグリゲートTx作成
aggregateDescriptor = new sdkSymbol.descriptors.AggregateCompleteTransactionV3Descriptor(
  facade.static.hashEmbeddedTransactions(embeddedTransactions),
  embeddedTransactions
);
aggregateTx = facade.createTransactionFromTypedDescriptor(
  aggregateDescriptor,  // トランザクション Descriptor 設定
  alice.publicKey,      // 起案者アカウントの公開鍵を指定
  100,                  // 手数料乗数
  60 * 60 * 2,          // Deadline:有効期限(秒単位)
  1                     // 連署者数（carol1）
);

// 起案者アカウントによる署名
sig = alice.signTransaction(aggregateTx); // ← ここで確認ダイアログが開く
jsonPayload = facade.transactionFactory.static.attachSignature(aggregateTx, sig);

// 連署者アカウントによる連署
coSig1 = carol1.cosignTransaction(aggregateTx, false);
aggregateTx.cosignatures.push(coSig1);

// アナウンス
${put('/transactions', 'JSON.stringify({"payload": sdkCore.utils.uint8ToHex(aggregateTx.serialize())})')}`,
  },

  // ---------- 監視 ----------
  {
    id: 'listener',
    code: `// リスナーの準備: ノードの WebSocket につなぐ（つながると、ノードから uid が届く）。つないだあとに、下の3つの監視サンプルを使う
// チャンネル名
ListenerChannelName = {
  block: 'block',
  confirmedAdded: 'confirmedAdded',
  unconfirmedAdded: 'unconfirmedAdded',
  unconfirmedRemoved: 'unconfirmedRemoved',
  partialAdded: 'partialAdded',
  partialRemoved: 'partialRemoved',
  cosignature: 'cosignature',
  modifyMultisigAccount: 'modifyMultisigAccount',
  status: 'status',
  finalizedBlock: 'finalizedBlock',
}

// 各種設定
wsEndpoint = NODE.replace('http', 'ws') + "/ws";  // WebSocketエンドポイント設定
uid = "";
funcs = {};

// チャンネルへのコールバック追加
addCallback = (channel, callback) => {
  if (!funcs.hasOwnProperty(channel)) {
    funcs[channel] = [];
  }
  funcs[channel].push(callback);
};

// WebSocket初期化
listener = new WebSocket(wsEndpoint);
// メッセージ受信時処理
listener.onmessage = function(e) {
  // 受信データをJSON変換
  data = JSON.parse(e.data);

  // WebSocket初期化後、ノードから uid を渡されるため保持しておく
  if (data.uid != undefined) {
    uid = data.uid;
    console.log("connected. uid:", uid);
    return;
  }

  // subscribe しているチャンネルであればコールバックを実行する
  if (funcs.hasOwnProperty(data.topic)) {
    funcs[data.topic].forEach(f => {
      f(data.data);
    });
  }
};
// エラー時処理
listener.onerror = function(error) {
  console.error(error.data);
};
// クローズ時処理
listener.onclose = function(closeEvent) {
  uid = "";
  funcs = {};
  console.log(closeEvent);
};

// 監視をやめるときは、listener.close(); を実行します
`,
  },
  {
    id: 'listen_tx',
    code: `// トランザクションの監視: alice 宛て・alice のトランザクションが、未承認になったとき・承認されたときに表示する（先に「リスナーの準備」）
// 承認トランザクション検知時の処理
channelName = ListenerChannelName.confirmedAdded + "/" + alice.address.toString();
addCallback(channelName, (tx) => {
  console.log("confirmed added", tx);
});
// 承認トランザクション検知設定
listener.send(JSON.stringify({
  uid: uid,
  subscribe: channelName,
}));

// 未承認トランザクション検知時の処理
channelName = ListenerChannelName.unconfirmedAdded + "/" + alice.address.toString();
addCallback(channelName, (tx) => {
  console.log("unconfirmed added", tx);
});
// 未承認トランザクション検知設定
listener.send(JSON.stringify({
  uid: uid,
  subscribe: channelName,
}));
`,
  },
  {
    id: 'listen_block',
    code: `// ブロックの監視: 新しいブロックができるたびに表示する（約30秒ごと。先に「リスナーの準備」）
// ブロック生成検知時の処理
addCallback(ListenerChannelName.block, (block) => {
  console.log("block", block);
});
// ブロック生成検知設定
listener.send(JSON.stringify({
  uid: uid,
  subscribe: ListenerChannelName.block,
}));
`,
  },
  {
    id: 'listen_partial',
    code: `// 署名待ちトランザクションの監視: alice の署名が必要なアグリゲートボンデッドが現れたら表示する（先に「リスナーの準備」）
// 署名が必要なアグリゲートボンデッドトランザクション発生検知時の処理
channelName = ListenerChannelName.partialAdded + "/" + alice.address.toString();
addCallback(channelName, (tx) => {
  console.log("partial added", tx);
});
// 署名が必要なアグリゲートボンデッドトランザクション発生検知設定
listener.send(JSON.stringify({
  uid: uid,
  subscribe: channelName,
}));
`,
  },

  // ---------- 制限（使い捨ての carol にかける。alice にはかけない） ----------
  {
    id: 'restrict_address',
    code: `// アドレス制限: 使い捨てのアカウント carol に、bob からの受信を拒否する設定をする（署名は carol。alice には制限をかけません）
carol = facade.createAccount(sdkCore.PrivateKey.random());
bob = facade.createAccount(sdkCore.PrivateKey.random());
console.log("carol:", carol.address.toString());
${faucetFor('carol', 10)}

// 制限設定
f = sdkSymbol.models.AccountRestrictionFlags.ADDRESS.value; // アドレス制限
f += sdkSymbol.models.AccountRestrictionFlags.BLOCK.value; // ブロック
flags = new sdkSymbol.models.AccountRestrictionFlags(f);

// アドレス制限設定Tx作成
descriptor = new sdkSymbol.descriptors.AccountAddressRestrictionTransactionV1Descriptor(  // Txタイプ:アドレス制限設定Tx
  flags,  // アドレス制限フラグ
  [       // 設定アドレス
    bob.address,
  ],
  []      // 解除アドレス
);
tx = facade.createTransactionFromTypedDescriptor(
  descriptor,       // トランザクション Descriptor 設定
  carol.publicKey,  // 署名者公開鍵
  100,              // 手数料乗数
  60 * 60 * 2       // Deadline:有効期限(秒単位)
);

// 署名（carol の鍵。確認なし）
sig = carol.signTransaction(tx);
jsonPayload = facade.transactionFactory.static.attachSignature(tx, sig);

// アドレス制限設定Txをアナウンス
${put('/transactions', 'jsonPayload')}`,
  },
  {
    id: 'restrict_mosaic',
    code: `// モザイク制限: carol が XYM を受け取らない設定をする（署名は carol。先に「アドレス制限」で carol を作っておく）
// 制限設定
f = sdkSymbol.models.AccountRestrictionFlags.MOSAIC_ID.value; // モザイク制限
f += sdkSymbol.models.AccountRestrictionFlags.BLOCK.value;    // ブロック
flags = new sdkSymbol.models.AccountRestrictionFlags(f);

xymMosaicId = identifier === 'mainnet' ? 0x6BED913FA20223F8n : 0x72C0212E67A08BCEn; // XYM のモザイクID

// モザイク制限設定Tx作成
descriptor = new sdkSymbol.descriptors.AccountMosaicRestrictionTransactionV1Descriptor(  // Txタイプ:モザイク制限設定Tx
  flags,  // モザイク制限フラグ
  [       // 設定モザイク
    new sdkSymbol.models.UnresolvedMosaicId(xymMosaicId),
  ],
  []      // 解除モザイク
);
tx = facade.createTransactionFromTypedDescriptor(
  descriptor,       // トランザクション Descriptor 設定
  carol.publicKey,  // 署名者公開鍵
  100,              // 手数料乗数
  60 * 60 * 2       // Deadline:有効期限(秒単位)
);

// 署名（carol の鍵。確認なし）
sig = carol.signTransaction(tx);
jsonPayload = facade.transactionFactory.static.attachSignature(tx, sig);

// モザイク制限設定Txをアナウンス
${put('/transactions', 'jsonPayload')}`,
  },
  {
    id: 'restrict_op',
    code: `// トランザクション制限: carol が送信できるトランザクションを、制限の設定変更だけにする（署名は carol。先に「アドレス制限」で carol を作っておく）
// この設定のあと、carol は送金などができなくなります。使い捨てのアカウントでだけ試してください
// 制限設定
f = sdkSymbol.models.AccountRestrictionFlags.TRANSACTION_TYPE.value;  // トランザクション制限
f += sdkSymbol.models.AccountRestrictionFlags.OUTGOING.value;         // 送信
flags = new sdkSymbol.models.AccountRestrictionFlags(f);

// トランザクション制限設定Tx作成
descriptor = new sdkSymbol.descriptors.AccountOperationRestrictionTransactionV1Descriptor(  // Txタイプ:トランザクション制限設定Tx
  flags,  // トランザクション制限フラグ
  [       // 設定トランザクション
    sdkSymbol.models.TransactionType.ACCOUNT_OPERATION_RESTRICTION.value,
  ],
  []      // 解除トランザクション
);
tx = facade.createTransactionFromTypedDescriptor(
  descriptor,       // トランザクション Descriptor 設定
  carol.publicKey,  // 署名者公開鍵
  100,              // 手数料乗数
  60 * 60 * 2       // Deadline:有効期限(秒単位)
);

// 署名（carol の鍵。確認なし）
sig = carol.signTransaction(tx);
jsonPayload = facade.transactionFactory.static.attachSignature(tx, sig);

// トランザクション制限設定Txをアナウンス
${put('/transactions', 'jsonPayload')}`,
  },
  {
    id: 'restrict_info',
    code: `// 制限の確認: carol に設定されている制限の一覧
res = await fetch(
  new URL('/restrictions/account/' + carol.address.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json.accountRestrictions;
});
console.log(res);
`,
  },

  {
    id: 'restrict_global',
    code: `// 全体制限: 制限できるモザイクを新しく作り、「KYC が 1 のアカウントだけが受け取れる」という全体のルールを付ける（アグリゲートトランザクション）
// ルールを付けられるのは、モザイクを作ったアカウント（alice）だけです。ルールが付くのは、ここで作る新しいモザイクだけで、XYM や alice のアカウントそのものには、制限はかかりません

// モザイクフラグ設定（RESTRICTABLE が無いと、あとから制限を付けられません）
f = sdkSymbol.models.MosaicFlags.NONE.value;
f += sdkSymbol.models.MosaicFlags.SUPPLY_MUTABLE.value; // 供給量変更の可否
f += sdkSymbol.models.MosaicFlags.TRANSFERABLE.value;   // 第三者への譲渡可否
f += sdkSymbol.models.MosaicFlags.RESTRICTABLE.value;   // 制限設定の可否
flags = new sdkSymbol.models.MosaicFlags(f);

// ナンス設定
array = new Uint8Array(sdkSymbol.models.MosaicNonce.SIZE);
crypto.getRandomValues(array);
nonce = sdkSymbol.models.MosaicNonce.deserialize(array);
restrictableMosaicId = sdkSymbol.generateMosaicId(alice.address, nonce.value);
console.log("mosaicId:", restrictableMosaicId.toString(16).toUpperCase());

// モザイク定義
mosaicDefDescriptor = new sdkSymbol.descriptors.MosaicDefinitionTransactionV1Descriptor(  // Txタイプ:モザイク定義Tx
  new sdkSymbol.models.MosaicId(restrictableMosaicId),  // モザイクID
  new sdkSymbol.models.BlockDuration(0n), // duration:有効期限（0 = 無期限）
  nonce,  // ナンス
  flags,  // モザイクフラグ
  0       // divisibility:可分性
);
restrictMosaicDefTx = facade.createEmbeddedTransactionFromTypedDescriptor(
  mosaicDefDescriptor,  // トランザクション Descriptor 設定
  alice.publicKey,      // 署名者公開鍵
);

// モザイク変更（数量を 1000 にする）
mosaicChangeDescriptor = new sdkSymbol.descriptors.MosaicSupplyChangeTransactionV1Descriptor( // Txタイプ:モザイク変更Tx
  new sdkSymbol.models.UnresolvedMosaicId(restrictableMosaicId),  // モザイクID
  new sdkSymbol.models.Amount(1000n),                  // 数量
  sdkSymbol.models.MosaicSupplyChangeAction.INCREASE   // アクション
);
restrictMosaicChangeTx = facade.createEmbeddedTransactionFromTypedDescriptor(
  mosaicChangeDescriptor, // トランザクション Descriptor 設定
  alice.publicKey,        // 署名者公開鍵
);

// 全体制限（キー "KYC" が 1 と等しいアカウントだけ、このモザイクを扱える）
restrictionKey = sdkSymbol.mosaicRestrictionGenerateKey("KYC");
globalDescriptor = new sdkSymbol.descriptors.MosaicGlobalRestrictionTransactionV1Descriptor(  // Txタイプ:全体制限Tx
  new sdkSymbol.models.UnresolvedMosaicId(restrictableMosaicId),  // 制限するモザイクID
  new sdkSymbol.models.UnresolvedMosaicId(0n),  // 参照するモザイクID（0 = このモザイク自身のルール）
  restrictionKey,                               // 制限のキー
  0n,                                           // 前の値（初めて設定するので 0）
  1n,                                           // 新しい値
  sdkSymbol.models.MosaicRestrictionType.NONE,  // 前の種類
  sdkSymbol.models.MosaicRestrictionType.EQ     // 新しい種類（EQ: 値が等しいアカウントだけ）
);
restrictGlobalTx = facade.createEmbeddedTransactionFromTypedDescriptor(
  globalDescriptor, // トランザクション Descriptor 設定
  alice.publicKey,  // 署名者公開鍵（モザイクを作ったアカウント）
);

embeddedTransactions = [
  restrictMosaicDefTx,
  restrictMosaicChangeTx,
  restrictGlobalTx
];

// アグリゲートTx作成
aggregateDescriptor = new sdkSymbol.descriptors.AggregateCompleteTransactionV3Descriptor(
  facade.static.hashEmbeddedTransactions(embeddedTransactions),
  embeddedTransactions
);
aggregateTx = facade.createTransactionFromTypedDescriptor(
  aggregateDescriptor,  // トランザクション Descriptor 設定
  alice.publicKey,      // 署名者公開鍵
  100,                  // 手数料乗数
  60 * 60 * 2,          // Deadline:有効期限(秒単位)
  0                     // 連署者数
);
${aliceSignAndAnnounce('aggregateTx')}`,
  },
  {
    id: 'restrict_global_address',
    code: `// モザイクアドレス制限: 「全体制限」で作ったモザイクについて、alice に KYC = 1 を付ける（全体のルールに合うので、alice はこのモザイクを受け取れる）
// 先に「全体制限」を実行して、承認されてから実行する。付けられるのは、モザイクを作った alice だけです
// 他のアドレスに付けるときは、alice.address を、そのアドレスに書き換える
descriptor = new sdkSymbol.descriptors.MosaicAddressRestrictionTransactionV1Descriptor(  // Txタイプ:モザイクアドレス制限Tx
  new sdkSymbol.models.UnresolvedMosaicId(restrictableMosaicId),  // 対象のモザイクID
  restrictionKey,        // 制限のキー（「全体制限」で作った "KYC"）
  0xFFFFFFFFFFFFFFFFn,   // 前の値（まだ値が無いときは 0xFFFFFFFFFFFFFFFFn。値があるときは、その値）
  1n,                    // 新しい値（全体制限の「EQ 1」に合う値）
  alice.address          // 値を付けるアドレス
);
tx = facade.createTransactionFromTypedDescriptor(
  descriptor,       // トランザクション Descriptor 設定
  alice.publicKey,  // 署名者公開鍵
  100,              // 手数料乗数
  60 * 60 * 2       // Deadline:有効期限(秒単位)
);
${aliceSignAndAnnounce('tx')}`,
  },
  {
    id: 'restrict_global_info',
    code: `// 全体制限の確認: 「全体制限」で作ったモザイクの、全体のルールと、alice に付けた値
mosaicHex = restrictableMosaicId.toString(16).toUpperCase();
console.log("KYC のキー:", restrictionKey.toString());

// 全体のルール（entryType: 1）
query = new URLSearchParams({
  "mosaicId": mosaicHex,
  "entryType": 1
});
globalInfo = await fetch(
  new URL('/restrictions/mosaic?' + query.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json.data;
});
console.log(globalInfo);
globalInfo.forEach(entry => {
  entry.mosaicRestrictionEntry.restrictions.forEach(r => {
    console.log("key:", r.key, "type:", r.restriction.restrictionType, "value:", r.restriction.restrictionValue);
  });
});

// アドレスごとの値（entryType: 0）
query = new URLSearchParams({
  "mosaicId": mosaicHex,
  "entryType": 0,
  "targetAddress": alice.address.toString()
});
addressInfo = await fetch(
  new URL('/restrictions/mosaic?' + query.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json.data;
});
console.log(addressInfo);
addressInfo.forEach(entry => {
  entry.mosaicRestrictionEntry.restrictions.forEach(r => {
    console.log("key:", r.key, "value:", r.value);
  });
});
`,
  },

  // ---------- オフライン署名 ----------
  {
    id: 'offline_sign',
    code: `// オフライン署名（ペイロードの作成）: alice が署名した、bob の連署待ちのアグリゲートを作る（まだアナウンスしません）
bob = facade.createAccount(sdkCore.PrivateKey.random());

// アグリゲートTxに含めるTxを作成
innerTxDescriptor1 = new sdkSymbol.descriptors.TransferTransactionV1Descriptor(  // Txタイプ:転送Tx
  bob.address,  // Bobへの送信
  [],
  '\\0tx1'       // メッセージ
);
innerTx1 = facade.createEmbeddedTransactionFromTypedDescriptor(
  innerTxDescriptor1, // トランザクション Descriptor 設定
  alice.publicKey,    // Aliceから
);

innerTxDescriptor2 = new sdkSymbol.descriptors.TransferTransactionV1Descriptor(  // Txタイプ:転送Tx
  alice.address,  // Aliceへの送信
  [],
  '\\0tx2'         // メッセージ
);
innerTx2 = facade.createEmbeddedTransactionFromTypedDescriptor(
  innerTxDescriptor2, // トランザクション Descriptor 設定
  bob.publicKey,      // Bobから
);

embeddedTransactions = [
  innerTx1,
  innerTx2
];

// アグリゲートTx作成
aggregateDescriptor = new sdkSymbol.descriptors.AggregateCompleteTransactionV3Descriptor(
  facade.static.hashEmbeddedTransactions(embeddedTransactions),
  embeddedTransactions
);
aggregateTx = facade.createTransactionFromTypedDescriptor(
  aggregateDescriptor,  // トランザクション Descriptor 設定
  alice.publicKey,      // 署名者公開鍵
  100,                  // 手数料乗数
  60 * 60 * 2,          // Deadline:有効期限(秒単位)
  1                     // 連署者数
);

// 署名
sig = alice.signTransaction(aggregateTx); // ← ここで確認ダイアログが開く
jsonPayload = facade.transactionFactory.static.attachSignature(aggregateTx, sig);

signedHash = facade.hashTransaction(aggregateTx).toString();
signedPayload = JSON.parse(jsonPayload).payload;

console.log(signedPayload);
`,
  },
  {
    id: 'offline_restore',
    code: `// ペイロードの復元と検証: 「オフライン署名」で作ったペイロードから、トランザクションを復元して、署名を確かめる
// 受け取ったペイロードを使うときは、jsonPayload = JSON.stringify({"payload": "（受け取った16進数）"}); と書き換える
tx = facade.transactionFactory.static.deserialize(sdkCore.utils.hexToUint8(JSON.parse(jsonPayload).payload));
console.log(tx);

// 署名者の署名が正しいか
res = facade.verifyTransaction(tx, tx.signature);
console.log(res);

// 含まれているトランザクションの数と、ハッシュ（起案者が署名したときのハッシュと一致するはず）
console.log(tx.transactions.length);
console.log(facade.hashTransaction(tx).toString() === signedHash);
`,
  },
  {
    id: 'offline_cosign',
    code: `// オフラインでの連署: 「ペイロードの復元と検証」で復元した tx に、bob が連署する（署名と公開鍵だけを控える）
bobCosignature = bob.cosignTransaction(tx, true);
bobSignedTxSignature = bobCosignature.signature;
bobSignedTxSignerPublicKey = bobCosignature.signerPublicKey;
console.log(bobSignedTxSignature.toString());
console.log(bobSignedTxSignerPublicKey.toString());
`,
  },
  {
    id: 'offline_announce',
    code: `// 連署を足してアナウンス: alice の署名済みペイロードに、bob の連署を足して、ノードへ送る（先に「オフラインでの連署」）
recreatedTx = facade.transactionFactory.static.deserialize(sdkCore.utils.hexToUint8(JSON.parse(jsonPayload).payload));

// 連署者の署名を追加
cosignature = new sdkSymbol.models.Cosignature();
signTxHash = facade.hashTransaction(aggregateTx);
cosignature.parentHash = signTxHash;
cosignature.version = 0n;
cosignature.signerPublicKey = bobSignedTxSignerPublicKey;
cosignature.signature = bobSignedTxSignature;
recreatedTx.cosignatures.push(cosignature);

signedPayload = sdkCore.utils.uint8ToHex(recreatedTx.serialize());

// アナウンス
${put('/transactions', 'JSON.stringify({"payload": signedPayload})')}`,
  },

  // ---------- 検証 ----------
  {
    id: 'verify_payload',
    code: `// ペイロードの検証: 署名済みのペイロード（jsonPayload。「署名とアナウンス」などで作ったもの）から、ハッシュと署名を自分で確かめる
// 他の人から受け取ったペイロードを検証するときは、payload = "（16進数）"; と書き換える
payload = JSON.parse(jsonPayload).payload;

tx = facade.transactionFactory.static.deserialize(sdkCore.utils.hexToUint8(payload));
hash = facade.hashTransaction(tx);
console.log(hash.toString());
console.log(tx);

// 署名者の検証（署名者の公開鍵と、署名が合うか）
res = facade.verifyTransaction(tx, tx.signature);
console.log(res);
`,
  },
  {
    id: 'verify_merkle',
    code: `// ブロック内のトランザクションの検証: 「ペイロードの検証」の hash のトランザクションが、ブロックに入っていることを、マークル証明で確かめる（承認されてから）
sha3_256 = (await import('https://cdn.skypack.dev/@noble/hashes/sha3')).sha3_256; // 同梱の SHA3 が返ります

// マークルコンポーネントハッシュの計算（連署があるときは、連署者の公開鍵も混ぜる）
merkleComponentHash = hash.toString();
if (tx.cosignatures !== undefined && tx.cosignatures.length > 0) {
  hasher = sha3_256.create();
  hasher.update(hash.bytes);
  tx.cosignatures.forEach(cosignature => {
    hasher.update(cosignature.signerPublicKey.bytes);
  });
  merkleComponentHash = sdkCore.utils.uint8ToHex(hasher.digest());
}
console.log(merkleComponentHash);

// トランザクションがあるブロックの高さ（ノードから取得）
height = await fetch(
  new URL('/transactions/confirmed/' + hash.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return Number(json.meta.height);
});
console.log("height:", height);

// トランザクションから計算
leaf = new sdkCore.Hash256(merkleComponentHash);

// ノードから取得
HRoot = await fetch(
  new URL('/blocks/' + height, NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return new sdkCore.Hash256(json.block.transactionsHash);
});
merkleProof = await fetch(
  new URL('/blocks/' + height + '/transactions/' + leaf.toString() + '/merkle', NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  paths = [];
  json.merklePath.forEach(path => paths.push({
    "hash": new sdkCore.Hash256(path.hash),
    "isLeft": path.position === "left"
  }));
  return paths;
});

result = sdkSymbol.proveMerkle(leaf, merkleProof, HRoot);
console.log(result); // true なら、このトランザクションは、このブロックに入っている
`,
  },
  {
    id: 'verify_block',
    code: `// ブロックヘッダーの検証: ブロックのハッシュと、stateHash を、自分で計算し直して確かめる
// 「ブロック内のトランザクションの検証」の height（そのトランザクションがあるブロック）を使う。別のブロックを調べるなら、height = 数値; と書き換える
sha3_256 = (await import('https://cdn.skypack.dev/@noble/hashes/sha3')).sha3_256; // 同梱の SHA3 が返ります
toBytes = sdkCore.utils.hexToUint8;

blockInfo = await fetch(
  new URL('/blocks/' + height, NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
block = blockInfo.block;
previousBlockHash = await fetch(
  new URL('/blocks/' + (height - 1), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json.meta.hash;
});

// ブロックヘッダーのハッシュ（normal ブロックも importance ブロックも、前半は同じ）
hasher = sha3_256.create();
hasher.update(toBytes(block.signature)); // signature
hasher.update(toBytes(block.signerPublicKey)); // publicKey
hasher.update(sdkCore.utils.intToBytes(block.version, 1));
hasher.update(sdkCore.utils.intToBytes(block.network, 1));
hasher.update(sdkCore.utils.intToBytes(block.type, 2));
hasher.update(sdkCore.utils.intToBytes(BigInt(block.height), 8));
hasher.update(sdkCore.utils.intToBytes(BigInt(block.timestamp), 8));
hasher.update(sdkCore.utils.intToBytes(BigInt(block.difficulty), 8));
hasher.update(toBytes(block.proofGamma));
hasher.update(toBytes(block.proofVerificationHash));
hasher.update(toBytes(block.proofScalar));
hasher.update(toBytes(previousBlockHash));
hasher.update(toBytes(block.transactionsHash));
hasher.update(toBytes(block.receiptsHash));
hasher.update(toBytes(block.stateHash));
hasher.update(toBytes(block.beneficiaryAddress));
hasher.update(sdkCore.utils.intToBytes(block.feeMultiplier, 4));
if (block.type === sdkSymbol.models.BlockType.IMPORTANCE.value) {
  // importance ブロックは、あとに続く項目がある
  hasher.update(sdkCore.utils.intToBytes(block.votingEligibleAccountsCount, 4));
  hasher.update(sdkCore.utils.intToBytes(BigInt(block.harvestingEligibleAccountsCount), 8));
  hasher.update(sdkCore.utils.intToBytes(BigInt(block.totalVotingBalance), 8));
  hasher.update(toBytes(block.previousImportanceBlockHash));
}
hash = sdkCore.utils.uint8ToHex(hasher.digest());
console.log(hash === blockInfo.meta.hash);

// stateHash の検証（9つの状態の根っこのハッシュを順に混ぜる）
hasher = sha3_256.create();
blockInfo.meta.stateHashSubCacheMerkleRoots.forEach(root => {
  hasher.update(toBytes(root));
});
stateHash = sdkCore.utils.uint8ToHex(hasher.digest());
console.log(block.stateHash === stateHash);
`,
  },
  {
    id: 'verify_account',
    code: `// アカウント情報の検証: alice のアカウント情報から stateHash を自分で計算して、ノードが返したマークル情報と、最新ブロックのルートが合うか確かめる
// （ブロックが新しくできると、情報が変わって一致しないことがあります。その場合は、もう一度実行してください）
sha3_256 = (await import('https://cdn.skypack.dev/@noble/hashes/sha3')).sha3_256; // 同梱の SHA3 が返ります

// 葉のハッシュ値取得関数
function getLeafHash(encodedPath, leafValue) {
  var hasher = sha3_256.create();
  return sdkCore.utils.uint8ToHex(hasher.update(sdkCore.utils.hexToUint8(encodedPath + leafValue)).digest());
}

// 枝のハッシュ値取得関数
function getBranchHash(encodedPath, links) {
  var branchLinks = Array(16).fill(sdkCore.utils.uint8ToHex(new Uint8Array(32)));
  links.forEach((link) => {
    branchLinks[parseInt("0x" + link.bit, 16)] = link.link;
  });
  var hasher = sha3_256.create();
  return sdkCore.utils.uint8ToHex(hasher.update(sdkCore.utils.hexToUint8(encodedPath + branchLinks.join(''))).digest());
}

// ワールドステートの検証
function checkState(stateProof, stateHash, pathHash, rootHash) {
  merkleLeaf = undefined;
  merkleBranches = [];
  stateProof.tree.forEach(n => {
    if (n.type === 255) {
      merkleLeaf = n;
    } else {
      merkleBranches.push(n);
    }
  });
  merkleBranches.reverse();

  var leafHash = getLeafHash(merkleLeaf.encodedPath, stateHash);

  var linkHash = leafHash; // 最初のlinkHashはleafHash
  var bit = "";
  for (var i = 0; i < merkleBranches.length; i++) {
    var branch = merkleBranches[i];
    var branchLink = branch.links.find(x => x.link === linkHash);
    linkHash = getBranchHash(branch.encodedPath, branch.links);
    bit = merkleBranches[i].path.slice(0, merkleBranches[i].nibbleCount) + branchLink.bit + bit;
  }

  var treeRootHash = linkHash; // 最後のlinkHashはrootHash
  var treePathHash = bit + merkleLeaf.path;

  if (treePathHash.length % 2 == 1) {
    treePathHash = treePathHash.slice(0, -1);
  }

  // 検証
  console.log("root:", treeRootHash === rootHash);
  console.log("path:", treePathHash === pathHash);
}

hasher = sha3_256.create();
alicePathHash = sdkCore.utils.uint8ToHex(hasher.update(alice.address.bytes).digest());

aliceInfo = await fetch(
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

// アカウント情報から StateHash を導出
format = (parseInt(aliceInfo.importance) === 0 || aliceInfo.activityBuckets.length < 5 ? 0x00 : 0x01);
supplementalPublicKeysMask = 0x00;
linkedPublicKey = new Uint8Array([]);
if (aliceInfo.supplementalPublicKeys.linked !== undefined) {
  supplementalPublicKeysMask |= 0x01;
  linkedPublicKey = sdkCore.utils.hexToUint8(aliceInfo.supplementalPublicKeys.linked.publicKey);
}
nodePublicKey = new Uint8Array([]);
if (aliceInfo.supplementalPublicKeys.node !== undefined) {
  supplementalPublicKeysMask |= 0x02;
  nodePublicKey = sdkCore.utils.hexToUint8(aliceInfo.supplementalPublicKeys.node.publicKey);
}
vrfPublicKey = new Uint8Array([]);
if (aliceInfo.supplementalPublicKeys.vrf !== undefined) {
  supplementalPublicKeysMask |= 0x04;
  vrfPublicKey = sdkCore.utils.hexToUint8(aliceInfo.supplementalPublicKeys.vrf.publicKey);
}
votingPublicKeys = new Uint8Array([]);
votingKeyCount = 0;
if (aliceInfo.supplementalPublicKeys.voting !== undefined) {
  aliceInfo.supplementalPublicKeys.voting.publicKeys.forEach(key => {
    votingPublicKeys = new Uint8Array([...votingPublicKeys, ...sdkCore.utils.hexToUint8(key.publicKey)]);
    votingKeyCount++;
  });
}
importanceSnapshots = new Uint8Array([]);
if (parseInt(aliceInfo.importance) !== 0) {
  importanceSnapshots = new Uint8Array([
    ...sdkCore.utils.intToBytes(BigInt(aliceInfo.importance), 8),
    ...sdkCore.utils.intToBytes(BigInt(aliceInfo.importanceHeight), 8),
  ]);
}
activityBuckets = new Uint8Array([]);
if (aliceInfo.importance > 0) {
  for (idx = 0; idx < aliceInfo.activityBuckets.length || idx < 5; idx++) {
    bucket = aliceInfo.activityBuckets[idx];
    activityBuckets = new Uint8Array([
      ...activityBuckets,
      ...sdkCore.utils.intToBytes(BigInt(bucket.startHeight), 8),
      ...sdkCore.utils.intToBytes(BigInt(bucket.totalFeesPaid), 8),
      ...sdkCore.utils.intToBytes(bucket.beneficiaryCount, 4),
      ...sdkCore.utils.intToBytes(BigInt(bucket.rawScore), 8),
    ]);
  }
}
balances = new Uint8Array([]);
if (aliceInfo.mosaics.length > 0) {
  aliceInfo.mosaics.forEach(mosaic => {
    balances = new Uint8Array([
      ...balances,
      ...sdkCore.utils.intToBytes(BigInt("0x" + mosaic.id), 8),
      ...sdkCore.utils.intToBytes(BigInt(mosaic.amount), 8),
    ]);
  });
}
accountInfoBytes = new Uint8Array([
  ...sdkCore.utils.intToBytes(aliceInfo.version, 2),
  ...sdkCore.utils.hexToUint8(aliceInfo.address),
  ...sdkCore.utils.intToBytes(BigInt(aliceInfo.addressHeight), 8),
  ...sdkCore.utils.hexToUint8(aliceInfo.publicKey),
  ...sdkCore.utils.intToBytes(BigInt(aliceInfo.publicKeyHeight), 8),
  ...sdkCore.utils.intToBytes(aliceInfo.accountType, 1),
  ...sdkCore.utils.intToBytes(format, 1),
  ...sdkCore.utils.intToBytes(supplementalPublicKeysMask, 1),
  ...sdkCore.utils.intToBytes(votingKeyCount, 1),
  ...linkedPublicKey,
  ...nodePublicKey,
  ...vrfPublicKey,
  ...votingPublicKeys,
  ...importanceSnapshots,
  ...activityBuckets,
  ...sdkCore.utils.intToBytes(aliceInfo.mosaics.length, 2),
  ...balances
]);
hasher = sha3_256.create();
aliceStateHash = sdkCore.utils.uint8ToHex(hasher.update(accountInfoBytes).digest());

// 最新のブロックヘッダー情報（できれば、サービス提供者以外のノードから取得する）
query = new URLSearchParams({
  "order": "desc"
});
blockInfo = await fetch(
  new URL('/blocks?' + query.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
rootHash = blockInfo.data[0].meta.stateHashSubCacheMerkleRoots[0];

// マークル情報（サービス提供者を含む、任意のノードから取得する）
stateProof = await fetch(
  new URL('/accounts/' + alice.address.toString() + '/merkle', NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});

// 検証
checkState(stateProof, aliceStateHash, alicePathHash, rootHash);
`,
  },
  {
    id: 'verify_metadata',
    code: `// メタデータの検証（モザイク・ネームスペース）: alice が登録した、モザイクとネームスペースのメタデータの状態を自分で計算して、ノードが返したマークル情報と、最新ブロックのルートが合うか確かめる
// 先に、モザイクやネームスペースにメタデータを登録しておく（メタデータの画面でも登録できます）
// （ブロックが新しくできると、情報が変わって一致しないことがあります。その場合は、もう一度実行してください）
sha3_256 = (await import('https://cdn.skypack.dev/@noble/hashes/sha3')).sha3_256; // 同梱の SHA3 が返ります
toBytes = sdkCore.utils.hexToUint8;
toHex = sdkCore.utils.uint8ToHex;
le = (value, size) => sdkCore.utils.intToBytes(value, size);
concat = (...parts) => {
  var out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  var pos = 0;
  parts.forEach(p => {
    out.set(p, pos);
    pos += p.length;
  });
  return out;
};

// 葉のハッシュ値取得関数
function getLeafHash(encodedPath, leafValue) {
  return toHex(sha3_256.create().update(toBytes(encodedPath + leafValue)).digest());
}

// 枝のハッシュ値取得関数
function getBranchHash(encodedPath, links) {
  var branchLinks = Array(16).fill(toHex(new Uint8Array(32)));
  links.forEach((link) => {
    branchLinks[parseInt("0x" + link.bit, 16)] = link.link;
  });
  return toHex(sha3_256.create().update(toBytes(encodedPath + branchLinks.join(''))).digest());
}

// マークル木の検証（葉から根までたどって、根のハッシュと、葉までの道筋が合うか）
function checkMetadataState(stateProof, stateHash, pathHash, rootHash) {
  var merkleLeaf = undefined;
  var merkleBranches = [];
  stateProof.tree.forEach(n => {
    if (n.type === 255) {
      merkleLeaf = n;
    } else {
      merkleBranches.push(n);
    }
  });
  merkleBranches.reverse();

  var linkHash = getLeafHash(merkleLeaf.encodedPath, stateHash); // 最初のlinkHashはleafHash
  var bit = "";
  for (var i = 0; i < merkleBranches.length; i++) {
    var branch = merkleBranches[i];
    var branchLink = branch.links.find(x => x.link === linkHash);
    if (branchLink === undefined) {
      return { root: false, path: false }; // 枝のなかに、この葉へのつながりが無い（値が違う）
    }
    linkHash = getBranchHash(branch.encodedPath, branch.links);
    bit = branch.path.slice(0, branch.nibbleCount) + branchLink.bit + bit;
  }

  var treePathHash = bit + merkleLeaf.path;
  if (treePathHash.length % 2 == 1) {
    treePathHash = treePathHash.slice(0, -1);
  }
  return { root: linkHash === rootHash, path: treePathHash === pathHash }; // 最後のlinkHashはrootHash
}

// 最新のブロックヘッダー情報（できれば、サービス提供者以外のノードから取得する）
query = new URLSearchParams({
  "order": "desc"
});
blockInfo = await fetch(
  new URL('/blocks?' + query.toString(), NODE),
  {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  }
)
.then((res) => res.json())
.then((json) => {
  return json;
});
rootHash = blockInfo.data[0].meta.stateHashSubCacheMerkleRoots[8]; // 9つの状態のうち、メタデータの根っこ

// alice が作成者のメタデータを、種類ごとに調べる（1: モザイク、2: ネームスペース）
kinds = [
  { type: 1, name: "モザイク" },
  { type: 2, name: "ネームスペース" },
];
for (var kind of kinds) {
  query = new URLSearchParams({
    "sourceAddress": alice.address.toString(),
    "metadataType": kind.type
  });
  entries = await fetch(
    new URL('/metadata?' + query.toString(), NODE),
    {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    }
  )
  .then((res) => res.json())
  .then((json) => {
    return json.data;
  });
  console.log(kind.name + "のメタデータ:", entries.length + "件");

  for (var entry of entries) {
    m = entry.metadataEntry;
    keyBytes = le(BigInt("0x" + m.scopedMetadataKey), 8);
    targetIdBytes = le(BigInt("0x" + m.targetId), 8); // モザイクID または ネームスペースID

    // 複合ハッシュ（このメタデータの識別子）をつくって、ノードが返したものと比べる
    compositeHash = toHex(sha3_256.create().update(concat(
      toBytes(m.sourceAddress),
      toBytes(m.targetAddress),
      keyBytes,
      targetIdBytes,
      le(m.metadataType, 1)
    )).digest());
    console.log("compositeHash:", compositeHash === m.compositeHash);

    // メタデータの状態から stateHash を導出
    stateHash = toHex(sha3_256.create().update(concat(
      le(m.version, 2),
      toBytes(m.sourceAddress),
      toBytes(m.targetAddress),
      keyBytes,
      targetIdBytes,
      le(m.metadataType, 1),
      le(m.valueSize, 2),
      toBytes(m.value)
    )).digest());

    // 木の中での位置（複合ハッシュのハッシュ）
    pathHash = toHex(sha3_256.create().update(toBytes(compositeHash)).digest());

    // マークル情報（サービス提供者を含む、任意のノードから取得する）
    stateProof = await fetch(
      new URL('/metadata/' + compositeHash + '/merkle', NODE),
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }
    )
    .then((res) => res.json())
    .then((json) => {
      return json;
    });

    // 検証
    result = checkMetadataState(stateProof, stateHash, pathHash, rootHash);
    console.log("key:", m.scopedMetadataKey, "root:", result.root, "path:", result.path);
  }
}
`,
  },
];

/** NEM のサンプルには入れない（Symbol だけにある操作）のサンプルの id。 */
/** このファイルのサンプル（Symbol 版）の id すべて。NEM にも同じ操作があるものは、samplesNem7to13.ts に NEM 版がある（Symbol にしかないものは、samples.ts の SYMBOL_ONLY_SAMPLE_IDS）。 */
export const SYMBOL_EXTRA_SAMPLE_IDS: readonly string[] = SAMPLES_7_TO_13.map((s) => s.id);
