# Vintage Wallet — Symbol 版 変更点

## 整理: 使われていないコードの削除
- 削除したファイル: `hooks/useTransactions.ts`、`lib/menuShift.ts`（どこからも読み込まれていなかった。`MenuShell.tsx` の `--menu-offset` もこれ専用だったので削除）
- 削除した画面・コンポーネント: `/metadata` 用の `MetadataPage` 本体（ルートに未登録。`MetadataEditor` は残し、専用だった `initialType` だけ削除）、`LinkList` / `KasaneLogo` の default コンポーネント
- 削除した関数・定数（約35件）: `chainAddressFromPublicKey`、`fetchChainTransfers`、`quoteNemFee`、`getConnectedNemNode`、`isNemSignedText`、`buildContactQr`、`fetchMinHarvesterBalance`、`fetchAccountBalances`、`KASANE_GRADIENT_*`、`KASANE_STAGE_BG` ほか。テスト専用だった `symbolLedgerPath` / `nemLedgerPath` / `isInsecureRemoteNode` / `aliasNameOf` / `restrictionValueSize` / `fitsTotal` / `totalImageChars`（本番の `imageCharsOf` と同じ処理の重複）も削除し、テストは書き換えた
- `appStore`: どこからも設定されない `transactionListCache`・`backPathFromWalletSelect`・`backPathFromSendConfirmation` を削除（送金確認の「戻る」は従来どおり常に `/top`）
- Ledger 接続: 購読者がいなくなった `notify()` / `listeners` を削除
- 依存パッケージ: `@noble/curves`・`decimal.js`・`vite-plugin-pwa`・`@types/bcryptjs` を削除（どこからも使われていなかった）
- 翻訳キー: どこからも参照されていない221件を ja・en・zh・ko・ru から削除
- CSS: 使われていない `.videoLogo`・`.half-width`・`.is-light`・`.teeth2` を削除
- lint 警告を18件解消（残り1件は制御文字を意図的に検出する正規表現）
- 確認したこと: `tsc -b`、`vite build`、dev-tests（78本成功、4本失敗。失敗は整理前から同じ内容で、`links`・`mijin-network`・`mnemonic-qr`・`transaction-uri`）。バンドルは約67 kB（gzip 約19 kB）小さくなった
- 確認できていないこと: 実機・ブラウザでの表示。動的に組み立てる翻訳キーは機械的に判定したため、表示漏れがないかは画面での確認が必要
- 残したもの: `keystore.ts` の `readKeystore`（画面からは呼ばれず、テストのみ。キーストア取り込みに使う予定があるなら残す）

## 修正: オフライン画面の「戻る」が、条件によって戻れなかった
- 原因: 「戻る」が履歴の1つ前（`navigate(-1)`）に頼っていた。履歴が空のとき（ページを開き直した、リンクから直接開いた）や、途中でリダイレクトが入ったとき（閲覧用・Ledger のプロファイルは `/signqr` から `/top` に飛ばされる）に、戻る先が違う、または戻れなかった
- 対応: オフライントランザクション画面（`OfflineShell.tsx`）の「戻る」は、必ずプロファイル選択（`/wallet/select`）へ。署名・連署QR（`SignQrPage.tsx`）の「戻る」は、必ずオフライントランザクション画面へ（開いたときの「転送」「連署」のタブ。分からなければ「転送」）。どちらも履歴を使わず、置き換えで移動する
- 確認できていないこと: ビルド・実機表示は未確認

## 変更: オフライン連署の取り込みボタンを3つから2つに
- 「連署するトランザクションをインポート」（`OfflineCosignPage.tsx`）の「QRコードをインポート」「QR画像から読み込む」「JSONファイルを読み込む」を、①「カメラでQRコードを読み取る」（左にスキャナのアイコン）②「ファイルから読み込む（QR画像・JSON）」に整理した。「インポート」だとファイルの読み込みと取り違えるため。②は1つのファイル選択で、画像ならQRを読み取り、それ以外は文字として読む
- 文言: `offline_ui.import_qr` を変更、`offline_ui.import_file` を追加（ja・en・zh・ko・ru。zh・ko・ru は機械的な訳）
- 同じ3つ並びは `SignQrPage.tsx`（署名・連署QR）にもあるが、今回は触っていない
- 確認できていないこと: ビルド・実機表示は未確認

## 修正: 手数料の選択欄で、名前と金額が詰まっていた
- 送金画面（`SendForm.tsx`）とハーベストの鍵リンク（`KeyLinkPanel.tsx`）の手数料の選択欄で、閉じた状態だと「最も遅い0.00176 XYM」のように詰まって見えた（メニュー側にだけ `gap` を指定していたため）。左右に振り分けると幅が広い画面で離れすぎるため、名前の下に金額を置く縦並びにした。選択欄の表示部（`.MuiSelect-select`）とメニューの項目の両方。見た目だけの変更
- 確認できていないこと: 実機表示は未確認

## Symbol のネットワーク統計に「手数料相場」を追加
- 「手数料倍率」と「接続中のノード」の間に4つのタイルを追加（`NetworkStatsPanel.tsx`、`fetchNetworkStats` の `transferFeeMedian` など）。値はすべて XYM
- ①送金（中央値）: `/network/fees/transaction` の中央値倍率（なければ平均）× 176バイト（メッセージなしの単純な送金。Symbol-tomato-wallet と同じ目安）②ネームスペースレンタル手数料（1年）: `/network/fees/rental` の `effectiveRootNamespaceRentalFeePerBlock` × 1年のブロック数（365日 ÷ 目標ブロック時間。読めなければ30秒）③子ネームスペースレンタル手数料（`effectiveChildNamespaceRentalFee`）④モザイクレンタル手数料（`effectiveMosaicRentalFee`）。読めなければ「–」
- 文言: `harvest.net_fee_market_title`・`net_fee_transfer_median`・`net_fee_namespace`・`net_fee_child_namespace`・`net_fee_mosaic`（ja・en・zh・ko・ru。zh・ko・ru は機械的な訳）
- 確認できていないこと: ビルド・実機表示は未確認

## 廃止: Symbol の「ネットワーク全体の重要度」タイル
- ネットワーク統計から「ネットワーク全体の重要度」のタイルを外した（`NetworkStatsPanel.tsx`、`harvest.net_total_importance` は各言語から削除。`fetchNetworkStats` の `totalImportance` も削除）。代わりに「総トランザクション数」を試したが、`/diagnostic/storage` を返すノードが見つからず表示できなかったため、これも載せない
- 確認できていないこと: ビルド・実機表示は未確認

## 修正: Symbol のピアノード数が「–」になる
- 原因: 統計サービスのノード数の取得先が `/nodeStats` で、404 を返していた。
- 対応（`lib/symbol/api.ts` の `fetchNetworkNodeCount`、`lib/symbol/constants.ts` に `nodeWatch` を追加）: NodeWatch（`nodewatch.symbol.tools/api/symbol/nodes/peer?limit=5000`、テストネットは `/testnet/api/...`）のノード一覧を取り、`roles` が数値のものを数える（Symbol-tomato-wallet と同じ方式。ロールの区別なく全ノード）。NodeWatch が答えない時は、統計サービスの `/nodeCount`（`{ nodeTypes }` の合計）に切り替える。どちらも読めなければ「–」。mijin v2 は今までどおり接続中のノードの `/node/peers`
- **確認できていないこと**: この環境から NodeWatch・統計サービスに繋がらず、`tsc`・実機表示は未確認。ビルドして、メインネットとテストネットで数が出るか確かめること

## NEM にもホームの「ネットワーク統計」
- Symbol のホームにある「ネットワーク統計」リボンを NEM にも追加。これまで NEM のホームには無く（`chain === 'symbol'` のときだけ出していた）、最後の位置は「アポスティーユ」だけだった。いまは NEM でも「アポスティーユ」の右に「ネットワーク統計」が並ぶ。押すと下に開き、30秒ごとに自動で更新する（「再読み込み」ボタンもある）。読むだけなので、閲覧用プロファイルでも見える
- 表示する値（接続中の NIS1 ノードから読む。読めなかった項目は「–」）: ①チェーンの高さ（`/chain/last-block`）②ピア数（`/node/peer-list/reachable`、つながれるピアの数。うちアクティブな数を `/node/peer-list/active` から添える）③平均ブロック時間（最新ブロックと30ブロック前の時刻の差。`/block/at/public`。目標60秒を添える）④最新ブロックの時刻 ⑤接続中のノード: ノード名・バージョン・実行環境（`/node/info`）・状態（`/status` が「同期済み」＝コード6なら「正常」、それ以外は「異常」）
- **Symbol と違って無い項目**: ファイナライズ（NEM には無い）、ネットワーク全体の重要度、手数料倍率（NEM の手数料は固定で、倍率が無い）
- **追補**: ネットワーク統計（Symbol・NEM 両方）のタイルを、4列ごとに並べるよう変更（狭い画面では2列。`StatGrid` に任意の `columns` を追加。ほかの画面は今までどおり幅で折り返す）。Symbol の「接続中のノード」に「RESTバージョン」を追加（Symbol のノードは NIS1 のような OS・実行環境を返さないので、「実行環境」とは呼ばない）。値は REST ゲートウェイのバージョン（`/node/server` の答え `{ serverInfo: { restVersion } }`、例: `2.5.0`）。読めなければ「–」
- **追補**: 統計タイル（`StatTile`）の文字（ラベルと値と補足）を、左寄せから中央寄せに変更。ネットワーク統計（Symbol・NEM）のほか、ハーベスト画面（Symbol の「ハーベスト統計」、NEM の「ハーベスト統計」）のタイルも同じ。タイルの見出し（「手数料倍率」など）と注記は左寄せのまま
- 追加: `pages/top/NemNetworkStatsPanel.tsx`、`lib/nem/api.ts` の `fetchNemNetworkStats`。変更: `pages/top/Home.tsx`（リボンを両チェーンに出し、チェーンに合わせてパネルを切り替え）、`i18n/messages.json`・`i18n/{zh,ko,ru}.json`（`harvest.nem_net_*` の3キー。ほかの文言は Symbol の `harvest.net_*` を共用）
- **確認できていないこと（重要）**: この環境には `node_modules` が無く、通信もできないので、`tsc -b`・`vite build`・`oxlint` は実行していない。画面も動かしておらず、**実際の NIS1 ノードに繋いで返事の形を確かめていない**。上の各 URL と返事の形（`/chain/last-block` の `height`・`timeStamp`、`/node/peer-list/*` の `data` 配列、`/node/info` の `identity.name`・`metaData.version`・`metaData.platform`、`/status` の `code`）は NIS1 の API の理解で書いたもの。`npm ci` のあとにビルドし、メインネットとテストネットでそれぞれ開いて確かめること。zh・ko・ru の追加3キーは機械的な訳で、母語話者の確認はしていない

## v230: Symbol にも署名付きメッセージ（作成と検証）
- NEM の「署名付きメッセージ」と同じ仕組みを Symbol 側に追加。文章（UTF-8 のバイト列そのもの）にアカウントの秘密鍵で署名し、署名と公開鍵から「この公開鍵の持ち主が、この文章に署名した」ことを確かめる。トランザクションではないので、ブロックチェーンには何も送らず、手数料もない。入り口は サービス → 署名付きメッセージ（Symbol のサービスは「アポスティーユ」「DNS」「署名付きメッセージ」「NEMonster」）。画面は NEM と同じ2タブ・2カラム（署名を作成／署名を検証）
- 署名は `lib/symbol/crypto.ts` の既存の `signData` / `verifySignature`（Symbol SDK v3、Ed25519 / SHA-512）をそのまま使う。出した署名は、表示する前に公開鍵で検証する（合わない署名は渡さない）
- 共有用の JSON は NEM と同じ形で、種別だけ違う: `{"kasane":1,"kind":"symbol_signed_message","data":{"message","publicKey","signature"}}`（QR・コピー・.json 保存）。`{"message","publicKey","signature"}` だけの JSON も読める。**NanoWallet 形式と絵文字の符号化の違いは Symbol 側には無い**（署名の対象は正しい UTF-8 だけ）
- **NEM と Symbol は署名方式が違う**（NEM は Keccak-512、Symbol は SHA-512）ので、同じ秘密鍵でも公開鍵・署名が違い、NEM の署名は Symbol の検証に通らない（逆も同じ）。検証欄に NEM の署名付きメッセージ（KASANE の封筒・NanoWallet 形式）を貼ったときは、「読めません」ではなく「NEM のものです。NEM に切り替えて検証してください」と出す（`detectOtherChainSignedMessage`）
- Ledger のプロファイルは選べない（Symbol の Ledger アプリはトランザクションに署名するもので、任意のバイト列には署名しない）。閲覧用プロファイルも不可。`useSigningAccounts` に `noLedger` を追加（既定は今まで通り）
- 追加: `lib/symbol/signedMessage.ts`（形式・共有 JSON・NEM との見分け。SDK なし）、`pages/signmsg/SymbolSignedMessage.tsx`、`dev-tests/symbol-signed-message.test.ts`（33項目）、`dev-tests/symbol-signed-message-sign.test.ts`（RFC 8032 の既知の答えなど）
- 変更: `router.tsx`（`/signed-message` を `ByChain` に。それまで NEM 専用で、Symbol は Home に戻していた。mijin は `/service` と同じく Home に戻す）、`pages/service/ServiceHub.tsx`（Symbol のタイルに署名付きメッセージ）、`pages/offline/signingAccounts.ts`、`i18n/messages.json`・`i18n/{zh,ko,ru}.json`（`signmsg.*` の3キー。ほかの文言は NEM と共用）、`docs/FEATURES.md`
- **確認したこと**: `dev-tests/symbol-signed-message.test.ts` の33項目は通った（`nem-signed-message.test.ts` も通る）。変更したファイルの構文（TypeScript の構文解析）、取り込んだ名前が相手のファイルに実在すること、画面が使う翻訳キーが ja・en・zh・ko・ru に揃っていることを確かめた。署名テストで使う既知の答え（RFC 8032 の TEST 2、日本語・改行を含む文章）は、標準の Ed25519 実装（Python の `cryptography`）で作った値と照合してある
- **確認できていないこと（重要）**: この環境には `node_modules` が無いので、**`tsc -b`・`vite build`・`oxlint` と `dev-tests/symbol-signed-message-sign.test.ts` は実行していない**。画面（`SymbolSignedMessage.tsx`）も実際には動かしていない。署名テストは、Symbol SDK の署名が標準の Ed25519（SHA-512）と一致するという前提で書いてあるので、`npm ci` のあとに `npx tsx dev-tests/symbol-signed-message-sign.test.ts` を走らせて確かめること。zh・ko・ru の追加3キーは機械的な訳で、母語話者の確認はしていない
- 未対応: Ledger での署名、マルチシグ名義での署名（鍵が1つに決まらないため）、他のウォレット（SSS Extension など）が出す署名付きメッセージとの互換（形式が決まっていない）

## v229: Symbol にも DNS（ネームスペースにサイトのアドレス・連絡先を紐づけ）
- NEM の DNS と同じしくみを Symbol 側に追加。ネームスペースごとに「ポインタアカウント」が決まり（秘密鍵は NEM と同じ式 = Keccak-256( SHA-256( 名前 ) )、アドレスは Symbol の鍵から作る）、**持ち主がポインタアカウントへ送った、モザイクなしの送金のメッセージ**（NEM と同じ JSON、`"dns":"yes"` が目印）が DNS レコードになる。検索は、持ち主が署名した最新のものだけを採る（持ち主以外の DNS 形式のメッセージは無視）。入り口は サービス → DNS（Symbol のサービスは「アポスティーユ」「DNS」「NEMonster」）。画面は NEM と同じ検索・設定の2タブ
- メッセージの JSON は NEM の `buildNemDnsMessage` / `parseNemDnsMessage` を共用するので、書式は NEM と同じ。Symbol では先頭に種別バイト `00` が付く
- **マルチシグが持ち主のネームスペース**にも対応。登録は、マルチシグ名義のアグリゲートの中の送金として送る（自分の署名だけで足りれば complete、足りなければ bonded＋ハッシュロック。`planApproval` / `submitMultisig`）。検索は、通常の送金の一覧と `embedded=true` の一覧の両方を見て、新しい方（ブロックの高さ、同じなら順番）を採る。Ledger のプロファイルは自分のネームスペースのみ（モザイクなしの送金なので署名できる。マルチシグ名義は不可）
- NEM との違い: ①名前はルートも64文字まで（NEM は16）②**「.nem」のような表示用の末尾は付けない**（Symbol では `foo.symbol` が「`foo` の下の子 `symbol`」のことがあり、末尾を取ると別の名前になるため）③メッセージの上限は1023バイト（NEM は1024）④手数料は XYM（送金サイズ×設定の手数料の段階）。マルチシグ名義は NEM の「外側の署名の手数料」ではなく、アグリゲートの手数料（連署の分の余白つき）＋必要ならロック
- 追加: `lib/symbol/dns.ts`（名前・メッセージの読み取り・履歴からの検索。SDK なし）、`lib/symbol/dnsApi.ts`（ポインタのアドレス・照会・手数料・登録）、`pages/dns/SymbolDns.tsx`、`dev-tests/symbol-dns.test.ts`（53項目）、`dev-tests/symbol-dns-tx.test.ts`
- 変更: `router.tsx`（`/dns` を `ByChain` に。それまで NEM 専用で、Symbol は Home に戻していた）、`pages/service/ServiceHub.tsx`（Symbol のタイルに DNS）、`i18n/messages.json`・`i18n/{zh,ko,ru}.json`（`symboldns.*` の8キー。ほかの文言は `nemdns.*` と `apostille.multisig_*` を共用）、`docs/FEATURES.md`
- **確認したこと**: `dev-tests/symbol-dns.test.ts` の53項目は通った。ただしこの環境には `node_modules` が無いので、`@noble/hashes`（keccak_256・sha256）の代わりに、仮の実装（keccak は自作、sha256 は Node の crypto）を一時的に差して走らせた。仮の実装は NanoWallet と同じ鍵の例（`nem`・`kasane`）と一致することを確かめてあり、配布物には入れていない。あわせて、変更したファイルの構文（TypeScript の構文解析）、取り込んだ名前が相手のファイルに実在すること、画面が使う翻訳キーが ja・en・zh・ko・ru に揃っていること（`{{…}}` の差し込みも一致）を確かめた
- **確認できていないこと（重要）**: **`tsc -b`・`vite build`・`oxlint` と `dev-tests/symbol-dns-tx.test.ts` は実行していない**（`symbol-sdk` などの依存が入っていない）。画面（`SymbolDns.tsx`）も実際には動かしていない。さらに、次の点は Symbol REST の仕様の理解で書いたもので、実際のノードで確かめていない — ①`GET /namespaces/{id}` の答えが `meta.active`・`namespace.ownerAddress`（16進）・`namespace.endHeight` を持つこと、子ネームスペースの期限が親に従うこと ②`GET /transactions/confirmed?recipientAddress=…&type=16724&order=desc&pageSize=100&pageNumber=…` と、それに `embedded=true` を足した一覧が、中の送金を `meta.aggregateHash`・`meta.height`・`meta.index`・`meta.timestamp` つきで返すこと（同じブロックの中での新旧は、通常の送金とアグリゲートの中の送金で `meta.index` の意味が違うので、厳密には比べられない。ふつうは高さで決まる）③モザイクなし・平文メッセージ（JSON）の送金をノードが受け付けること、bonded のアグリゲートに載せて連署者が署名できること、Ledger（Symbol アプリ）がそれに署名すること。まずテストネットで、自分のアカウント・マルチシグ（complete と bonded）を1件ずつ、登録 → 検索まで通すこと
- 未対応: ネームスペースの一覧画面からの DNS への入り口（`?name=` で開く入り口は検索タブにあるが、リンクはどこにも無い。NEM も同じ）、Symbol のネームスペースの別名（エイリアス）を使った検索、NEM と Symbol をまたいだ検索。zh・ko・ru の `symboldns.*` は機械的な訳で、母語話者の確認はしていない

## v228: Symbol アポスティーユの未対応分（Ledger・マルチシグ・多言語・mijin 表示）
- **Ledger のプロファイル**：公開のアポスティーユを作れるようにした。デバイスが送金に署名する（`sendSymbolApostille` が `ledgerIndex` を受け取り、`signTransferWith` ＋ `signWithLedger` を使う。通常の送金と同じ経路）。画面では、Ledger のときパスワードの代わりに「Ledger で署名して送る」ボタンを出し、押した直後に接続してから署名する。**署名つき（非公開）と更新は Ledger では作れない**（ファイルのハッシュへの署名と、そこから決まる専用アカウントに、鍵そのものが要る。デバイスは鍵を出さず、任意のハッシュにも署名しない）。作成画面にその旨を表示
- **マルチシグアカウントの名前で公証**：作成画面に「送信元」（Symbol のみ。連署者になっているマルチシグアカウントがあるとき）を追加。選ぶと、公開のアポスティーユを、そのアカウントの名前の送金（アグリゲートの中の1件）として送る。`planApproval` で自分の署名だけで足りるか（complete）、ほかの署名が要るか（bonded＋ハッシュロック）を決め、費用は `quoteMultisigCost`（アグリゲートの手数料＋ロックの手数料。預けるロック額は手数料に含めず別に表示）。bonded のときは、結果に「ほかの連署者の署名待ち」を出す。履歴には、所有者・送信元ともマルチシグアカウントのアドレス、取引ハッシュはアグリゲートのハッシュを保存する。署名つきと更新は作れない（専用アカウントを決める鍵がマルチシグアカウントに無い）
- エクスプローラー・監査：アグリゲートの中の送金も扱う。エクスプローラーは `embedded=true` の一覧も取り、アグリゲートのハッシュ（`meta.aggregateHash`）で並べる。監査は、アグリゲートのハッシュで引いたとき、答えに入っている中の送金（`transaction.transactions`）からアポスティーユを読み、署名者は中の送金の署名者（＝マルチシグアカウント）にする
- **mijin v2 の証明書**：「MAINNET」と出ていたのを「MIJIN」に（`lib/apostilleCertificate.ts` のネットワークを `mainnet | testnet | mijin` に）
- **zh・ko・ru**：`apostille.*` の86キー（Symbol 版で足したものと、今回の新しい9キーを含む）を中国語・韓国語・ロシア語に訳した。`{{…}}` の差し込みは全キーで英語と一致することを確認。NEM 側の画面も同じキーなので、NEM でもこの言語で出る（それまでは zh・ko・ru には `apostille` が1つも無く、すべて英語だった）。NEMonster for Symbol の `*_symbol` キーは今回も英語のまま
- 変更: `lib/symbol/tx.ts`（マルチシグの内側の送金に `rawMessage`、`multisigRawTransferAggregateSize`）、`lib/symbol/apostilleApi.ts`、`pages/apostille/ApostilleCreate.tsx`、`lib/apostilleCertificate.ts`、`i18n/messages.json`（ja・en に9キー）、`i18n/{zh,ko,ru}.json`、`dev-tests/symbol-apostille.test.ts`（マルチシグの項目を追加）、`docs/FEATURES.md`
- **確認できていないこと（重要）**：この環境にはネットワークが無く `npm ci` が終わらないため、**`tsc -b`・`vite build`・`oxlint`・テストはどれも実行していない**。確認したのは、依存なしで走らせた `tsc`（型定義が無いので参考程度）で、変更したファイルに「使っていない変数」や名前の間違いが出ないことだけ。追加したテストも未実行。さらに、次の点は Symbol REST の仕様の理解で書いたもので、実際のノードで確かめていない — ①アグリゲートを `GET /transactions/confirmed/{hash}` で引いたとき、答えに中の送金（`transactions`）が入っているか ②`embedded=true` と `recipientAddress`・`type` を組み合わせた一覧が、中の送金を返し、`meta.aggregateHash` を持つか ③bonded のアグリゲートにメッセージ入りの送金を載せて、連署者が署名できるか ④Ledger（Symbol アプリ）が、モザイクなしでバイナリのメッセージの送金に署名するか。まずテストネットで、Ledger・自分のアカウント・マルチシグ（complete と bonded）を1件ずつ通すこと
- 未対応: Ledger のプロファイルからのマルチシグ公証、マルチシグ・Ledger での署名つき公証、所有権の移転（NEM と同じ）、NEM 側の Ledger・マルチシグ公証、NEMonster for Symbol の zh・ko・ru

## v227: Symbol にもアポスティーユ（公証）
- NEM のアポスティーユと同じ仕組みを Symbol 側に追加。ファイルのハッシュ（公開）またはハッシュへの署名（署名つき＝非公開）を、**モザイクを含まない送金のメッセージ**として Symbol のブロックチェーンに残す。作成・監査・履歴・エクスプローラー（Home のリボン）・更新・証明書・ZIP は NEM と同じ画面で、チェーンに合わせて動く。入り口は サービス → アポスティーユ（Symbol のサービスは「アポスティーユ」と「NEMonster」）と、Home の「アポスティーユ」リボン
- メッセージは NEM と同じ（`FE 4E 54 59`＋ハッシュ種別＋ハッシュ／署名）。違いは4つ
  - Symbol の送金のメッセージは先頭に種別バイトが付くので、実際に載るのは `00`＋アポスティーユのメッセージ（70バイト前後）
  - 署名は Symbol の鍵（Ed25519/SHA-512）。同じ秘密鍵でも NEM の署名とは別物で、NEM の記録を Symbol の方式では検証できない（逆も）。ハッシュは NEM と同じ（SHA3 は Keccak）ので、公開のメッセージは NEM と同じバイト列
  - 専用アカウントの決め方は NEM と同じ（自分の鍵でファイル名の SHA-256 に署名 → 下位32バイトが秘密鍵）。Symbol の鍵で計算する
  - **公証用のシンクアカウントは KASANE が決めた**（NEM のような既存の決まりが Symbol には見つからなかった）。`SHA3-256("KASANE apostille sink " + ネットワークのバイト)` を「公開鍵」とみなしたアドレスで、誰も秘密鍵を持たない。ネットワークのバイトから毎回計算するので、メインネット・テストネット・mijin v2 のどれでも同じ式。**ほかのウォレットが別のシンクを使えば、お互いのエクスプローラーには出ない**
- 手数料は Symbol の手数料（XYM。設定の「手数料の既定値」の段階）。送金サイズ（160＋1＋メッセージ）×倍率。NEM は固定の XEM のまま
- 履歴の保存先はチェーンごと（NEM は従来の `APOSTILLE_NTY_<ネットワーク>` のまま、Symbol は `APOSTILLE_NTY_SYMBOL_<ネットワーク>`）。Symbol の取引履歴では、アポスティーユの送金のメッセージ（ハッシュ・署名で文字ではない）は `[Apostille]` と表示
- 画面の共通化: `lib/apostilleChain.ts`（チェーンごとの違い＝署名・送金・手数料・宛先・記録の読み方・リンク・エラーを1か所に）。画面（`pages/apostille/*`）は NEM か Symbol かを知らずに、ここを呼ぶ
- 追加: `lib/symbol/apostille.ts`（シンク・メッセージ・専用アカウント・検証）、`lib/symbol/apostilleMessage.ts`、`lib/symbol/apostilleApi.ts`（取引の照会・エクスプローラーの一覧・送信）、`lib/apostilleChain.ts`、`dev-tests/symbol-apostille.test.ts`（69項目）
- 変更: `lib/symbol/tx.ts`（`rawMessage`＝種別バイト込みのメッセージ、`transferSizeForMessageField`）、`lib/symbol/api.ts`（`SendTransferInput.rawMessage`、履歴の表示）、`lib/nem/apostille.ts`（`hashByVersion` を公開、`verifyApostille` に署名の検証方法を渡せるように）、`lib/nem/apostilleStore.ts`、`lib/apostilleCertificate.ts`（チェーン名）、`pages/apostille/*`、`pages/service/ServiceHub.tsx`、`pages/top/Home.tsx`、`router.tsx`、`i18n/messages.json`（ja / en）
- 確認したこと: `npm run build`（tsc -b と vite build）、`oxlint`、新規テスト69項目、既存のアポスティーユ・NEMonster・手数料・履歴のテスト
- **制限（Symbol のノードにもブラウザにもつなげなかったので、実機では動かしていない）**: 次の4点は、Symbol REST の仕様の理解で書いたもので、実際のノードで確かめていない — ①`GET /transactions/confirmed/{hash}`（監査）②`GET /transactions/confirmed?recipientAddress=…&type=16724&order=desc&pageSize=25&pageNumber=…`（エクスプローラー。`meta.timestamp` を時刻に使う）③モザイクなし・バイナリのメッセージの送金をノードが受け付けること（モザイクなしは NEMonster が使っているが、バイナリのメッセージは初めて）④手数料の見積もりと実際のサイズの一致（テストでは一致）。まずテストネットで1件公証して、監査・エクスプローラー・履歴まで通してから使うこと
- 未対応: マルチシグ・アグリゲート内での公証、所有権の移転（NEM と同じ）。Ledger のプロファイルでは使えない（NEM と同じ）。mijin v2 の証明書は「MAINNET」と出る（テストネットか否かだけで分けているため）。zh・ko・ru は英語のまま

## v226: Symbol 版の名前を「NEMonster for Symbol」に
- 「サービス」の画面のタイルは、「NEMonster」の下に改行して「for Symbol」（`ChoiceCard` のタイトルで `\n` を改行として表示するようにした。ほかのカードは改行を含まないので変わらない）
- NEMonster の画面の見出しは「NEMonster for Symbol」（NEM は「NEMonster」のまま）
- 変更: `components/ChoiceCard.tsx`、`pages/service/ServiceHub.tsx`、`pages/nem/NemMonster.tsx`
- 制限: ビルド・ブラウザでの確認なし

## v225: 同期が遅れているノードを使わない（エクスプローラと残高が食い違う件）
- 症状: エクスプローラ（symbol.fyi）では 3.6969 XYM なのに、KASANE は 0 XYM。診断ログでは、選ばれたノード（sym-main-01.opening-line.jp）が `GET /accounts/… no resource exists`（404）と答えていた
- 見立て: 内蔵のノード確認は「健全（apiNode/db が up）」と「同じネットワーク」しか見ておらず、チェーンに遅れているノードも通していた。遅れたノードは古い状態を返すので、あとから届いた残高が 0（404）に見える。承認の知らせ（WebSocket）も同じノードから来るので、遅れて届き、効果音や残高の反映が遅れる原因にもなる。**ただし、このノードが実際に遅れているかどうかは未確認**
- 直し方: ノードの最新ブロックが、そのノード自身のネットワーク時刻より3分以上古ければ、使わない（`lib/symbol/api.ts` の `nodeLagMs` / `probeNode`）。端末の時計は使わないので、端末の時計がずれていても全ノードが遅れて見えることはない。調べられなかったときは、そのノードを除外しない。除外したノードは診断ログに `…は同期が遅れているため使わない` と出る
- 手で選んだノード（設定 > ノード）は、これまでどおり確認なしで使う
- 変更: `lib/symbol/api.ts`
- 制限: ビルド・ブラウザでの確認なし

## v224: 応答のないノードを、数分のあいだ確認し直さない
- ブラウザのコンソールに `指定されたホスト名のサーバが見つかりませんでした (health / info)` が何度も出ていた。ノード一覧や内蔵リストにある、もう存在しないホストへの確認（`/node/health` と `/node/info`）が、ノード探索のたびにやり直されていたため。確認に失敗したノードは5分間は確認し直さない（全部が失敗したときは、記憶を捨ててやり直す）。`lib/symbol/api.ts` の `firstHealthy`
- コンソールの `404 (アドレス)` は、そのアドレスがチェーン上にまだ無いときのノードの正常な答え（ブラウザは 4xx をすべてエラーとして表示する）。残高は 0 として扱っている。消せない
- 制限: ビルド・ブラウザでの確認なし

## v223: 診断ログから見つけた2点（ノード選びの重複、切り替え直後の誤った相手への通信）
- ノード選びの重複: 診断ログで、切り替えた直後に `testnet: using ...` が同じ瞬間に何度も出ていた（同時に始まった通信が、それぞれ全ノードを確認していた。途中で別のノードに替わる原因にもなる）。同時に始まった探索は1つにまとめる（`lib/symbol/api.ts` の `resolveNode`）。失敗のあとの「選び直し」だけは別に動く
- 切り替え直後の誤った相手への通信: ログに NEM ノードへの `HTTP 400: address must be valid` があった。チェーンが NEM に替わった直後、ライブ更新（`components/LiveUpdates.tsx`）がまだ Symbol のアドレスを持ったまま NEM ノードに問い合わせていた（逆向きも同じ）。追うアカウントを、調べたときのチェーン・ネットワークと一緒に持ち、合っているときだけ接続する
- ログの読み方（コードは変えていない）: `GET /accounts/... no resource exists` は「そのアドレスはチェーン上にまだ一度も使われていない」というノードの正常な答え（残高 0）。行末の `(retrying)` は表示だけで、404 は再試行していない
- 変更: `lib/symbol/api.ts`、`components/LiveUpdates.tsx`
- 制限: ビルド・ブラウザでの確認なし

## v222: 残高がすぐ反映されない・メインネット⇔テストネットの切り替えがすぐ効かない、を修正
- 切り替え（原因はコードで確認）: Home の再読み込みが `[chain]` だけで動いていて、同じチェーンの中でのネットワーク切り替え（Symbol メイン⇔テスト）では動かなかった。画面に前のネットワークのアドレス・残高が残ったままだった。`[chain, network]` にし、切り替えた直後は前のネットワークの残高を消して読み込み中にする。読み込み中にまた切り替えたときは、前のネットワークの答えを捨てる
- 切り替えた直後のノード選び: 自動選択は「公開ノード一覧の取得（最大6秒待つ）→ そのあと各ノードの確認」の順だったので、初めて使うネットワークの最初の通信が遅かった。内蔵ノードの確認を一覧の取得と同時に始め、先に返ったほうを使う。ネットワークを切り替えた瞬間にノード選びも始める（`store/appStore.ts`）
- 残高（見立て。実機で未確認）:
  - 承認の知らせ（WebSocket）はノードの REST のデータベースより少し早く届くことがあり、1.5秒後の読み直しでは古い残高を読むことがあった。承認の知らせのあと、6秒後にもう一度読み直す（`components/LiveUpdates.tsx`）
  - 画面がバックグラウンドにあった間に知らせを取りこぼしたときのため、画面が前面に戻ったときにも読み直す
  - 読み込みが重なったとき、遅れて返った古い答えが新しい残高を上書きしないようにした（`hooks/useSymbolBalance.ts`）
- 変更: `pages/top/Home.tsx`、`hooks/useSymbolBalance.ts`、`components/LiveUpdates.tsx`、`lib/symbol/api.ts`、`store/appStore.ts`
- 制限: **ビルドもブラウザでの確認もしていない**。残高が遅れる原因が上の見立てと違えば、まだ遅れる

## v221: 効果音（ブロードキャスト時の ding・承認時の ding2）が鳴らなくなっていたのを修正
- 原因: セキュリティ強化で入れた Content-Security-Policy に `media-src` が無く、`default-src 'self'` にフォールバックしていた。ビルドは単一HTML（`assetsInlineLimit` が大きい）で音声ファイルも `data:` URI になるため、`data:` を許可していない CSP に音をブロックされていた（画像は `img-src` に `data:` があるので表示できていた）
- 直し方: `media-src 'self' data: blob:` を追加（`vite-csp.ts` の `buildCsp`、開発用の `index.html` も同じに）。再生のコード（`components/LiveUpdates.tsx`）は変えていない
- 確認: JSON の読み込みのみ。**ビルドして鳴るかは未確認**（この環境にはブラウザも依存パッケージも無い）
- 確認のしかた: `npm run build` → ビルド後の `index.html` の CSP に `media-src` があること。送金で、送信時に ding、承認時に ding2 が鳴ること（設定の「効果音」がオンで、ページを一度タップしたあと）

## v220: NEMonster を Symbol でも遊べるように
- 「サービス」(`/service`) を Symbol にも出し、Symbol のタイルは「NEMonster」だけ（mijin・閲覧用・Ledger のプロファイルでは出さない）
- 仕組みは NEM 版と同じ作り。ただし Symbol には公式の NEMonster がないので、KASANE 独自の版（NEM のコレクションとは別）
  - 専用の宛先（シンク）: 秘密鍵 ＝ SHA3-256(`"NEMonster-Symbol-" + アドレス`) から鍵ペアを作り、そのアドレス（`lib/symbol/nemonster.ts` の `symbolNemonsterSinkAddress`）。ネットワーク（メイン/テスト）ごとに別のアドレス
  - 「捕まえる」＝その宛先へ **モザイクなし（0 XYM）の転送** を送る（メッセージなし。手数料は 160 バイト分、ノードの手数料倍率で決まるので画面を開いたときに見積もる）
  - コレクション ＝ REST の `/transactions/confirmed?recipientAddress=宛先&signerPublicKey=自分` の取引ハッシュ（アグリゲートに入ったものは `embedded=true`）＋ 最初の仲間。未承認分は `/transactions/unconfirmed` で「捕獲中」に数える
  - モンスターの姿は NEM 版と同じ `monsterFromHash`（Symbol のハッシュも 64 桁の大文字 16 進）
- モザイクなしの転送を通すため、`TransferParams` / `SendTransferInput` に `allowNoMosaics` を追加（既定は今までどおり、モザイク 0 個は `no_mosaics` で拒否）
- 画面 `NemMonster.tsx` はチェーンに合わせて切り替わる（手数料・説明文・エラー文・エクスプローラのリンク）。文言は `nemonster.*_symbol`（i18next の context）を 5 言語に追加
- 変更: `lib/symbol/nemonster.ts`（新規）、`lib/symbol/tx.ts`、`lib/symbol/api.ts`、`pages/nem/NemMonster.tsx`、`pages/service/ServiceHub.tsx`、`router.tsx`、`components/NavigationDrawer.tsx`、`i18n/*.json`、`dev-tests/nemonster-symbol.test.ts`（新規）
- 未対応: 閲覧用プロファイルでの図鑑の表示、Ledger での捕獲、マルチシグアカウントからの捕獲、2,000 匹を超えるコレクション
- 制限: **ブラウザでも `tsc` でも動かしていない**（この環境に依存パッケージが無く、ネットワークも使えなかった）。手元で `npm run build` と `npx tsx dev-tests/nemonster-symbol.test.ts` を実行してから使うこと

## v219: 閲覧用プロファイルでは、ネットワーク選択をできないように
- サイドメニュー上部のロゴ（「Symbol Mainnet」など）を押しても、切り替えメニューが開かない。切り替えを示す上下の小さなマークも出さず、マウスを載せても色は変わらない。いまのネットワークの表示だけ残る
- 「設定 > ネットワーク選択」のカードは、いまのネットワークを表示するだけで、押しても開かない
- 対象は閲覧用だけ。通常のプロファイルと Ledger のプロファイルは、これまでどおり選べる
- 変更: `src/components/NavigationDrawer.tsx`、`src/pages/settings/SettingsTop.tsx`
- 注意: ロゴのメニューは Symbol / NEM の切り替えも兼ねているので、閲覧用では、チェーンの切り替えもできなくなる
- 確認: `tsc -p tsconfig.app.json --noEmit` 通過
- 制限: **ブラウザで動かしていない**

## v218: 「新しいプロファイルを追加」から、「すでにプロファイルをお持ちですか？ 保存済みのプロファイルを開く」を削除
- 画面上部の1行（と、そのリンク）をなくした。保存済みのプロファイル一覧には、左上の戻る矢印から戻れる
- 翻訳キー `wallet.new_have_profile` / `wallet.new_login_link` も5言語とも削除
- 変更: `src/pages/wallet/WalletNew.tsx`、`src/i18n/*.json`
- 確認: `tsc -p tsconfig.app.json --noEmit` 通過
- 制限: **ブラウザで動かしていない**

## v217: プロファイル選択で、閲覧用のカードだけ大きくなるのを修正
- 原因: 閲覧用のカードだけ、いちばん下に「閲覧用 · Symbol」の補足の行があり、その分だけ縦に伸びて、ほかのカードとそろっていなかった
- 直し方: 補足の行をカードの下端に浮かせて置くようにし（`ChoiceCard` に `hintFloating` を追加）、高さが増えないようにした。閲覧用でも、ふつうのプロファイルと同じ高さになる
- 変更: `src/components/ChoiceCard.tsx`、`src/pages/wallet/WalletSelect.tsx`。「新規プロファイル」の選択画面など、ほかの画面のカードは変えていない
- 確認: `tsc -p tsconfig.app.json --noEmit` 通過
- 制限: **ブラウザで動かしていない**（補足の行と本文が近づきすぎないかは未確認）

## v216: 「リカバリーフレーズ」を「ニーモニックフレーズ」に統一、RaccoonWallet由来の文言をKASANE向けに変更
- 日本語の表記を「ニーモニックフレーズ」に統一した（`リカバリーフレーズ` を全て置き換え。「ニーモニックフレーズ（リカバリーフレーズ）」のような併記は「ニーモニックフレーズ」だけに）
- プロファイル作成の最初の画面の見出し: 「ようこそ、お客人」→「ウォレットの作成」（「ようこそ、KASANE Walletへ。」は本文に残っている）
- インポート画面の説明: 「開けゴマ！」の行を削除。「あなたのアカウントをKASANE Walletにリンクします！」→「入力したニーモニックフレーズから、KASANE Walletにアカウントを復元します。」（秘密鍵のみの場合は「入力した秘密鍵のアカウントを、KASANE Walletに追加します。」）
- 変更: `src/i18n/messages.json`（日本語のみ）、コメント数か所、`docs/*.md`
- 変えていないもの: 英・韓・露・中の翻訳
- 確認: `tsc -p tsconfig.app.json --noEmit` 通過
- 制限: **ブラウザで動かしていない**

## v215: 初回起動時の使い方ガイド（ポップアップ）を廃止
- はじめてウォレットを開いたときに出ていた「使い方」のポップアップ（4ステップ）をなくした。`/top?guide=1` で開く経路も同じく無くなった
- 残したもの: 「バックアップ注意」のモーダル（ニーモニックフレーズを未バックアップのアカウントでホームを開いたときに出る）は、これまでどおり
- 変更: `src/components/HomeGuides.tsx`（ウィザード部分を削除）、`src/lib/onboarding.ts`（`kasane.guideWizardSeen` の読み書きを削除）、`src/i18n/*.json`（`guide.skip` / `next` / `finish` / `step1〜4`）、`docs/FEATURES.md`
- 端末に残っている `kasane.guideWizardSeen` は、読まれなくなるだけで害はない
- 確認: `tsc -p tsconfig.app.json --noEmit` 通過
- 制限: **ブラウザで動かしていない**

## v214: サイドメニューの縮小⇔展開の切り替えで、変な動きが出るのを修正
- 原因: 切り替えのたびに中身が作り直されていた。(1) 「KASANE」の文字とネットワーク名が、展開の瞬間にいきなり現れ、縮小の瞬間にいきなり消えた (2) ネットワーク名が、幅が狭い間は1文字ずつ折り返されて縦に伸び、下のメニューが一瞬ずれた (3) 丸いロゴが、縮小用と展開用の別の部品に差し替わり、横に約4px・縦に約4pxずれた (4) メニューの項目名が `display: none` の切り替えで、その場で出たり消えたりした
- 直し方: 縮小でも展開でも**同じ部品**のままにして、幅が変わるのに合わせて、メニューの枠で切り取る（ワイプ）ようにした。項目名・ロゴの文字・ネットワーク名は、いつも表示しておき、縮小のときは枠の外に出て見えなくなる（透明度も0.25秒に合わせて変える）。ネットワーク名は、展開したときの幅で最初から並べるので、途中で折り返しが変わらない。丸いロゴは、縮小でも展開でも同じ位置（左から36px）
- 変更: `src/components/NavigationDrawer.tsx` だけ
- 確認: `tsc -b` 通過、oxlint 警告0。縮小のとき、丸いロゴを押すとネットワーク選択が開き、ツールチップが出るのは、これまでどおり
- 変わった見た目: 縮小のとき、丸いロゴの位置が約4px下がった（展開のときと同じ高さにそろえたため）。縮小のときは、ロゴにマウスを載せても背景は付かない
- 変えていないもの: 右側のページの余白のアニメーション（0.25秒）
- 制限: **ブラウザで動かしていない**（動きは未確認）

## v213: 「このアプリについて」の内部の名前も「リンク集」に
- 画面のアドレスを `/about` → `/links` に、ページを `pages/about/About.tsx` → `pages/links/Links.tsx` に、翻訳の見出しを `about.title` → `links.title`（日・英・韓・露・中）に、カスタムテーマの画像の名前を `navAbout` → `navLinks`、CSSの変数を `--kasane-image-nav-about` → `--kasane-image-nav-links` に変えた
- **古い名前もそのまま読める**: v212 までに保存したテーマ（`navAbout`）と、書き出したCSS（`--kasane-image-nav-about`）は、読み込むときに新しい名前として扱う（両方あるときは新しい名前が優先）。書き出すCSSは新しい名前だけ。古いブックマーク（`#/about`）は `/links` に飛ぶ
- 変更: `src/router.tsx`、`src/pages/links/Links.tsx`、`src/components/NavigationDrawer.tsx`、`src/theme/customTheme.ts`、`src/i18n/*.json`、`dev-tests/custom-theme.test.ts`（古い名前を読むテスト4件を追加）、コメント2か所
- 確認: `tsc -b` 通過。`custom-theme`・`custom-theme-image`・`custom-theme-one-theme`・`custom-theme-store` の各テスト通過
- 注意: `dev-tests/links.test.ts` の「NEM testnet: links unchanged」が失敗する（テストは6件を期待、実際は5件でエクスプローラーなし）。今回の変更とは関係なく、そのまま
- 制限: **ブラウザで動かしていない**

## v212: カスタムテーマの「このアプリについて」を「リンク集」に
- サイドメニューの項目は、もともと「リンク集」（公式リンクのタイル）だったので、カスタムテーマの画像の一覧の名前を合わせた。「サイドバーのアイコン：このアプリについて」→「サイドバーのアイコン：リンク集」（英語は About → Links）。docs/FEATURES.md の説明も同じように直した
- 変更: `src/theme/customTheme.ts`（表示名のみ）、`src/components/NavigationDrawer.tsx`（コメントのみ）、`docs/FEATURES.md`
- 変えていないもの: 保存済みのテーマとCSSが使えなくならないよう、内部の名前（`navAbout`・`--kasane-image-nav-about`）はそのまま
- 制限: **ブラウザで動かしていない**。型チェックとテストも、この環境では実行していない（表示名の文字列を変えただけ）

## v209: カスタムテーマに、保存するときに名前を付けられるように
- アップロードしたCSSを保存するとき、「新しいテーマの名前」の欄が出る（はじめはファイル名が入っていて、40文字まで書き換えられる）。空にすると「カスタム N」になる。「新しいテーマとして保存して使う」で、この名前で保存される
- 保存したあとの名前の変更は、これまでどおり、一覧の鉛筆ボタン（名前を変える）でいつでもできる。「選んでいるテーマを置き換える」では、名前は変わらない
- 変更: `src/components/CustomThemeDialog.tsx`、`src/i18n/messages.json`（`custom_theme_new_name_label`・`custom_theme_new_name_hint`。日・英）、`docs/FEATURES.md`
- 確認: `tsc -b` 通過、既存のテスト通過
- 制限: **ブラウザで動かしていない**（入力欄の見た目は未確認）

## v208: カスタムテーマを10個まで保存できるように。ひな形はダークだけに
- **カスタムテーマを10個まで保存**できるようにした（これまでは1つ）。「カスタムテーマの設定…」の上に、保存したテーマの一覧が出る。1つごとに、使う（使用中の印つき）・名前を変える・CSSをダウンロード・削除（確認あり）。アップロードは「新しいテーマとして保存して使う」（10個あるときは不可）か「選んでいるテーマを置き換える」。保存したテーマは、設定のテーマ一覧・スタート画面・プロファイル選択の切り替えに、名前で並ぶ（選ぶだけで切り替わる）
- **ひな形は、ダークだけ**にした（「ひな形のもとにするテーマ」の選択を無くした）。ひな形のダウンロードは、「ひな形（ダーク）をダウンロード」の1つ
- 保存したテーマの書き出し（`buildThemeCss`）は、**設定してある値だけ**を書く。標準の色（チェーンごとに違う）を、別のチェーンの色として固定してしまわないため。画像と、チェーンごとの上書きのブロックも書き、読み直すと同じテーマに戻る
- 画像は、いま選んでいるテーマに付く。保存したテーマがないときは、1つ目の画像で新しいテーマが作られる。画像の上限は、1つのテーマで合計160万文字のまま、10個の合計で320万文字を足した（localStorage に収めるため）
- 保存の形: `customTheme`（1つ）→ `customThemes`（一覧。id・名前つき）と `customThemeId`（選んでいるテーマ）。**前の版の1つのテーマは、一覧の1つ目として引き継ぐ**。開くときに、壊れた項目・10個を超える分・id の重なり・画像の合計を超える分は、検証して捨てる（`sanitizeSavedThemes`）
- 変更: `src/theme/customTheme.ts`（`SavedCustomTheme`・`MAX_CUSTOM_THEMES`・`sanitizeSavedThemes`・`buildThemeCss`）、`src/store/appStore.ts`（`customThemes`・`customThemeId`・`saveCustomTheme`・`selectCustomTheme`・`renameCustomTheme`・`removeCustomTheme`・`selectActiveCustomTheme`）、`src/theme/useKasaneTheme.ts`、`src/theme/useThemeChoices.ts`（新規：テーマの選び方を共通に）、`src/components/CustomThemeDialog.tsx`（作り直し）、`src/components/LanguageThemeControls.tsx`、`src/pages/settings/SettingsTop.tsx`、`src/i18n/messages.json`（日・英）、`dev-tests/custom-theme.test.ts`（161項目）、`dev-tests/custom-theme-store.test.ts`（新規、19項目）、`docs/FEATURES.md`
- 確認: `tsc -b`・`vite build` 通過。上のテストと、画像・アカウント・ネームスペースの既存テストも通過
- 制限: **ブラウザで動かしていない**。ダイアログの見た目（一覧・名前変更・削除の確認）と、画像の実際の描き直しは未確認。1つのテーマの「置き換え」は、チェーンごとの上書きも含めてアップロードしたCSSの内容に置き換わる（画像だけは、CSSに書いていないものが残る）

## v207: カスタムテーマで、ロゴ・サイドメニューのアイコン・背景・残高カードの画像を差し替えられるように
- 「カスタムテーマの設定…」に「画像（ロゴ・アイコン・背景・残高カード）」の欄を追加。15か所（ロゴの六角形、ロゴの「KASANE」の文字、背景、残高カード、サイドメニューのアイコン11個）を、ファイルを選んで差し替えられる。1つ目の画像で、カスタムテーマが作られ、「カスタム」に切り替わる。位置ごとに、変更・削除、全部消す、使用量の表示
- 背景は背景色を `--kasane-background-dim`、残高カードは黒を `--kasane-hero-dim` の濃さで重ねる（新しい変数。ひな形に追加）
- CSS にも `--kasane-image-*: url("data:image/png;base64,...")` で書ける。ひな形には、画像の名前と大きさの説明をコメントで入れ、設定済みの画像は変数として書き出す。アップロードしたCSSが触れない画像は、いまの画像のまま（`none` で消す）。CSSの上限は100KB→3MB
- **画像は、描き直してから保存する**（`src/theme/imageProcessing.ts`）。選んだファイル、または CSS に書かれた data: を、ブラウザで読み、位置ごとの大きさ（アイコン96px・ロゴ640×560・文字1200×300・背景1600px・残高カード1200×900）に収めて canvas に描き、PNG（透過）または JPEG（背景・残高カード）で出し直す。大きければ、品質を下げ、縮めて、文字数の上限（アイコン6万・ロゴ30万・背景70万・残高カード50万、合計160万）に収める。SVG のスクリプトや外部の読み込み、画像のふりをしたファイル、EXIF は残らない。選べるのは PNG・JPEG・WebP・GIF・SVG（12MBまで）。CSS に書けるのは png / jpeg / webp の data: だけ（外のサイトの画像・SVG・gif は不可）で、保存データも、開くときに形式と長さを再検証する
- 画像は、ロゴ（`KasaneMark` / `KasaneWordmark`）とサイドメニュー（`NavigationDrawer`）に、同じ大きさの枠に縦横比を保って入る。背景は `stageBg`、残高カードは `hero` に入る（残高カードの文字の色・影は、そのまま）
- 変更: `src/theme/customTheme.ts`（画像の位置の定義・検証・ひな形・`;` を含む data: の分割）、`src/theme/imageProcessing.ts`（新規）、`src/theme/kasaneTheme.ts`（`kasane.images`・背景・残高カード）、`src/components/kasane/KasaneLogo.tsx`、`src/components/NavigationDrawer.tsx`、`src/components/CustomThemeDialog.tsx`、`src/i18n/messages.json`（日・英）、`dev-tests/custom-theme.test.ts`（画像の検査を追加、149項目）、`dev-tests/custom-theme-image.test.ts`（新規、11項目）、`docs/FEATURES.md`
- 確認: `tsc -b`・`vite build` 通過。`custom-theme.test.ts`・`custom-theme-image.test.ts` 通過（描き直しの流れは、`Image` と canvas を偽物に替えて確認）
- 制限: **ブラウザで動かしていない**。実際の画像の読み込み・canvas への描画・縮小の結果、SVG や GIF の読み込み、ダイアログの見た目、ロゴ・アイコンが枠にどう収まるか、背景・残高カードの見え方は未確認。画像の位置・大きさ（ロゴとアイコンの枠、背景は cover 固定）は変えられない。サイドメニューのアイコンは、選ばれている項目でも色が変わらない（画像のまま）

## v206: カスタムテーマのひな形CSSの文字化けを修正
- 原因: ダウンロードするひな形が BOM なしの UTF-8 だった。Windows のメモ帳など、文字コードを推測するエディタが、これを Shift_JIS として開き、日本語のコメントが文字化けしていた
- 修正: ひな形を **BOM つき UTF-8**（`text/css;charset=utf-8`）で保存するようにした（`saveTextFile` に `bom` を追加。ほかのダウンロードは変えていない）。ひな形の先頭に「UTF-8 です。保存するときも UTF-8 に」の説明も追加
- アップロード側も、文字コードに強くした: UTF-8（BOM の有無は問わない）を基本に、読めなければ Shift_JIS として読む（編集したエディタが Shift_JIS で保存し直しても、値もコメントも壊れない）
- 変更: `src/lib/saveTextFile.ts`、`src/theme/customTheme.ts`（`decodeCssBytes` を追加、先頭の BOM を無視）、`src/components/CustomThemeDialog.tsx`、`dev-tests/custom-theme.test.ts`（文字コードの検査を6項目追加）
- 確認: `tsc -b` 通過、`custom-theme.test.ts` 通過、ダウンロードされる先頭バイトが `EF BB BF`（BOM）であることを確認
- 制限: ひな形はすでにダウンロードした古いファイルでも、そのままアップロードできる（読み込みは変わらない）。ブラウザでの実際のダウンロードは未確認

## v205: カスタムテーマ（ひな形のCSSをダウンロード → 編集 → アップロード）
- 設定 > テーマ に「カスタムテーマの設定…」を追加。ダーク／ホワイト／ビジネス／さくらのいずれかの「いまの値」を書き出したひな形CSS（各項目にコメント付き）をダウンロードし、書き換えてアップロードすると、テーマ「カスタム」として保存・適用される。保存後は、設定のテーマ一覧とスタート画面のテーマ切り替えにも「カスタム」が出る。保存済みのものは、書き出し・削除ができる
- 変えられるのは `--kasane-*` の28項目（ベースの明るさ・背景・文字・アクセント・ボタンのグラデーション・残高カード・サイドメニュー・線・エラーなどの色・角の丸み・フォント）。`:root[data-chain='nem']` のように、チェーン（symbol / nem / mijin / base）ごとの上書きもできる
- **安全のため、アップロードしたCSSはそのままページに入れない**。`--kasane-*` の変数だけを読み、セレクタ・`@import`・`url()`・ほかのプロパティは読み飛ばして、理由と行番号を画面に出す。値は検証して決まった形に直してから保存し、アプリを開くときにも再検証する（`src/theme/customTheme.ts`）
- 変更: `src/theme/customTheme.ts`（新規：項目の定義・読み込み・検証・ひな形の生成）、`src/theme/useKasaneTheme.ts`（新規）、`src/theme/kasaneTheme.ts`（`createKasaneTheme` が `custom` を受け取る。`kasane.look` に、いまの値を持たせた）、`src/store/appStore.ts`（`ThemeMode` に `custom`、`customTheme`・`setCustomTheme`、起動時の再検証）、`src/main.tsx`・`src/components/kasane/KasaneStage.tsx`（カスタムを反映。index.css の色も追従）、`src/components/CustomThemeDialog.tsx`（新規）、`src/pages/settings/SettingsTop.tsx`、`src/components/LanguageThemeControls.tsx`、`src/i18n/messages.json`（日・英）、`dev-tests/custom-theme.test.ts`（新規）、`docs/FEATURES.md`
- 確認: `tsc -b`・`vite build` 通過。`custom-theme.test.ts`（4つのテーマ×4つのチェーンのひな形が、そのまま読み込めて元の見た目に戻ること、危ないCSSが値として入らないこと、チェーンごとの上書き、保存データの再検証、テーマへの反映）通過
- 制限: 画面は**ブラウザで動かしていない**（ダイアログの見た目、ファイル選択、実際の配色は未確認）。さくらの花びらの模様・背景の飾りは、カスタムでは出ない。韓国語・中国語・ロシア語は英語で表示される

## v191: アカウント画面で、アカウントの非表示と、インポートしたアカウントの削除ができない不具合を修正
- 原因: 一覧でアカウントを選ぶと、そのアカウントが「使用中」になる（`selectAccount`）。一方、「アカウントを非表示」「アカウントを削除」のボタンは「使用中のアカウントには出さない」条件（`selected.id !== activeId`）で、保存側の `removeImportedAccount` も使用中のアカウントを拒否していた。そのため、選んだアカウントには必ずボタンが出ず、実際には非表示も削除もできなかった
- 修正: 使用中のアカウントでも、非表示・削除ができるようにした。使用中のアカウントを隠す・消すときは、同じプロファイル・同じチェーンの次のアカウント（デフォルト → 表示中の先頭 → それ以外）に自動で切り替える（`Wallets.leaveActive`）。切り替え先がなければ、隠さない・消さない
- 変わらないこと: デフォルトのアカウントは、これまでどおり隠せず、削除もできない（別のアカウントをデフォルトにすれば可能）。インデックス0のアカウントは隠せない。ニーモニックから導出したアカウントは削除ではなく非表示だけ（いつでも戻せる）
- 変更: `src/lib/storage.ts`、`src/pages/account/AccountPage.tsx`、`src/i18n/messages.json`（`account.delete_failed`の文言。日・英）、`dev-tests/account-hide-delete.test.ts`（新規、12項目、通信なし、通過）
- 確認: `tsc -b` 通過。`account-purge`・`watch-profile` のテストも通過
- 制限: 画面は**ブラウザで動かしていない**

## v190: Symbol オプトインで作ったアカウントを、画面を閉じるときにポップアップで知らせる
- オプトインの体験で、オプトイン先のアカウントを新しく作って Symbol 側に加えた（`addImportedKeyToProfile` の結果が `added`）あと、画面の右上の「閉じる」を押すと、「アカウントを作成しました」のポップアップを出す。内容は、Symbol 側のアカウントとして追加したこと・そのアドレス・Symbol に切り替えるとアカウント画面で見られること・ペーパーウォレットを保管すること。OK で閉じて、サービス画面（`/service`）へ戻る
- すでに同じ鍵のアカウントがあった場合（`shown`）、別のプロファイルにあった場合、追加に失敗した場合は、ポップアップを出さず、これまでどおりすぐ閉じる（画面の中の説明は従来どおり）
- 変更: `src/pages/optin/OptinPage.tsx`、`src/i18n/messages.json`（`optin.account_created_title`・`account_created_message`、日・英。ほかの言語は英語）
- 確認: `tsc -b` 通過
- 制限: 画面は**ブラウザで動かしていない**。「Symbolで開く」ボタンで直接アカウント画面へ移るときは、ポップアップは出さない（画面の中に同じ説明が出ているため）

## v189: ネームスペースの更新を NEM でも Symbol と同じ画面に。Symbol のタブ名と並びを変更
- **NEM**: 「ネームスペースの更新」を、Symbol の更新タブと同じ並びに変更。1列で、説明 → 更新するネームスペース（残り約○日）→ 現在の有効期限 → 延長する期間 → 延長後の有効期限（目安）→ 費用の枠 → 下に固定の「確認画面へ」。確認画面でパスワードを入力して送る（これまでは画面の中の「更新」ボタンですぐパスワードを聞いていた）
  - NEM は1回の更新で必ず1年（365日）延びるので、「延長する期間」は「1年（365日）」の読み取り専用。延長後の有効期限は今の期限 + 365日。対象の判定（期限まで1か月以内か期限切れのルート）、送信、マルチシグ（ノーマル / マルチシグの切り替え）は変えていない
  - 右側にあった説明（手数料・ルート・更新期間）は、上の説明の枠にまとめた
- **Symbol**: タブ名を「更新」から「ネームスペースの更新」に変更（英語は「Renew Namespace」）。並びを「…｜サブネームスペース作成｜ネームスペースの更新｜エイリアス」に入れ替え（これまでは「エイリアス」が先）
- 変更: `src/pages/nem/NemNamespaceRenew.tsx`（作り直し）、`src/lib/nem/namespaceRenew.ts`（`NEM_RENEW_DAYS`・`nemRemainingDays`・`nemExtendedExpiryMs` を追加）、`src/pages/namespace/NamespaceList.tsx`、`src/i18n/messages.json`（`nemns.renew_intro` ほか、`namespace.tab_renew`。日・英）、`dev-tests/nem-namespace-renew.test.ts`（新規）、`docs/FEATURES.md`
- 確認: `tsc -b` 通過
- 制限: 画面は**ブラウザで動かしていない**（見た目は未確認）。NEM の実ノードでの送信も未確認。確認画面の文言は、登録の確認画面（`nemns.confirm_*`）に合わせて新しく作ったもの

## v188: Symbol にネームスペースの更新（期間の延長）のタブを追加
- ネームスペース画面（Symbol）の、いちばん右に「更新」タブを追加。NEM の「ネームスペースの更新」に近い形で、自分のルートネームスペースを選び、延長する日数を入れて送る。Symbol には更新専用のトランザクションがなく、同じ名前でルートをもう一度登録すると今の期限に期間が足される仕組みなので、中身はその登録（`registerNamespace`）。詳細は FEATURES.md「ネームスペースの更新 (Symbol)」
  - 現在の期限・残り日数・延長後の期限（目安）・費用を表示。日数は30〜1,825日で、残りと合わせて最長1,825日（約5年）。上限を超える入力と、上限に近くて延ばせない場合は、画面で止める
  - 「保有ネームスペース」の各ルート行に更新ボタン（期限が1か月以内は黄色）。期限が1か月以内のルートがあると、NEM と同じように警告のトーストを出す（「更新する」でこのタブへ）
  - `/namespace/renew` は、これまで Symbol では一覧へ戻っていたのを、このタブを開くように変更
- 変更: `src/pages/namespace/NamespaceRenew.tsx`（新規）、`src/pages/namespace/NamespaceList.tsx`、`src/components/SymbolNamespaceExpiryNotice.tsx`（新規）、`src/components/MenuShell.tsx`、`src/router.tsx`、`src/lib/symbol/namespaceRenew.ts`（新規）、`src/i18n/messages.json`（`namespace.tab_renew`・`renew_*`・`error_duration_*`・`error_taken_*`、日・英。ほかの言語は英語で表示）、`dev-tests/namespace-renew.test.ts`（新規、28項目、通信なし、通過）、`docs/FEATURES.md`
- 確認: `tsc -b`・`vite build` 通過。ほかのテストのうち `design-scope`・`mijin-network`・`mnemonic-qr` は失敗するが、元の v186 でも同じ失敗（今回の変更とは無関係）
- 制限: 画面は**ブラウザで動かしていない**。実際の Symbol ノードでの動作（同じ名前での再登録で期間が足されること、上限1,825日の判定、期限切れ後の猶予期間の扱い）も**未確認**。延長後の期限は、ブロック時間30秒からの目安。上限は「残り日数＋1日の余裕」で厳しめに見ている。マルチシグ口座のネームスペースの更新は未対応

## v187: NEM のモザイク作成・供給量変更を Symbol の画面の並びに揃える
- NEM の「モザイク」画面の「作成」「供給量の変更」を、NanoWallet 風（左にラベル・右に入力欄の2列）から、Symbol のモザイク画面と同じ並びに変更。1列、枠線つきの入力欄（ラベルは欄の中）、設定はスイッチと説明文、費用は枠で囲む、下に固定の「確認へ」ボタン（アイコンなし）
  - **作成**: ネームスペース → 名前（下に「フルネーム: ○○:○○」）→ 説明 → 初期供給量 → 可分性（下に総供給量）→ 設定（供給量の変更を許可／他のアカウントへの送信を許可／徴収を要求。スイッチ）→ 徴収（オンのときだけ。モザイク・受取アドレス・金額・固定／パーセンタイルのトグル）→ 費用の枠（レンタル料・手数料・合計・受信側アドレス）。入力・確認・送信の中身は変えていない
  - **供給量の変更**: モザイクの選択 → 現在の供給量・保有量・可分性 → 「作成／削除」のトグル → 変更する供給量 → 変更後の供給量の枠 → 手数料の枠。確認画面の戻るボタンも Symbol と同じ `BackButton`
- ネームスペースの作成（ルート／サブ）は、もともと Symbol と同じ並びだったので変更なし
- 変更: `src/pages/nem/NemMosaicCreate.tsx`、`src/pages/nem/NemMosaicSupply.tsx`、`src/pages/nem/NemLevyForm.tsx`（`stacked` を追加。Symbol 風の縦並びで徴収の欄を出す。「モザイクの編集」は従来の2列のまま）。文言は既存のキーだけで足りたので翻訳は追加なし
- 確認: `tsc -b`・`vite build` 通過。送信の処理は触っていない
- 制限: 画面は**ブラウザで動かしていない**（見た目は未確認）。「モザイクの編集」（`NemMosaicEdit`）は NanoWallet 風のまま

## v171: ネットワークに mijin v2（Catapult）を追加
- 設定 > ネットワークを「Symbol メインネット / Symbol テストネット / NEM メインネット / NEM テストネット / mijin v2」の1つの一覧にし、選ぶとチェーンとネットワークが一緒に切り替わる（mijin v2 は Symbol チェーンのみ。NEM には mijin v2 がないので、mijin を選ぶと Symbol に切り替わり、チェーン選択の NEM は隠れる）
- mijin v2 は導入ごとに世代ハッシュ・エポック・通貨モザイクIDが違うため、固定値は持たない。設定 > ノード（mijin 選択時）でノードの URL を入れると、`/node/info`（世代ハッシュ・ネットワークID）と `/network/properties`（エポック・通貨モザイクID）を読んで保存する（`lib/symbol/mijin.ts`）。Symbol のメインネット／テストネットのノードは「mijin v2 のものではない」として拒否
- ネットワークバイトは mijin が 0x60（アドレスは `M…`）、mijin-test が 0x90（`S…`）。ノードが返した値をそのまま使う。署名用のファサードはノードから読んだ世代ハッシュ・エポックで作り、別のチェーンの世代ハッシュでは署名しない（`facadeFor`）
- 鍵はメインネットと同じ（導出パス 4343）。アドレスのバイトだけが変わる
- ロゴ: mijin のロゴ（`logo_mijin.png` / `icon_chain_mijin.png`）をサイドメニュー・通貨アイコン・空画面に表示
- 公開ノード一覧・蛇口・エクスプローラは mijin にはない。ノードは登録したものだけを使い（自動選択なし）、「エクスプローラで開く」はエクスプローラURL（任意）か、未設定なら接続中ノードの REST（JSON）を開く
- アドレス帳・閲覧用アドレス・QR 読み取りは mijin のアドレスを判別。Symbol Wallet 向けの書き出しは mijin では不可
- 保存データ: app store を v3 にし、`customNodes` / `symbolNodeLists` に mijin を追加、`mijinParams` を保存（既存データは自動で移行）
- テスト: `dev-tests/mijin-network.test.ts`（`npx tsx dev-tests/mijin-network.test.ts`）
- 未対応/注意: Ledger は mijin 非対応。通貨の表示は XYM のまま

## v165: 公式Symbolウォレットとの互換（書き出しの導線＋テストネットの導出）
- 「公式ウォレット用に書き出す」を、プロファイル設定のメニューと、作成・インポート直後の「安全な保管の知識」画面にも追加
- テストネットの導出を公式ウォレットと同じ `m/44'/1'/n'/0'/0'`（コイン種別1）に対応。新しく作る・インポートするプロファイルは、Symbol の各アカウントに公式互換のテストネット鍵も持ち、テストネットでは自動でそれを使う（メインネットは従来どおり 4343）
- 既存のプロファイルは変換しない（従来の鍵のまま。アドレスも変わらない）。公式互換のテストネット鍵を持つのは、新しく作る・インポートするプロファイルだけ
- 鍵の持ち方: `testnetPublicKey` / `encryptedTestnetSecret` を Wallet に追加。ロード時にテストネットだけ差し替え、保存時に戻す（`Storage.loadWallets` / `saveWallets`）。パスワード変更は両方の鍵を再暗号化
- 公式ウォレットの書き出し: テストネットで公式互換の鍵を使っているアカウントは、ニーモニック＋コイン種別1の導出パスで書き出す（それ以外は秘密鍵のアカウント）。公式のテストネットのプロファイルの取り込みも、コイン種別1の導出なら「導出済み」として認識
- ペーパーウォレット（ニーモニック）も、テストネットで公式互換の鍵を使うときはコイン種別1の導出で作る
- 書き出しダイアログの文言を整理: ファイルは「バックアップ用（KASANEへの再取り込み用）」、公式ウォレットへはコンソールスクリプト、と分かるようにした
- 「公式ウォレット」の表記を「Symbol Wallet」に変更（書き出し・読み込み・見つかったときの案内。日本語・英語）。説明文に「Symbolの公式ウォレットアプリ」と添えた
- Ledger はこれまでどおり（テストネット対応は未対応）

## v157: アグリゲートを V3 に変更
- モザイク作成で `Failure_Aggregate_V2_Prohibited` になる不具合の対応。ネットワークが V2 のアグリゲートを受け付けなくなったため、Symbol 側のアグリゲートを全て `aggregate_complete_transaction_v3` / `aggregate_bonded_transaction_v3` に変更（`lib/symbol/tx.ts` と `lib/symbol/aggregate.ts` の7か所）
- 対象: モザイク作成、ネームスペース登録（メタデータ付き）、メタデータ付与、ハーベスト/投票キーのリンク、マルチシグ、アグリゲート（まとめて送信）

## 機能
- アカウント: BIP39 24単語（12単語のインポートも可）／秘密鍵インポート。導出パスは Symbol 標準の `m/44'/4343'/n'/0'/0'`
- ネットワーク: Mainnet / Testnet を設定画面で切替（アドレスは `N…` / `T…`、ネットワークごとに導出）
- ノード: 公開ノード一覧（symbol.services）から自動選択し、世代ハッシュで正しいネットワークか検証。手入力ノードも可
- 残高: XYM と保有する全モザイクを自動取得（カスタムトークン追加は不要）
- 送金: 任意のモザイク、平文メッセージ、手数料の自動見積り、送信後に承認/失敗を確認
- 履歴: 受信/送信トランザクション（未承認含む、アグリゲート内の転送も表示）
- QR: Symbol 標準のアドレスQR(v3)を生成。アドレス / アドレスQR / コンタクトQR / トランザクションリクエストQR / `web+symbol://request` を読み取り

## ロゴと見た目
- Portaldot / マスコットのロゴを、Symbolの公式ロゴ（シールド型）に置き換え（ようこそ画面・サイドメニュー・ダイアログ・ファビコン）
- アドレス帳・送金画面などの丸いアイコンは、ロゴを丸型に収めた `icon_chain_symbol.png`
- 配色はロゴから抽出: 紫 `#8D33E4` → `#6F00DF`（ボタン・上部バー・残高カード）、濃紫 `#521B8B`、アクセントにオレンジ `#F4A900`・ティール `#1FB5AC`・水色 `#78B6E3`
- 上部バーはSymbolの紫グラデーション＋白文字。ライト／ダークどちらも紫基調（配色は `src/theme/raccoonTheme.ts`）

## 削除したもの（EVM 専用機能）
ethers、SS58/H160 変換、ERC-20 トークン追加、NFT 画面、スワップ、カスタムEVMチェーン、売上管理など。

## ブラウザ向けの注意（vite.config.ts）
- `symbol-crypto-wasm-node`（Node専用WASM）→ スタブ。SDK は純JS の Ed25519 にフォールバック（`SYMBOL_SDK_NO_WASM`）
- `bitcore-mnemonic`（SDK の Bip32 用）→ スタブ。HD導出は `src/lib/symbol/hd.ts`（@scure/bip39 + SLIP-0010）で実装
  （SDK の Bip32 と出力が一致することを検証済み）

## データ保存
保存先を新しくしました（DB名 `VintageSymbolWallet` / ストア `vintage-symbol-wallet-app-store`）。
旧 Portaldot 版のウォレットは引き継がれません（鍵の種類が異なるため）。旧版のデータは消えず、旧版で開けます。

## 未対応
暗号化メッセージ、アグリゲート送信（マルチシグ以外）、ネームスペースの延長専用画面・エイリアス設定、モザイクの供給量変更、ハーベストのノード変更（停止→再開始。委任リクエストの再送は「ハーベスト」画面で可能 → FEATURES.md「委任リクエストの再送」）、WebSocket による即時更新。

## Home 画面への統合（受け取る / 送る / 取引履歴）
- Home を3つのリボン（**受け取る** / **送る** / **取引履歴**）を横並びにした構成に変更。リボンを押すとその内容が下に展開され、他は閉じる
  - 受け取る → アドレスQR・コピー（`pages/top/ReceivePanel.tsx`）
  - 送る → 送金入力画面（`pages/top/SendForm.tsx`）。**送るモザイクもこの画面のセレクトで選ぶ**。送信先・金額・メッセージ・手数料を入力して「確認画面へ」→ `/send/confirmation`
  - 取引履歴 → 直近の履歴（初期表示）。「すべての取引履歴を見る」で `/transaction/list`
- 展開中のセクションは `appStore.homePanel` に保持（アドレス帳・確認画面から戻っても同じセクションが開く）
- サイドメニューから「受け取る」「送る」「取引履歴」を削除
- アドレス帳の「このアドレスに送る」→ Home の送るセクションを開き、送信先を入力済みにする
- 旧画面（`Receive.tsx` / `Send.tsx` / `SendAddress.tsx`、モザイク選択画面、`/send/address` ルート）は廃止

## 手数料の3段階設定
- 送る画面の手数料を **遅い / 標準 / 速い** から選択（各段階の金額を表示、初期値は標準）
  - 倍率はノードの `/network/fees/transaction` から計算: 遅い＝最小倍率、標準＝中央値、速い＝標準の2倍〜（直近の最高値、ただし標準の4倍まで）
  - ノードから取得できないときも、既定の倍率で3段階を計算する
- 確認画面は選んだ段階の手数料を表示し、送信時もその倍率（`maxFee`）で署名

## 手数料の見積もり（入力なしで計算）
- 手数料見積もり用のトランザクションサイズを、SDKでダミーのトランザクションを組み立てる方式から、レイアウトに基づく計算（160 + 16×モザイク数 + メッセージ）に変更。アドレス・金額・メッセージが空でも常に見積もれる（1モザイク・メッセージなしで176バイト）

## サイドメニューの並び順 / モザイク作成
- サイドメニューを **Home → ウォレット切替 → モザイク → アドレス帳** の順に変更（モザイクはウォレット切替の直下）
- 「モザイク」（`/mosaic`、`pages/mosaic/MosaicList.tsx`）: 選択中のウォレットが作成したモザイクの一覧（モザイクID・供給量・分割可能数・有効期限・設定）と「モザイクを作成」ボタン。各カードはエクスプローラで開く
- 「モザイクの作成」（`/mosaic/create`、`pages/mosaic/MosaicCreate.tsx`）: 入力 → 確認（パスワード）→ 送信
  - 入力: 初期供給量、分割可能数（0〜6）、設定4種（供給量の変更可／他人へ送信可／制限可／回収可）、有効期限（無期限、または日数。1日＝2,880ブロック、最大3,650日）
  - 費用: モザイクのレンタル料（ノードの `/network/fees/rental`。取得できないときは500 XYM）＋トランザクション手数料（標準）を表示。XYM残高が足りなそうなときは警告
  - 送信: `AggregateCompleteTransactionV2` に MosaicDefinition と MosaicSupplyChange（INCREASE）を入れて署名（`lib/symbol/tx.ts` の `signMosaicCreation`）。モザイクIDはSDKの `generateMosaicId`（アドレス＋ランダムなnonce）で生成
  - 送信後は SendTransfer と同じくステータスを確認し、失敗時（XYM不足・時計のずれなど）は理由を表示
- 送信処理の「アナウンス→状態確認」を `announceSigned()` にまとめ、送金とモザイク作成で共用

## ネームスペース登録
- サイドメニューを **Home → ウォレット切替 → モザイク → ネームスペース → アドレス帳** の順に変更（ネームスペースはモザイクの直下）
- 「ネームスペース」（`/namespace`、`pages/namespace/NamespaceList.tsx`）: モザイク画面と同じ構成。タブ「保有ネームスペース / ネームスペース作成 / サブネームスペース作成」（作成タブは画面遷移せず下の部分だけ入れ替え）。保有タブは表（Id・名前・有効期限・期限切れ・エイリアスタイプ・エイリアス。スマホはカード）、右上に「メタデータ追加」・「期限切れネームスペースを表示」・再読み込み
- ネームスペース作成（`/namespace/register` は作成タブを開いた `/namespace` と同じ画面、`pages/namespace/NamespaceRegister.tsx` を埋め込み）: 入力 → 確認（パスワード）→ 送信
  - 種類: **ルート**（名前＋レンタル期間 30〜1,825日。1日＝2,880ブロック）／**サブ**（自分が持つ期限内のネームスペースを親に選び、その下に作る。深さは最大3階層）
  - 名前: 半角小文字・数字・`_`・`-`（最大64文字、先頭は英数字）。入力時に小文字へ自動変換
  - 費用: レンタル料（ノードの `/network/fees/rental` から。ルート＝1ブロックあたりの料金×ブロック数、サブ＝固定）＋トランザクション手数料（標準）。取得できないときは「取得できませんでした」と表示。XYM残高が足りなそうなときは警告
  - 送信: `NamespaceRegistrationTransactionV1` を署名して送信（`lib/symbol/tx.ts` の `signNamespaceRegistration`。IDはSDKの `generateNamespaceId`）。名前の重複・予約、XYM不足、時計のずれは理由を表示
  - 自分が持つルートを同じ名前で登録し直すと、期間が延長される（ネットワークの仕様）

## ハーベスト設定（委任ハーベスト）
- サイドメニューの **アドレス帳の下**（About / 設定の区切り線の上）に「ハーベスト」を追加
- 「ハーベスト」（`/harvest`、`pages/harvest/HarvestSettings.tsx`）: 選択中のウォレットの状態（設定済み / 未設定 / 設定が不完全）、XYM残高と必要残高（ノードの `/network/properties` の `minHarvesterBalance`、取得できないときは10,000 XYM）、リンク中のノード・リモートアカウントを表示
- 開始: ノードを選ぶ（接続中のノード／統計サービスのピアノード一覧／公開鍵の手入力）→ 確認 → パスワード → 送信
  - 使い捨てのリモートアカウントとVRFアカウントを新しく作り、`AggregateCompleteTransactionV2` に AccountKeyLink / VrfKeyLink / NodeKeyLink を入れて署名（`lib/symbol/tx.ts` の `signHarvestLinks`）
  - 続けて、ノードのアドレス宛てに「ハーベスト委任リクエスト」（2つの秘密鍵をノードの公開鍵で暗号化したメッセージ。SDKの `encodePersistentHarvestingDelegation`）の転送を送信（`signHarvestDelegation`）。リンクが失敗したときは、鍵をノードに送らない
  - 秘密鍵はアプリに保存しない（解除に必要なのはチェーン上の公開鍵だけ）
- 停止: チェーン上に残っているリンク（リモート / VRF / ノード）を、署名直前に読み直して、すべてアンリンク
- 費用: リンクと依頼の手数料（標準）を表示。XYM残高が必要残高に足りないときは警告（開始は止めない）
- 反映には、ネットワークの承認後、最大48時間ほどかかることを画面に表示

## メタデータ
- サイドメニューに **メタデータ**（`/metadata`、`pages/metadata/MetadataPage.tsx`）を追加（ネームスペースの下、アドレス帳の上）→ v57で廃止（メニュー項目と `/metadata` を削除。メタデータはアカウント・モザイク・ネームスペースの各画面で設定。`MetadataPage.tsx` は一覧の編集部品 `MetadataEditor` のために残す）
  - 付ける対象を **アドレス / モザイク / ネームスペース** から選ぶ。モザイクは自分が作成したもの、ネームスペースは自分が登録した期限内のものだけが選べる（所有者本人の署名だけで送れる範囲）
  - 対象に設定済みのメタデータを一覧表示。タップするとキーと値が入力欄に入り、そのまま上書きできる（文字列の値のみ）
  - 入力: キー（文字列、または16桁の16進数）と値（UTF-8、最大1,024バイト）。文字列のキーはSDKと同じ規則（SHA3-256の先頭8バイト、最上位ビットON）で64bitキーにする
  - 入力 → 確認（パスワード）→ 送信。費用はトランザクション手数料のみ（レンタル料なし）
  - 既存のキーに付け直すと、現在の値を取得して「旧値 XOR 新値」＋サイズ差でトランザクションを組む（`lib/symbol/metadata.ts` の `xorValue`）
- モザイク作成・ネームスペース登録のフォームに **メタデータ（任意）** 欄を追加（最大5行、`components/MetadataEntriesEditor.tsx`）
  - 入力した行は、作成/登録と **同じアグリゲート** で送る（どれかが失敗したら全部取り消される）。手数料の見積もりも行数・値の大きさに合わせて更新
  - ネームスペースは、メタデータなしなら従来どおり単独のトランザクション、ありのときだけアグリゲートにする
  - 完了画面に「メタデータ画面へ」ボタン（承認されるまで1〜2分かかるため、あとから付けたい場合用）
- モザイク一覧・ネームスペース一覧の「メタデータ追加」は、メタデータ画面へ移動せず、その場のダイアログ（`MetadataEditor` を埋め込み）で開く
- トランザクションの組み立て: `lib/symbol/tx.ts` の `signMetadata`（Account/Mosaic/NamespaceMetadataTransactionV1 をアグリゲートの内側に入れて署名）。通信は `lib/symbol/api.ts` の `fetchMetadataEntries` / `quoteMetadataFee` / `setMetadata`

### 未対応（メタデータ）
他人のアドレス・他人のモザイク/ネームスペースへの付与（マルチシグ/連署が必要）、メタデータの削除、他人が付けたメタデータの表示。


## マルチシグ
- サイドメニューに **マルチシグ**（`/multisig`）を追加（メタデータの下、アドレス帳の上）
- 「マルチシグ」（`pages/multisig/MultisigTop.tsx`）: このウォレットの状態（通常 / マルチシグ、連署者と署名数）、連署しているマルチシグアカウントの一覧（「送金を作成」「設定を変更」）、署名待ちトランザクションの一覧と **連署する** ボタン（パスワード確認 → 連署を送信）
- 「マルチシグにする」（`/multisig/convert`、`MultisigConvert.tsx`）: 連署者のアドレス（最大25人）、承認に必要な署名数、連署者の削除に必要な署名数を入力 → 確認 → 送信。`?account=<アドレス>` を付けると、連署しているマルチシグアカウントの連署者の追加/削除と署名数の変更になる
- 「マルチシグから送金」（`/multisig/send`、`MultisigSend.tsx`）: 連署しているマルチシグアカウントから、モザイク・数量・メッセージを指定して送金
- 送信方式: 承認に必要な署名数が1の送金は `AggregateCompleteTransactionV2` で即送信。それ以外（設定変更は常に）は `AggregateBondedTransactionV2`。先にハッシュロック（既定10 XYM、`/network/properties` から取得。承認完了後に戻る）を払い、承認されるのを待ってから署名待ち（partial）として送信する。ロックは約41時間、署名待ちの期限は40時間
- 手数料は連署分（1人あたり104バイト）を見込んだ上限を表示。残高が足りなそうなときは警告
- 実装: `lib/symbol/tx.ts`（`signMultisigAggregate` / `signHashLock` / `cosignAggregateHash`）、`lib/symbol/multisigApi.ts`（`/account/{address}/multisig`、`/transactions/partial`、`/transactions/cosignature`）

### 未対応（マルチシグ）
入れ子のマルチシグ（連署者がさらにマルチシグ）、署名待ちの取り消し、連署者側へのプッシュ通知（画面を開いて確認する方式）、アグリゲート内の送金以外の操作（モザイク作成など）をマルチシグ名義で行うこと。

### 注意
- マルチシグにしたアカウントは単独で送金できません。連署者のウォレットをこのアプリに別ウォレットとして登録し、切り替えて操作します。
- ノードとの通信を伴う部分（ロックの承認待ち・連署）は、テストネットで少額で試してから使うことをおすすめします。

## Home: ハーベスト履歴リボン
- Home のリボン列で **取引履歴の右** に「ハーベスト履歴」を追加（`pages/top/Home.tsx`）。押すと直近10件のハーベスト報酬（受取額・日付・ブロック高）が展開され、下の「ハーベスト設定を開く」から `/harvest` へ移動できる
- 取得: `lib/symbol/api.ts` の `fetchHarvestRewards`。ノードのブロック明細（`/statements/transaction?targetAddress=…&receiptType=8515`、ハーベスト報酬のレシート）を読む。開いたときに読み込み、報酬がなければ「ハーベスト報酬はまだありません」を表示
- 日付はノードが明細に時刻を返したときだけ表示（返さないときはブロック高のみ）

## アドレス帳の廃止
- サイドメニューの「アドレス帳」、`/addressbook` 系のルートと画面（`pages/addressbook/`）、関連ライブラリ（`addressBookChains.ts` / `fileToDataUrl.ts`）、`AddressBookHelper` と型、翻訳文言を削除
- 送る画面の「アドレス帳から選ぶ」ボタンを削除（送信先はアドレス入力 / QR読み取りのみ）
- Home・取引履歴の相手先表示は、連絡先名ではなく常にアドレスを表示
- 端末に保存済みのアドレス帳データ（localForage の `ADDRESS_BOOK`）は読み書きしなくなるだけで、削除はしていない
- 「アドレス帳の『このアドレスに送る』」の記述（上の Home 統合の項）は無効

## 費用・手数料の表示を左寄せの「ラベル: 値」に統一
- モザイク作成・ネームスペース登録・メタデータ・マルチシグ・ハーベストの画面で、手数料やレンタル料・必要な残高が右端に離れて表示されていたのを、「手数料: 0.xx XYM」「必要な残高: 10 XYM」のように1行で左寄せに変更
- ハーベストの状態表示（残高・必要残高・リンク中のノードなど）も同じ形式に統一

## 上部バーの廃止（メニュー直下の5画面）
- サイドメニューから開く **モザイク / ネームスペース / メタデータ / マルチシグ / ハーベスト** の画面から、画面名を出していた上部バーを削除（メニューに項目名が常時出ているため二重表示だった）
- 下位画面の上部バーも削除（下の項を参照）

## 下位画面の上部バーの廃止と「戻る」ボタン
- モザイク作成・ネームスペース登録・メタデータ・マルチシグ（設定変更・送金・確認）の各画面と確認画面から上部バーを削除し、代わりに画面の左上に「戻る」ボタン（`components/BackButton.tsx`）を設置
- 入力画面 → 確認画面の流れでは、確認画面の「戻る」で入力画面へ戻る（入力内容はそのまま）。入力画面の「戻る」は一覧画面（またはひとつ前の画面）へ戻る。iOSのホーム画面アプリでは、従来の戻る矢印と同じく指定の画面へ移動する
- 完了画面は上部バーを削除（戻るボタンは付けず、「一覧へ」「エクスプローラで見る」などのボタンで移動）

## ウォレット名とネットワーク名の表示
- Home の残高カードで、アドレスの上に **ウォレット名** を表示
- サイドメニューのロゴ（アバター）の右は、ウォレット名の代わりに **ネットワーク名**（Symbol Mainnet / Symbol Testnet）を表示。メニューが閉じているときのツールチップも同様

## モザイク画面: 保有モザイクの表示
- 「モザイク」画面を **保有 / 作成** の2タブに変更（初期表示は保有）。「モザイクを作成」ボタンは上部にそのまま残る
- 「保有」: このウォレットが持っているモザイク（XYM含む、残高0は除く）をカードで一覧。名前（ネームスペース名）・モザイクID・保有量・分割可能数を表示し、カードを押すとエクスプローラで開く。自分が作成したものには「自分が作成」、他人へ送信できないものには「他人へ送信不可」のバッジ
- 「作成」: 従来どおり（供給量・有効期限・設定、メタデータボタン）
- 2つの一覧は同時に読み込み、片方が失敗してももう片方は表示できる

## プロファイル／ウォレット切替の整理
- **プロファイル = 生成された（またはインポートした）1つのニーモニック**。新規プロファイルは必ず新しいニーモニックを生成する
- プロファイル作成時に、そのニーモニックからインデックス 0〜9 のアカウントを導出して保存（`PROFILE_ACCOUNT_COUNT`、`lib/symbol/hd.ts`）
- GET STARTED → **プロファイル選択**（`/wallet/select`）：「新規プロファイル」＋作成済みプロファイルの一覧。新規はプロファイル名＋パスワードを同じ画面で設定 → ニーモニック表示 → 完了画面
- メニューの **ウォレット切替**（`/wallet/switch`）：今のプロファイルの別インデックスのアカウントを選ぶだけ。新規プロファイル作成・パスワード設定／入力は無し
- プロファイル名の変更・削除は、そのプロファイルの全アカウントに適用
- 旧バージョンで作ったウォレット（`profileId` なし）は、1つ1つが別プロファイルとして表示される
- **インデックス名**：ウォレット切替画面の「名前を変更」で自由に設定（空欄で「インデックス N」に戻る）。ホームの表示にも反映
- **インデックスの表示**：プロファイル作成直後に表示されるのはインデックス 0 だけ。残りは「インデックスを表示する」から手動で表示（導出済みの 0〜9 の中から選ぶ）
- **プロファイル削除**：歯車マーク →「プロファイルの設定」→「ウォレットを削除」から（プロファイル選択画面のゴミ箱ボタンは廃止）。パスワード確認 → そのプロファイルの全アカウントを削除
- 旧バージョンで作成済みのプロファイル（全インデックスが表示されていたもの）も、インデックス 0 以外は非表示に移行（`loadWallets`）
- プロファイル名・パスワード設定画面に「インデックス0のウォレット名（任意）」を追加（プロファイル名の下）

## ウォレット切替・プロファイル設定の変更
- **ウォレット切替**：インデックス 0 以外は「非表示にする」で一覧から隠せる（「インデックスを表示する」で戻せる）。インデックス 0 と、いま使っているアカウントは隠せない
- **ウォレット切替 → 秘密鍵でインポート**：秘密鍵（64桁hex）を入力 → パスワード確認 → 現在のプロファイルにアカウントとして追加（インデックスなし、表示名は「インポートした鍵」。名前変更・非表示も可）。すでに同じプロファイルにある鍵は再表示、別プロファイルにある鍵はエラー
- **プロファイル選択画面**：ゴミ箱（プロファイル消去）ボタンを削除
- **歯車マーク**の画面名を「プロファイルの設定」に変更。「ウォレットの詳細」「ウォレットのアドレス」を削除（`WalletDetail` / `WalletAddress` とそのルートも削除）
- 「ウォレットのバックアップ」→「**プロファイルのバックアップ**」：ニーモニック（ニーモニックフレーズ）を表示してバックアップ。秘密鍵だけでインポートしたプロファイル（ニーモニックなし）は、従来どおり秘密鍵を表示
- ニーモニックのバックアップは、開いているアカウントが秘密鍵インポート分でも、同じプロファイルのニーモニックから取り出す

## プロファイル選択・ログアウトの変更
- **プロファイル選択画面**：アドレスと保有XYMの表示をやめ、プロファイル名のみ表示（残高取得も廃止）。ナビゲーションメニューも表示しない（`MenuShell`）
- **設定のログアウト**：データは削除せず、プロファイル選択画面（`/wallet/select`）へ移動するだけ（確認ダイアログも廃止）。ニーモニックフレーズ・秘密鍵・パスワードは端末に残る
- **ウォレット切替**：「プロファイルを切り替える」ボタンを廃止

## プロファイル削除
- 削除すると、そのプロファイルのニーモニックフレーズ・各インデックスの秘密鍵・プロファイルにインポートした秘密鍵をすべて端末から削除（メモリ上のホームのキャッシュも破棄）
- 設定の項目名と確認文言を「プロファイルを削除」に変更し、削除される内容を明記
- 最後のプロファイルを削除したときは、パスワード（確認用ハッシュ・失敗回数）も削除し、ウェルカム画面へ戻る。次のプロファイル作成時にパスワードを新しく設定する

## インポート・バックアップ・ログアウトの変更
- **インポート画面**（`/wallet/login/import`）：ニーモニックフレーズ（ニーモニック）のみ。秘密鍵の入力・切り替えを廃止。QR読み取りはニーモニックQR（パスワード暗号化・公式互換）の読み込みとして復活（FEATURES.md「ペーパーウォレット」参照）。秘密鍵は「ウォレット切替」から現在のプロファイルへ追加する
- **設定のバックアップ**：「秘密鍵のバックアップ」に改名し、選択中（アクティブ）のウォレットの秘密鍵を表示（注意画面 → パスワード確認 → 表示）。プロファイル設定の「プロファイルのバックアップ」（ニーモニック）は従来どおり
- **ログアウト**：「ログアウトしますか？」の確認ダイアログを表示。OK でプロファイル選択画面へ（データは削除しない）

## 用語・パスワードの変更
- 画面の文言の「ニーモニックフレーズ」を「ニーモニックフレーズ」に変更（英語は "mnemonic phrase"）
- **パスワードはプロファイルごとに設定**：
  - 新規プロファイルの作成、ニーモニックフレーズのインポートのたびに、そのプロファイル専用の新しいパスワードを設定（2回入力）。ほかのプロファイルのパスワードとは別
  - 署名（送金・モザイク・ネームスペース・ハーベスト・マルチシグ・メタデータ）・秘密鍵の追加インポートは、使用中のプロファイルのパスワードで確認
  - バックアップ・プロファイル削除は、そのプロファイルのパスワードで確認
  - 確認用ハッシュと失敗回数（ロックアウト）もプロファイルごとに保存（`PROFILE_PINS` / `PROFILE_PIN_ATTEMPTS`）
  - プロファイルを削除すると、そのプロファイルのパスワードも削除。最後のプロファイルを削除したときは、旧バージョンの共通パスワードも含めすべて削除
  - 旧バージョンの共通パスワードで作ったプロファイルは、そのパスワードで最初に確認に成功した時点で、プロファイル専用のパスワードとして保存し直す
- プロファイル名・パスワード設定画面（`/wallet/creation/name`）の案内文（ウェルカムの3行、パスワードの注意書き）を削除

## NEM（NIS1）対応
- サイドメニューの**ロゴを押す → NEM / Symbol を選択**。選んだチェーンは保存され、テーマ色もチェーンごとに変わる（Symbol＝紫、NEM＝グリーン）
- NEMもSymbol SDK v3（`symbol-sdk/nem` の `NemFacade` / `KeyPair`）で、鍵・アドレス・送金の組み立て・署名を行う。ノードへは NIS1 の `POST /transaction/announce`
- **プロファイル（1つのニーモニック）に Symbol と NEM のアカウントが同居**する
  - 新規作成・ニーモニックのインポートでは、同じ24単語から Symbol（`m/44'/4343'/n'/0'/0'`）と NEM（`m/44'/43'/n'/0'/0'`）の両方を作成
  - NEM対応前に作ったプロファイルは、NEMに切り替えたときの案内（パスワード1回）でNEMアカウントを導出
  - 秘密鍵でインポートしたアカウントは、メニューの「ウォレット切替」から（選択中のチェーンの秘密鍵として）追加
- NEMでできること：残高（XEM）・受け取り（NEMウォレット形式のQR）・XEM送金（メッセージ可）・取引履歴・エクスプローラー表示・ノード指定（設定）
  - 手数料はNEMの規定式（送る額に応じて0.05〜1.25 XEM＋メッセージ分）。3段階の選択はSymbol専用
  - モザイク・ネームスペース・メタデータ・マルチシグ・ハーベストはSymbol専用（NEMではメニューから非表示）
- NEMノード：**HTTPSノードのみ**対応。メインネットは内蔵のsupernode（HTTPS）と公式リスト（supernodes.nem.io）から自動選択。テストネットは公開HTTPSノードが無いため、設定画面でHTTPSのノードURLを指定
- 主な追加ファイル：`src/lib/chain.ts`、`src/lib/chainApi.ts`、`src/lib/accounts.ts`、`src/lib/nem/*`、`src/pages/top/NemSetup.tsx`
- NEMのノード設定に「ノードの接続テスト」を追加（候補ノードそれぞれの結果を ✓/✗ と理由で表示。✓ を押すとURL欄に入り、保存するとそのノードに固定）

## アグリゲート（まとめて送信）

公式 Symbol Desktop Wallet 1.2.0 の「アグリゲート」画面を、KASANE Wallet（Symbol モード）に移植。

- `/aggregate`（サイドメニュー「アグリゲート」）。送金・モザイク定義・供給量変更・ネームスペース登録（ルート/サブ）を積み、1つの AggregateCompleteTransactionV2 として送信する。
- 新規: `src/lib/symbol/aggregate.ts`（組み立て・署名・サイズ計算）、`aggregateApi.ts`（見積もり・送信）、`src/store/aggregateStore.ts`（下書き、永続化なし）、`src/pages/aggregate/`。
- このアグリゲートで作るモザイク／ネームスペースは、後続の項目（供給量変更・送金・サブネームスペース）から使える。削除すると依存する項目も一緒に消える。
- 手数料はビルドした実トランザクションのサイズから算出（遅い/標準/速い）。レンタル料は別掲。
- 送金は「送信元」を選べる: このウォレット / 連署しているマルチシグ口座 / 公開鍵で指定した別アカウント。
  - 自分の署名だけで足りるもの（このウォレットが連署者のminApproval 1のマルチシグ）は、そのまま complete 型。
  - 他のアカウントの署名が要るものを含むと、自動で bonded 型になる。ハッシュロック（10 XYM。承認後に返却）を送り、承認を待ってから、パーシャルとして送信する（既存のマルチシグ送信と同じ流れ）。
  - 手数料は連署の署名ぶんの余裕を含めて見積もる（アカウントごとに1回数える）。ロックの預け入れ額と手数料は費用欄に別掲。
  - 連署は既存の「マルチシグ」画面（承認待ち一覧）から行う。
  - 送信元を選べるのは送金のみ（モザイク定義・供給量変更・ネームスペースは常にこのウォレット）。
- 変更: `tx.ts` の `encodeMessage` と `multisigApi.ts` の `waitConfirmed` / `announcePartial` を export、`router.tsx`、`NavigationDrawer.tsx`、`messages.json`（ja/en `aggregate`）。

## NEM: スーパーノードプログラム
公式 NEM Nano Wallet（`superNodeProgram` モジュール）の機能を、KASANE Wallet の NEM モードに移植。

- チェーンが **NEM** のときだけ、サイドメニュー（ハーベストと同じ位置）に「スーパーノードプログラム」（`/supernode`）が出る。Symbol では表示せず、直接開いても Home に戻る（`router.tsx` の `NemOnly`）
- 画面は公式と同じ3タブ（`pages/supernode/SupernodePage.tsx`）
  - **ステータス**: 登録状態（稼働中 / 停止中 / 未登録）、ノード名、ホスト、公開鍵、リモート公開鍵、最後に支払われたラウンド、報酬の合計。上にアカウントとXEM残高
  - **参加登録**: 参加登録用アドレスとノードのホストを入力 → 確認 → パスワード → 送信。手数料は入力なしで表示
  - **報酬履歴**: ラウンド範囲・金額・トランザクション（NEMエクスプローラへのリンク）・日時を1ページ10件で表示
- 参加登録は、公式と同じく **0 XEM の送金** を参加登録用アドレスへ送り、メッセージは `enroll <ノードのホスト> <コードワードのハッシュ(64桁)>`。署名したアカウントの公開鍵が登録される
  - 送信前に、プログラムの API で ①参加登録用アドレスが現在の受付先か ②すでに同じホストで登録済みでないか ③コードワードを取得できるか を確認（公式と同じ。問題があれば送らずに理由を表示）
  - ホストは「ドメイン名またはIP」のみ（`https://`・ポート番号・`/` は不可）
  - 署名・送信は既存の `sendNemTransfer`（Symbol SDK v3 の `symbol-sdk/nem`）を使用。手数料は NEM の規定式（0 XEM なら最小手数料 + メッセージ分）
- API: `https://nem.io/supernode/api`（`/node/{公開鍵}`、`/codeword/{公開鍵}`、`/enrollment/check/address/{アドレス}`、`/enrollment/successes/{公開鍵}`、`/node/{id}/payouts`）。「未登録」（404）と「取得できない」（通信失敗など）は区別して表示
- **テストネットでは使えない**（プログラムはメインネットのもの）。画面に案内を出し、登録は無効
- 新規: `src/lib/nem/supernode.ts`、`src/pages/supernode/SupernodePage.tsx`。変更: `router.tsx`、`components/NavigationDrawer.tsx`、`i18n/messages.json`（ja/en の `supernode`、`home.nav_supernode`）

### 未対応（スーパーノードプログラム）
マルチシグアカウントからの参加登録（この NEM モード自体がマルチシグ未対応）、ハードウェアウォレット。

### 公式ウォレットとの違い
- 報酬履歴の最終ページ数は、公式は 15 件で割っていたが（1ページ10件で取得しているため、ずれる）、ここでは 10 件で割る

## NEM: ハーベスト（委任ハーベスト）
公式 NEM Nano Wallet の「リモートアカウントの管理」（`importanceTransfer` モジュール）の流れを、KASANE Wallet の NEM モードに移植。

- サイドメニューの「ハーベスト」（`/harvest`）が NEM でも出る。Symbol は従来の `HarvestSettings`、NEM は `pages/nem/NemHarvest.tsx`（`router.tsx` の `ByChain`）。スーパーノードプログラムはその下に続く
- 流れは公式と同じ2段階
  1. **リモートアカウントの有効化 / 無効化**: 重要性転送を署名して送信（SDK では Symbol の用語に合わせて `AccountKeyLinkTransactionV1`、ACTIVATE = `LinkAction.LINK` / DEACTIVATE = `LinkAction.UNLINK`）。手数料 0.15 XEM。ネットワーク承認から約6時間で有効になる（ACTIVATING → ACTIVE。無効化は DEACTIVATING → INACTIVE）
  2. **ノードでハーベスト開始 / 停止**: 選んだ HTTPS ノードへ、リモートアカウントの秘密鍵を `POST /account/unlock`（停止は `/account/lock`）。ノードの空き枠は `GET /account/unlocked/info`、リモートの稼働状態は `/account/get` の `meta.status`（UNLOCKED / LOCKED）
- 画面: ハーベストの状態（アカウント、XEM残高、有効残高と必要な有効残高 10,000 XEM、作成したブロック数、リモートの状態、リモートのアドレス、ノードでの稼働状態）、手順1（有効化 / 無効化）、手順2（ノードの選択 → 開始 / 停止）。操作はどれも「確認ダイアログ → パスワード」で実行
- **リモートアカウント**は、メインアカウントの秘密鍵から決まった方法で導出する（`lib/nem/harvest.ts` の `deriveNemRemoteAccount`: SHA3-256(固定の文字列 || 秘密鍵)）。保存は不要で、パスワードを入力するたびに作り直す。リモートの**公開鍵だけ**を `Wallet.nemRemotePublicKey` に保存し、パスワードなしでアドレスを表示できるようにした
  - 公式 NEM ウォレットが同じ鍵から作るリモートアカウントとは**別のアカウント**。公式ウォレットで有効化済みのアカウントは、先に公式ウォレットで無効化してからこちらで有効化すること
- ノード候補: 設定で指定したノード + 内蔵の HTTPS ノード。URL の手入力も可（HTTPS のみ）。最後に使ったノードは端末に覚える（localStorage、ウォレットごと）
- 主な追加・変更: `lib/nem/harvest.ts`（新規）、`pages/nem/NemHarvest.tsx`（新規）、`lib/nem/tx.ts`（`signNemImportanceTransfer`）、`lib/nem/constants.ts`、`lib/storage.ts`（`nemRemotePublicKey`）、`router.tsx`、`components/NavigationDrawer.tsx`、`i18n/messages.json`（ja/en の `nemharvest`）
- 上の「NEM（NIS1）対応」の項にある「ハーベストは Symbol 専用」は、この項で無効

### 未対応（NEM ハーベスト）
マルチシグアカウントの委任ハーベスト、ハードウェアウォレット、ハーベスト報酬の履歴表示、リモートアカウントを自分で指定すること（公式ウォレットの「リモート公開鍵を使用」）。

## NEM: NEMonster
公式 NEM Nano Wallet の「NEMonster」（NEMのブロックチェーンで遊ぶ小さな収集ゲーム）を、NEM のメニューに追加した（`/nemonster`、NEM 専用。Symbol では Home へ戻る）。
- 仕組み（公式ウォレットと同じ。同じアカウントなら両方で同じコレクションが見える）:
  - アカウントごとに専用の宛先（シンク）アドレスがある。秘密鍵は Keccak-256(`"NEMonster-" + アドレス`)（`lib/nem/nemonster.ts` の `nemonsterSinkAddress`）。誰も鍵を持たない、宛先としてだけ使うアドレス
  - 「モンスターを捕まえる」＝その宛先へ **0 XEM** を送る（メッセージなし。かかるのは手数料 0.05 XEM だけ）。送る前に確認ダイアログ → パスワード
  - 1つの送信（トランザクションのハッシュ）が1匹のモンスター。ハッシュから色・体・髪・目・口・歯・グラデーション・名前が決まる（`lib/nem/monster.ts`。公式の djb2 ハッシュ処理をそのまま移植し、5,000件のハッシュで元のコードと全項目が一致することを確認済み）
  - コレクション ＝ 宛先への受信トランザクション（`/account/transfers/incoming`）のうち、自分が署名したもの（マルチシグの包みも判定）＋ 最初の仲間（Jeff The Monster Slayer）
- 画面: 説明、捕まえる（宛先アドレス・手数料・ボタン）、コレクション（6匹ずつのページ送り、各モンスターのハッシュからエクスプローラへのリンク）。送信後、ブロックに取り込まれるまで（約1分）は「捕獲中」と表示し、15秒ごとに自動で再読み込みする
- 絵は公式の `css/NEMonster.css` をそのまま使い、全ルールを `.nemonster-scope` の下に限定して他の画面に影響しないようにした（`pages/nem/nemonster.css`）
- 主な追加・変更: `lib/nem/monster.ts`（新規）、`lib/nem/nemonster.ts`（新規）、`pages/nem/NemMonster.tsx`（新規）、`pages/nem/nemonster.css`（新規）、`router.tsx`、`components/NavigationDrawer.tsx`、`i18n/messages.json`（ja/en の `nemonster`、`home.nav_nemonster`）

### 未対応（NEMonster）
マルチシグアカウントからの捕獲、2,000匹を超えるコレクション（読み込みの上限）、モンスターの画像保存・共有。

## 追加ステップ 1: プロファイルのパスワード変更
公式 Symbol Desktop Wallet 1.2.0 の「Profile password」に相当。
- 「プロファイルの設定」に **パスワードを変更** を追加（`pages/wallet/WalletSettings.tsx`、`components/ChangePasswordDialog.tsx`）。いまのパスワード＋新しいパスワード（2回）を入力。
- `WalletsHelper.changeProfilePassword`（`lib/storage.ts`）:
  1. いまのパスワードを `PinCodeHelper.check` で確認（失敗回数のロックアウトも従来どおり）。
  2. そのプロファイルの全アカウント（Symbol / NEM / インポートした秘密鍵）の秘密鍵とニーモニックを新しいパスワードで暗号化し直す。ひとつでも復号できなければ何も保存せず中止。
  3. 確認用ハッシュを差し替える。失敗したときは暗号化を元のパスワードへ戻す。
- 新しいパスワードの条件は作成時と同じ（8文字以上、72バイト以内）。ニーモニック・秘密鍵そのものは変わらない。
- 他のプロファイルのパスワードには影響しない。

## 追加ステップ 2: 取引履歴の強化（Symbol）
公式 Symbol Desktop Wallet 1.2.0 の「Transactions」一覧・詳細に相当。**Symbol のみ**。NEM の履歴は従来のまま。
- `/transaction/list`（Symbol）: **承認済み / 未承認 / 署名待ち（Partial）の3タブ**、**種類フィルター**（送金・アグリゲート・モザイク・ネームスペース/エイリアス・メタデータ・マルチシグ・制限・ロック・キーのリンク）、**方向フィルター**（受信・関与 / 送信＝自分が署名）、25件ずつの「もっと見る」、再読み込み、**CSV書き出し**（表示中のタブ＋フィルター結果）。
- 表示する種類は全25種（送金、アグリゲート、モザイク定義/供給量変更/回収、ネームスペース登録、エイリアス、メタデータ3種、マルチシグ設定、制限5種、ハッシュロック/シークレットロック/プルーフ、キーのリンク4種）。未知の種類は「不明な種類」。
- `/transaction/view?hash=…&status=confirmed|unconfirmed|partial`（新規、Symbol のみ）: ハッシュで取得する詳細画面。署名者・公開鍵・手数料・日時（未承認/署名待ちは有効期限）・ブロック高・エクスプローラのリンク。送金は宛先・モザイク・メッセージ（暗号化は「暗号化されています」）。アグリゲートは **内部のトランザクション一覧と連署者**。その他の種類は REST が返す項目を翻訳付きで一覧表示（翻訳が無い項目は項目名のまま）。
- CSV は UTF-8（BOM付き）。`= + - @` で始まるセル（メッセージや名前は他人が決められる）は先頭に `'` を付けて、表計算ソフトで数式として実行されないようにしている。
- 新規: `lib/symbol/history.ts`（取得・整形・フィルター・CSV）、`pages/transaction/SymbolTransactionList.tsx`、`SymbolTransactionDetail.tsx`。変更: `router.tsx`（`ByChain`）、`i18n/messages.json`（ja/en の `history`）。
- Home の「最近の取引」（送金のみ）と従来の `/transaction/detail` はそのまま。
- 従来の一覧にあった「アグリゲートの中の送金」は、新しい一覧ではアグリゲート1行として表示され、詳細で内訳を見る形になった（一覧の取得を種類を問わない形に変えたため）。

### 未対応（取引履歴）
通知（WebSocket による即時更新）は後のステップ。ブラックリスト取引の非表示はアドレス帳のステップ。メッセージの復号は暗号化メッセージのステップ。

## 追加ステップ 2（仕上げ）: 期限切れ表示・WebSocket即時更新・通知・通知音
ステップ2の取りこぼしを実装。**Symbol のみ**。
- **期限切れ表示**: 未承認・署名待ちの取引で有効期限を過ぎたものに「期限切れ」を表示（一覧のチップ、詳細のチップと説明）。署名待ちは「署名を集めても承認されません」と案内。`isExpired`（`lib/symbol/history.ts`）。
- **WebSocket による即時更新**（`lib/symbol/live.ts`）: ノードの `wss://<ノード>/ws` に接続し、自分のアドレスの `confirmedAdded` / `unconfirmedAdded` / `unconfirmedRemoved` / `partialAdded` / `partialRemoved` / `cosignature` / `status` を購読。切断されたら 1→2→4…最大30秒の間隔で再接続（再接続時は別ノードも探す）。
- イベントを受けると、開いている画面が自動で再読み込みされる（`appStore.liveTick`、イベントが続けて来たときは1.5秒まとめて1回）: Home（残高・最近の取引）、取引履歴（表示中のタブは行を消さずに更新、他のタブは開いたとき）、取引詳細（承認されて別のグループへ移った取引も追いかける）。
- **新着通知**（`components/LiveUpdates.tsx`）: 承認 / 未承認 / 署名待ち / 連署追加 / 拒否（理由コード付き）を画面下に表示。押すとその取引の詳細へ。メニューのある画面（ウォレット使用中）でのみ動作。
- **通知音**: 公式 Symbol Desktop Wallet 1.2.0 の `ding.ogg`（Apache-2.0）を同梱（`assets/ding.ogg`）。ブラウザは画面を一度操作するまで音を出せないため、その前は鳴らない。
- **設定**: 「新着の通知」「通知音」をオン/オフ（Symbol のとき表示。既定はどちらもオン。端末に保存）。
- `fetchHistoryDetailAny`: 詳細を探すとき、指定のグループに無ければ他のグループも探す（404 のときだけ）。

### トランザクションURIについて（訂正）
公式デスクトップウォレットでは、トランザクションURIは **取引履歴の詳細ではなく送金フォームの中** にある（作成中の取引を `web+symbol://transaction?data=…` として表示する機能と、URIを読み込んで送金フォームに反映する機能）。履歴の詳細の項目としては存在しないため、ステップ2には含めず、**表示と読み込みを送金フォームに実装した（下の「トランザクションURI」の項）**。請求書QRなど他のQRはステップ6で続ける。

## トランザクションURI（送金フォーム）
公式デスクトップウォレットと同じく、**送金フォームの中**に実装。**Symbol のみ**（NEM では出ない）。
- **表示**: 送る画面で、入力が完全で手数料が出ているとき、手数料の下に折りたたみの「トランザクションURI」が出る（`pages/top/TransactionUriCard.tsx`）。開くと `web+symbol://transaction?data=<未署名トランザクション(hex)>&type=16724&generationHash=…&nodeUrl=…` をテキスト・コピー・QRで表示。入力を変えると作り直す（0.3秒まとめ）。
  - `data` は**署名なし**（署名欄はゼロ）。開いた人が内容を確認して自分で署名する。有効期限は作成から2時間（このウォレットの送金と同じ）。手数料は選んでいる段階（遅い/標準/速い）。
  - `nodeUrl` は接続中のノード（解決できなければ省く）。URIが2,000文字を超えるときはQRにせずテキストだけ。
- **読み込み**: 送る画面の送信先欄の下の「URIから読み込む」に貼り付け。`web+symbol://transaction?…`（送金のみ）・`web+symbol://request?…`・アドレスに対応。カメラの読み取り（`Scan.tsx`）も同じ処理で、`web+symbol://transaction` のQRを読める。
  - 送信先・モザイク・金額（分割可能数に合わせて換算）・メッセージが送金フォームに入る。**署名・送信はしない**（確認画面とパスワードは従来どおり）。URIの有効期限・手数料は使わず、送るときに作り直す。
  - 次のものは**読み込まずにエラーを表示**: 送金以外の種類、モザイクが複数ある送金（送る画面は1種類だけ。1つに切り詰めない）、暗号化メッセージ付き、別ネットワークのURI（`generationHash` が違う／アドレスのネットワークが違う）。
  - 取引リクエストQR（Symbol QR v3 の type 3）にも同じ検査を適用（以前は複数モザイクの2つ目以降と暗号化メッセージを黙って落としていた）。
- 新規: `lib/symbol/txUri.ts`（URIの組み立て・解析）、`lib/applyScanned.ts`（読み取り結果をフォームへ反映。`Scan.tsx` と「URIから読み込む」で共用）、`pages/top/TransactionUriCard.tsx`、`dev-tests/transaction-uri.test.ts`（`npx tsx dev-tests/transaction-uri.test.ts`）。変更: `lib/symbol/tx.ts`（`serializeUnsignedTransfer`）、`lib/symbol/qr.ts`、`pages/top/Scan.tsx`、`pages/top/SendForm.tsx`、`i18n/messages.json`（ja/en の `txuri`）。
- 履歴の**詳細画面には出さない**: ノードのREST APIは取引のシリアライズ済みデータを返さず、SDKもJSONから組み立て直せないため。

### 不具合の修正: メッセージなしの送金
SDK 3.3.3 は `message: undefined` を渡すと「descriptor does not have attribute message」で失敗する（キーごと省けば成功）。メッセージなしの送金を組み立てる3か所（通常の送金 `buildTransfer`、アグリゲート内の送金 `buildEmbedded`、マルチシグの内側の送金）が `message: encodeMessage(...)` と書いていたため、**メッセージを付けない送金**で失敗していた。`messageField()`（`lib/symbol/tx.ts`）でキーを省く形に統一。回帰テストは `dev-tests/transaction-uri.test.ts`。

## 取引履歴への入口
- サイドメニューに **取引履歴**（Home の下）を追加。3タブ・フィルター・CSVの一覧（`/transaction/list`）を直接開ける。この画面を開いている間は Home ではなくこの項目が選択表示になる。
- Home の取引履歴リボンの「すべての取引履歴を見る」を、送金が1件もないときも表示（未承認・署名待ち・送金以外の種類は、この一覧にしか出ない）。


## 取引履歴を Home の「取引履歴」に統合
- サイドメニューの「取引履歴」と専用ページ（`/transaction/list`）をなくし、履歴の本体を Home の「取引履歴」セクションに移した。Home の直近5件表示と「すべての取引履歴を見る」リンクも廃止（二重だったため）。
- Symbol: `pages/top/SymbolHistoryPanel.tsx`（3タブ・種類/方向フィルター・再読み込み・CSV・もっと見る・エクスプローラー）。NEM: `pages/top/NemHistoryPanel.tsx`（従来の一覧）。どちらも、セクションを開いたときに読み込む。
- `/transaction/list` は Home（取引履歴を開いた状態）へ転送する（古いリンク用）。取引の詳細画面の戻る先は Home。取引の詳細を開いている間も、サイドメニューでは Home が選択状態になる。
- Home の起動時に直近の取引を取得する処理（と `homeCache` の `recentTransactions`）は不要になったので削除。

## 請求書QRをPDFで保存
- 請求書QR（`InvoiceCard`）に **「PDFで保存」** ボタンを追加。バックアップのペーパーウォレットと同じ KASANE デザインの A4・1枚の PDF を端末の中で作ってダウンロードする（iOS は共有シート）。アップロードも保存もしない。
- 載る内容: 請求書QR、支払先アドレス、モザイクと金額（最大5件）、メッセージ、有効期限（UTC）、ネットワーク、注意書き。
- メッセージは、ASCII のときだけ文字で印刷（長いときは4行まで）。日本語などは「QRに含まれています」と表示（QR 自体には全文が入っている）。PDF の標準フォントで描くため、ペーパーウォレットと同じ方針。
- ボタンを押した時点で QR を作り直す（請求の有効期限＝作成から2時間 が、PDF を作った時点から始まる）。印刷した紙は、期限を過ぎたら使えない。
- 追加: `lib/invoicePdf.ts`（レイアウト）、`lib/invoicePdfExport.ts`（QR の画像化とダウンロード）、`dev-tests/invoice-pdf.test.ts`（`npx tsx dev-tests/invoice-pdf.test.ts`）。変更: `lib/paperWallet.ts`（ヘッダー・フッター・部品の共有化）、`lib/paperWalletExport.ts`（`qrToPng` などを共有）、`i18n/messages.json`（`invoice.download_pdf` など）。


## 署名・連署QR（署名済みトランザクション / 連署の依頼 / 連署済み / テンプレート）
Symbol のみ。プロファイル選択画面の右上「オフライントランザクション」（`/signqr`）で、4種類のQR（またはその文字列）を読み込む。生成は送る画面・マルチシグの画面にある。

**形式**: KASANE 独自のJSON（Symbol QR v3 の type 0〜3 とは別。他のウォレットは読めない）。`{"kasane":1,"kind":…,"network_id":…,"chain_id":<generation hash>,"data":{…}}`。`data` の中身は標準のSymbolのデータ（シリアライズ済みトランザクションのhex、アグリゲートのハッシュ、連署の署名）なので、取り出して他のツールで使える。別ネットワークのQR（`network_id` / `chain_id` が違う、または無い）は読み込まずエラー。2,000文字を超えるときはQRにせず文字列のコピーだけ。

| 種類 | 作る場所 | 読み込むとき |
| --- | --- | --- |
| 署名済みトランザクション（`signed`） | 送る画面の確認画面「署名してQRにする（送信しない）」。パスワードで署名し、**送信はしない**。有効期限は署名から2時間 | 種類・署名者・手数料・期限・送金の中身を表示 →「ノードに送信」 |
| 連署の依頼（`cosign_request`） | マルチシグ画面の承認待ちの各カード、およびマルチシグ送金・変更の完了画面の「連署QRを表示」 | 内容を表示 →「連署する」（パスワード）→ 連署済みQRを表示 / ノードへ送信 |
| 連署済み（`cosignature`） | 連署の依頼を読み込んで連署した後の「連署済みQRを表示」 | 署名を検証し、対象の取引（ノードにあれば）を表示 →「連署をノードに送信」 |
| テンプレート（`template`） | マルチシグ送金の画面（入力が揃ったら）「テンプレートQRを作る」 | 送金元・送信先・金額を表示 →「マルチシグ送金の画面で開く」（入力済みで開く。署名・送信はそこで） |

- **読み込み側は、QRの申告ではなくデータから判断する**: ハッシュはバイト列から計算し直し、QRの `hash` と違えば拒否。署名なし・別ネットワーク・期限切れ・連署が必要な（ボンデッド）トランザクションを署名済みQRとして送ることは拒否（期限切れは送信・連署のボタンを無効にする）。連署は、依頼にデータが入っていればそのハッシュ（計算し直した値）に、ハッシュだけならノードが返した取引のハッシュに署名する。
- **連署の依頼QR**: 完了画面のQRは署名済みアグリゲートのデータを含む（収まらなければハッシュだけ）。承認待ちの一覧から作るQRはハッシュだけ（ノードのRESTは取引のシリアライズ済みデータを返さないため）で、読み込む側のノードに取引が見えている必要がある。
- **署名済みQRは送金（Transfer）のみ**。アグリゲートやマルチシグの署名済みデータをQRにする入口は無い（読み込みは、ボンデッド以外のトランザクションならどの種類でも送信できる）。
- **テンプレートの意味**: マルチシグの送金（1種類のモザイク）。1アカウントの送金のテンプレートは、これまでの請求書QR（Symbol QR v3 の type 3）がそのまま使える。
- 変更: `lib/symbol/kasaneQr.ts`（形式・検証。SDKなし）、`lib/symbol/payloadSummary.ts`（トランザクションの内容の読み取り）、`pages/signqr/SignQrPage.tsx`、`components/QrTextDialog.tsx`、`lib/symbol/api.ts`（`signTransferForExport`。`sendTransfer` は同じ組み立てを共有）、`lib/symbol/multisigApi.ts`（`announceCosignature` / `fetchPartialByHash`。`submitMultisig` が署名済みデータも返す）、`pages/send/SendConfirmation.tsx`、`pages/multisig/*`（`ItemView` を `parts.tsx` へ移動）、`lib/applyScanned.ts`（送る画面のスキャナーはこのQRを読まず、読み込む場所を案内）、`router.tsx`、`NavigationDrawer.tsx`、`i18n/messages.json`（`signqr`）。
- テスト: `dev-tests/kasane-qr.test.ts`（形式。SDKなしで動く）、`dev-tests/sign-qr-flow.test.ts`（実際のSDKで署名→QR→ハッシュの再計算、連署の検証）。


## マルチシグ画面のUI
- マルチシグの各画面（`/multisig`・`/multisig/convert`・`/multisig/send`）を「ラベル（左）・入力（中央）・ヒント（右）」の行レイアウトに統一（`pages/multisig/parts.tsx` の `SectionCard` / `FormRow` / `Field` / `ValueBox`）。スマホでは縦積み
- 変換・設定変更画面: 操作タイプ、変換されるアカウント、連署者（なしの表示＋「連署者を追加」）、新しい最小承認者数 / 最小削除承認者数（ヒント付き）、手数料の順。送信の流れ（確認→パスワード）は従来どおり

## ハーベスト画面のUI
- 上部に「ハーベスト状況（再読み込み＋有効/無効）・XYM残高」、その下にタブ付きのカード（「デリゲートハーベスティング」「キーリンク」（後で追加するため無効化）「ハーベスト履歴」）。1カラム
- 「ハーベスト履歴」タブ: ブロックをハーベストして受け取った報酬（日時・ブロック・報酬額、直近100件、10件ずつ）。Homeの「ハーベスト履歴」と同じ `fetchHarvestRewards`（ブロックのレシート）を使う。タブを開いたときだけ読み込む。以前の「ハーベストされたブロック」の表と「生成ブロック」の数は削除
- ハーベストのノード指定に「URLを入力」を追加: 入力したURLの `/node/info` から公開鍵（とノード名）を自動取得し、ネットワークが違うノードは弾く（`fetchHarvestNodeByUrl`）

## サイドメニューのUI
- 行は全幅・大きめの線画アイコン（`components/NavIcons.tsx`）。開いているページは従来どおりメニューの色のグラデーションで塗る。項目名は「ホーム」「ハーベスティング」に

## オフライン署名（`/offline-sign`、Symbolのみ）
- ネット接続のないPCで送金に署名し、QRコード・JSON（テキスト／`.json`ファイル）で持ち出す画面。サイドメニューの「オフライン署名」。**この画面はノードに一切問い合わせない**（署名は `signTransfer`、手数料は `transferSize` で計算）
- ネットワークに聞けないものは手入力: 手数料の倍率（既定100）、有効期限（1・2・3・6時間。署名時刻はこの端末の時計）、非XYMモザイクの可分性。複数モザイク（最大10）に対応。メッセージは平文のみ（暗号化は相手の公開鍵をチェーンから取る必要があるため不可）
- 出力は「署名済みQR」（`kasaneQr.ts` の `signed`）と同じ形式。ネットに接続したPCの「署名・連署QR」で、読み取り・貼り付け・画像・**JSONファイルの読み込み（追加）**のどれでも送信できる
- オフラインPCに必要なもの: アプリ自体（ビルド済みの静的ファイル／インストール済みPWA）と、署名に使うウォレット（ニーモニックや秘密鍵でインポート済み）。署名の前に、端末の日付と時刻を確かめること
- 変更: `pages/offline/OfflineSignPage.tsx`、`pages/signqr/SignQrPage.tsx`（JSONファイル読み込み）、`router.tsx`、`components/NavigationDrawer.tsx`、`i18n/messages.json`（`offline`、`home.nav_offline`、`signqr.json_file_button`）

- ハーベストの開始ボタンは、残高が「必要な残高（10,000 XYM）＋開始の手数料」に足りないとき灰色で押せない（手数料が取得できない間は必要な残高だけで判定）。足りない理由を警告で表示（`start_balance_short`）

## 署名・連署QRの入口（プロファイル選択画面の右上）
- 「署名・連署QR」は、Symbolのサイドメニューから外し、プロファイル選択画面（`/wallet/select`）の右上のボタン「オフライントランザクション」から開く（`/signqr`。メニューなし、最初の画面と同じ固定のKASANEデザイン。開くときにSymbolへ切り替える。戻るボタンはプロファイル選択へ）
- 「オフライン署名」（`/offline-sign`）は従来どおりSymbolのサイドメニューにある（プロファイルを選んでから、ウォレットの中で署名するため）
- `KasaneStage` に右上のスロット（`topRight`）を追加

## オフライン連署（`/offline/cosign`、Symbolのみ）
- ネット接続のないPCで、連署の依頼（ボンデッドのアグリゲート）に連署し、連署済みのQR・JSON（テキスト／`.json`ファイル）で持ち出す画面。「オフライントランザクション」（`/offline`）の3つ目のカード。**この画面はノードに一切問い合わせない**
- 読み込めるのは、**トランザクション本体を含む**連署の依頼（読み取り・画像・JSONファイル・貼り付け）。ハッシュだけの依頼は、内容を確認できないので拒否（開始した人の「連署QRを表示」は、QRに収まらないときハッシュだけになる。そのため、このダイアログに **JSONファイルを保存** を追加。本体入りのJSONを持ち出せる）
- 内容はすべてバイト列から読み直す: ハッシュの再計算（QRの申告と違えば拒否）、ネットワーク、署名の有無、ボンデッドであること、**内部トランザクションがハッシュ（`transactionsHash`）と一致すること**。アグリゲートのハッシュは内部の中身を含まないので、中身をすり替えるとハッシュはそのままで表示だけ変わる。一致しなければ連署しない（この確認は、オンラインの「署名・連署QR」の連署にも追加）
- モザイクは、ネットワーク通貨と、この端末が覚えているもの（`mosaicCache`）だけ名前・桁数を表示。それ以外はIDと最小単位の数量で表示
- 有効期限は端末の時計で判定（期限切れは連署ボタンを無効にする）。連署するアカウントは、キーのあるSymbolのアカウントから選ぶ。開始した人（アグリゲートの署名者）のアカウントでは連署できない。オフラインでは、そのアカウントが本当に連署者かは確認できない（連署者でなければ連署は無視される）
- 出力は「連署済み」QR（`kasaneQr.ts` の `cosignature`）。ネットに接続したPCの「署名・連署QR」で、読み取り・貼り付け・画像・JSONファイルのどれでも送信できる
- 変更: `pages/offline/OfflineCosignPage.tsx`（新規）、`pages/offline/signingAccounts.ts`（新規。署名アカウントの選択を `OfflineSignPage` と共有）、`lib/saveTextFile.ts`（新規）、`lib/symbol/payloadSummary.ts`（`offline` / `knownMosaics` オプション、`contentsMatchHash`）、`components/QrTextDialog.tsx`（`file`）、`pages/multisig/parts.tsx`（連署QRにJSON保存）、`pages/signqr/SignQrPage.tsx`（内容とハッシュの一致確認）、`pages/offline/OfflineHub.tsx`、`router.tsx`、`i18n/messages.json`（`offline_cosign`、`signqr.problem_contents_mismatch`）
- テスト: `dev-tests/offline-cosign.test.ts`（実際のSDKで、ネットワーク呼び出しなしの読み取り、ハッシュ再計算、モザイク表示、連署の検証、内容のすり替え検出）

## 他のツール（symbol-cli・SDK・REST）のペイロードの読み込み
- 「署名・連署QR」（`/signqr`）と「オフライン連署」（`/offline/cosign`）で、KASANE のQR/JSONに加えて、次の形式をそのまま読み込める（貼り付け・JSONファイル・QR・画像）: 
  - 署名済みトランザクションのペイロード（16進文字列。`0x`・改行・空白・大文字小文字は不問。ターミナルの `Payload: …` の行ごと貼り付けも可）
  - ペイロードを含むJSON（`{"payload":"…"}`、`{"signedTransaction":{"payload":"…"}}`、`{"transactionPayload":"…"}`、それらの配列の先頭）
  - 連署の本文（`{"parentHash","signature","signerPublicKey","version"}`。RESTの連署のアナウンス本文）
  - 64桁のハッシュだけ（ハッシュのみの連署の依頼。内容はノードから取るので、オンラインの画面のみ）
- **種類はバイト列から判断する**: トランザクションの種類がボンデッドのアグリゲートなら連署の依頼（本体入り）、それ以外は署名済みトランザクション。ハッシュはバイト列から計算し直し、JSON内の `hash` は無視。ネットワークはネットワークバイトで判断（ペイロードにはチェーンIDが無いので、ネットワークバイトが一致すれば今のネットワークのものとみなす）。別ネットワークは拒否
- 署名のないペイロード（未署名）は、これまでどおり「署名が入っていません」で拒否。このウォレットは他ツールの未署名トランザクションに署名しない
- 対象外: ボンデッドを送るためのハッシュロックの送信（開始した人が済ませている前提）、`web+symbol://transaction?data=…`（送金フォームで読む既存の機能）
- 変更: `lib/symbol/externalPayload.ts`（新規）、`pages/signqr/SignQrPage.tsx` / `pages/offline/OfflineCosignPage.tsx`（読み込みを `parseAnyInput` に）、`i18n/messages.json`（説明文）
- テスト: `dev-tests/external-payload.test.ts`

## オフライントランザクションの画面構成（公式ウォレットのオフライン画面に合わせた）
- `/offline` は `/offline/sign` へ移動（カード3枚のハブは廃止）。プロファイル選択画面の**右上**のボタン「オフライントランザクション」から開く（プロファイルと同じタイルには並べない。枠線つきで目立たせ、スマホでは短い表示「オフライン」にしてロゴと重ならないようにした）
- 共通の枠（`pages/offline/OfflineShell.tsx`）: 上に **タブ**「転送トランザクション | トランザクションに連署」、その下に **ステップ表示**（今のステップはグラデーション、済みは ✓、これからは薄い表示）、一番下に「署名したデータを送信するには → 署名・連署QRを開く」
  - 転送トランザクション: ① トランザクションを準備 → ② QRをダウンロード
  - トランザクションに連署: ① トランザクションをインポート（QRコード / QR画像 / JSONファイル / ペイロードの貼り付け。symbol-cli のペイロードも可）→ ② 内容を確認して連署 → ③ QRをダウンロード
- 結果の画面は、ダイアログではなく画面内にQR・テキストのコピー・QR画像の保存・JSONファイルの保存を表示（`components/QrTextPanel.tsx`。`QrTextDialog` も同じ部品を使う）
- 削除: `pages/offline/OfflineHub.tsx`。変更: `OfflineSignPage.tsx` / `OfflineCosignPage.tsx` / `router.tsx` / `i18n/messages.json`（`offline_ui`）

## ホームの「QRコードのインポート」「トランザクションURIをインポート」（マルチシグ画面の「署名・連署QRを読み込む」ボタンの廃止）
- マルチシグ管理画面（`/multisig`）の「署名・連署QRを読み込む」ボタンを**廃止**。
- ホーム画面の履歴リボンの右に、リボンを2つ追加（押すと、他のリボンと同じように下に展開。Symbolのみ。閲覧用プロファイルには出さない＝署名できないため）:
  - **QRコードのインポート** — 署名・連署QR（署名済み／連署の依頼／連署済み／テンプレート）を、カメラ・QR画像・JSONファイル・貼り付けで読み込む（中身は「署名・連署QR」画面と同じ。`SignQrReader` として取り出して共通化）。署名・連署QRではないものは、アドレス／請求書のQRとして試し、読めたら「送る」を開いて入力済みにする。
  - **トランザクションURIをインポート** — `web+symbol://transaction?data=…`（送金）、`web+symbol://request?…`、アドレスを貼り付けて読み込み、「送る」を開いて送信先・モザイク・金額・メッセージを入力済みにする（送金フォームの「URIから読み込む」と同じ処理）。署名・送信は、「送る」でパスワードを入れるまで行わない。
- プロファイル選択画面右上の「オフライントランザクション」から開く「署名・連署QR」画面（`/signqr`）は、そのまま残す。
- 変更: `src/pages/top/Home.tsx`、`src/pages/top/ImportQrPanel.tsx`・`ImportUriPanel.tsx`（新規）、`src/pages/signqr/SignQrPage.tsx`（`SignQrReader`）、`src/pages/multisig/MultisigTop.tsx`、`src/store/appStore.ts`（`HomePanel`）、`src/i18n/messages.json`（`home.import_*`。`signqr.open_button` を削除、`signqr.use_signqr_screen` の案内を更新）。
- 制限: トランザクションURIは、これまでどおり**単純な送金（1種類のモザイク・暗号化なし）だけ**読み込める。それ以外のトランザクション（アグリゲートなど）のURIは「読み込めません」と出る。ビルドと実機での表示は未確認。

## 履歴：受け取りの表示と「完全」→「コンプリート」
- 原因1: 送金の受け取りかどうかを「宛先が自分のアドレスと同じ」で判定していたため、**宛先がネームスペース（エイリアス）で書かれた受け取り**が「送金」（↑、`-`）として出ていた。署名が自分以外の送金は受け取りとして扱うよう修正（履歴の一覧 `history.ts`、旧来の取引取得 `api.ts` の両方）。
- 原因2: **アグリゲート（コンプリート）で届いた受け取り**は、一覧では「アグリゲート」としか出ず、金額も向きも分からなかった。自分が署名していないアグリゲートは中のトランザクションを読み、自分宛ての送金を**モザイクごとに合計して「+金額」と↓で表示**する（CSVのモザイク欄にも入る）。読めないときは、これまでどおりの表示。
- 表示名「アグリゲート（完全）」を「アグリゲート（コンプリート）」に変更（履歴の種別・署名QR・アカウント制限の操作名）。
- 変更: `src/lib/symbol/history.ts`、`src/lib/symbol/api.ts`、`src/pages/top/SymbolHistoryPanel.tsx`、`src/i18n/messages.json`、`dev-tests/history-reception.test.ts`（`npx tsx dev-tests/history-reception.test.ts`。通信なし）。
- 制限: アグリゲート内の宛先がエイリアスの場合は、自分宛てとして数えない（解決していないため）。ビルド・テスト・実ネットワークは未確認。

## マルチレベルマルチシグ（連署者がさらにマルチシグ）
- Symbolでは、署名できるのは**普通のアカウントだけ**。連署者がマルチシグのアカウントのときは、そのアカウントの連署者たちが（そのアカウントの承認数に達するまで）署名することで承認される。アグリゲートに実際に付く連署は、階層のいちばん下の（普通の）アカウントのもの
- 階層の計算（通信なし）: `lib/symbol/multisigTree.ts`（新規）
  - `missingSignatures` … 承認に足りない署名の数。マルチシグは「承認数ぶんの、いちばん少なく済む連署者」を選んで足し、普通のアカウントは署名済みで0・未署名で1。ループや承認数が連署者数を超える設定は `Infinity`
  - `planApproval` … このウォレットが署名できるか（`eligible`。どの深さの連署者でもよい）、**ウォレットの署名だけで承認できるか（`selfSufficient`＝コンプリートで送れる）**、ほかに集める署名の数（`others`）
  - `modificationCosignatures` … 設定変更の連署の数。現在の連署者（承認に必要な分）**と**追加する連署者（全員が署名する。マルチシグを追加するときは、その連署者たちが署名する）の合計
  - `levelsBelow` / `depthAfterChange` … 階層の深さ（ネットワークの上限 `maxMultisigDepth`、通常3）。`treeRows` … 表示用の行
- 取得: `lib/symbol/multisigApi.ts`
  - `fetchCosignerGraph` … 連署者の木を下へたどって取得（同じアカウントは1回だけ）。`fetchCosignedAccounts` … このウォレットが連署しているアカウントを、**別のマルチシグ経由のものも含めて**上へたどって取得（`level` と `via`）。`fetchMaxMultisigDepth` … `/network/properties` から階層の上限（取れなければ3）
  - 署名待ち（`PartialTransaction`）に `signers`（作成者と連署者のアドレス）を追加
- 画面
  - マルチシグ管理（`/multisig`）: 自分のアカウントの連署者を**階層で表示**、「連署しているアカウント」に別のマルチシグ経由のアカウントも表示（「N階層上、◯◯を経由」）、署名待ちに**アカウントごとの承認の進み具合**（「あと◯人の署名が必要」）
  - マルチシグから送金: 経由のアカウントも選べる。コンプリートにするかボンデッドにするかと連署の数を、階層から計算（連署者が1人承認のマルチシグだけなら、ウォレットの署名1つでコンプリートになる）
  - マルチシグの設定変更: 連署者にマルチシグのアドレスを追加できる（入力欄に「マルチシグアカウントです（承認 m / n）。あと◯人の署名が必要」と表示）。**ループ**（自分が連署しているアカウントを連署者にする）と**階層の深さ超過**は、送信前にエラーにする。このウォレットが、対象アカウントの連署者かどうかも、階層をたどって判定
  - アグリゲート／メタデータ（他のアカウント）／アカウント制限: 送信元にできるアカウントと、コンプリートかボンデッドか、手数料の連署の数を、同じ階層の計算に切り替え（`resolveSigner`）
- 変更の影響: **設定変更の手数料の見積り**は、これまで「追加する連署者の数」と「現在の連署者の必要数」の大きいほうだったが、両方が署名する必要があるため**合計**に直した（手数料の上限が足りなくなる誤りを避ける）。単純な（入れ子でない）マルチシグの送金・連署・制限の動作は従来どおり
- 変更: `lib/symbol/multisigTree.ts`（新規）、`lib/symbol/multisigApi.ts`、`lib/symbol/aggregateApi.ts`、`pages/multisig/{MultisigTop,MultisigSend,MultisigConvert,parts}.tsx`、`pages/aggregate/AggregatePage.tsx`、`pages/restriction/RestrictionPage.tsx`、`i18n/messages.json`（`multisig.nested_*` ほか）
- テスト: `dev-tests/multilevel-multisig.test.ts`（`npx tsx dev-tests/multilevel-multisig.test.ts`。階層の計算、ループ、深さ、手数料の連署の数、通信をモックした階層のたどり方、署名待ちの署名者。52項目）
- 制限: 型チェック・ビルド・既存テストは通過。**実ネットワークでの動作は未確認**（入れ子の変換・連署の受理はノード側の検証による）。アカウントの階層は上下とも `maxMultisigDepth` まで。ハッシュだけの連署の依頼を読み込む画面（署名・連署QR）は、従来どおり連署者かどうかを事前には確認しない。連署者の削除だけの変更は、ネットワークでは削除の最小署名数（`minRemoval`）が適用されるが、見積りは承認数で計算している（従来どおり）

## マルチシグツリー（`/multisig/tree`、Symbolのみ）
- 名称は「マルチレベルマルチシグ」に統一（旧称「入れ子マルチシグ」）。i18nのキーは `multisig.multilevel_*`
- マルチレベルマルチシグの階層を、いちばん上のアカウント（誰にも連署されていないもの）から、実際に署名する普通のアカウントまで、折りたたみできるツリーで表示。マルチシグのアカウントには承認数・削除数・連署者数、「表示中」「このウォレット」の印、アドレスのコピー、階層数・アカウント数、このウォレットが署名できる場合は「ウォレットの署名だけで承認できる／あとN人必要」を出す
- アドレスを入れると、ほかのアカウントのツリーも見られる（見るだけ。閲覧用プロファイルでも開ける）。空にするとこのウォレットのアカウント。ループや重複は「上に出ているアカウント」と表示して、それ以上は展開しない
- 入口: マルチシグ管理画面の「マルチシグツリーを見る」と、「連署しているアカウント」の各カードの「ツリー」
- 変更: `pages/multisig/MultisigTreePage.tsx`（新規）、`router.tsx`、`pages/multisig/MultisigTop.tsx`、`i18n/messages.json`（`multisig.tree_*`）。ブラウザでの見た目は未確認（型チェックとビルドは通過）


## マルチシグツリーをトーナメント表の見た目に（`/multisig/tree`）
- 折りたたみの縦リストをやめ、**トーナメント表**にした。**左＝実際に署名する通常のアカウント**、右へ進むほど上のアカウントで、**いちばん右が最終的に承認されるアカウント**。マルチシグのアカウントは、左の連署者のうち承認数の人が署名すると承認されて右へ進む（線でつなぐ）
- 各アカウントは四角いカード: マルチシグは大きく「承認数 / 連署者数」と「N人中M人の署名で承認」「連署者の削除はK人」、通常のアカウントは「署名する人」。短縮アドレス（全体は長押し／ホバーとコピーボタン）、「表示中」「このウォレット」（緑枠）、「上に出ているアカウント」（ループ・重複は展開しない）
- このウォレットが署名できるときは、マルチシグの各カードに「✓ 承認OK」または「あとN人」を表示（ウォレットの署名を数えた `missingSignatures`）
- 各マルチシグのカードの「−」「＋」で、左の連署者を閉じる／開く（従来の折りたたみ相当。深さ4より下は最初から閉じる）
- 表が画面より広いときは、表だけが横スクロール。いちばん上のアカウントが複数あるときは、縦に並べる
- 変更: `pages/multisig/MultisigTreePage.tsx`（`TreeNode` を `Bracket` / `AccountBox` に置き換え。取得と計算は変更なし）、`i18n/messages.json`（`multisig.tree_intro` / `tree_legend` を更新、`tree_flow` / `tree_card_rule` / `tree_card_removal` / `tree_card_signer` / `tree_step_ok` / `tree_step_need` / `tree_folded` を追加。`tree_threshold` は未使用になったが残してある）
- 制限: **ビルド・型チェック・ブラウザでの見た目は未確認**（この環境では依存パッケージを入れられず、構文だけ確認）。線は枠線（border）で描いているので、実機で線のつながりとスマホでの横スクロールを確認してほしい

## 設定画面：「マルチシグ口座の取引を表示」と「未知のアドレスからの署名依頼」（Symbolのみ）
- 設定（`/settings`）のタイルに2つ追加。ライブ通知・通知音と同じく、押すたびに切り替わる（NEMでは出さない）。説明文はタイルの下に表示。保存はアプリ設定（`appStore`、端末に保存）
  - **マルチシグ口座の取引を表示**（`showMultisigHistory`、**初期値オフ**）: オンにすると、ホームの履歴（承認済み／未承認／署名待ち）に、このウォレットが連署しているマルチシグ口座（別のマルチシグ経由のものも含む。`fetchCosignedAccounts`）の取引も混ぜて新しい順に表示。その行には「マルチシグ口座 NABC…XYZ」の印。同じ取引が両方に出るときは1回だけ（ウォレット自身のものとして）。読めない口座があっても、ほかの履歴は出す
  - **未知のアドレスからの署名依頼**（`allowUnknownSigners`、**初期値「許可する」＝これまでどおり**）: 「許可しない」にすると、アドレス帳に無い送信者の署名依頼には署名できない（連署ボタンを押すとエラー表示）。署名依頼の注意書きは赤になり、「追加」でアドレス帳に入れれば署名できる。連絡先・ホワイトリスト・自分のアカウントは常に署名できる。ブラックリストは、これまでどおり確認ダイアログから続行できる
- 「署名できない」判定は、マルチシグ管理（`/multisig`）の署名待ちの連署ボタンと、署名・連署QR画面の連署ボタンの2か所（`isUnknownSignerDenied`）。オフラインで連署する画面（`/offline`）には、これまでも送信者の確認が無く、今回も付けていない
- 変更: `src/store/appStore.ts`、`src/pages/settings/SettingsTop.tsx`、`src/lib/symbol/history.ts`（`fetchHistoryPageWithMultisig`、`HistoryItem.viaAccount`）、`src/pages/top/SymbolHistoryPanel.tsx`、`src/lib/signerTrust.ts`、`src/components/SignerTrustNotice.tsx`、`src/pages/multisig/MultisigTop.tsx`、`src/pages/signqr/SignQrPage.tsx`、`src/i18n/messages.json`（`settings.multisig_history` ほか、`history.multisig_account`、`addressbook.signer_unknown_denied`）
- 制限: **ビルド・テスト・実ネットワークは未確認**（この環境では依存パッケージを入れられず、構文だけ確認）。マルチシグ口座の履歴は、その口座から見た向きで出す（口座が受け取った送金は「受け取り」。口座が送った送金は、アグリゲートの中にあるため「アグリゲート」の行になり、金額は出ない）。ページ送りは口座ごとに同じページ番号を取って混ぜるので、口座が多いと並びが多少前後することがある

## 署名依頼の危険警告（依頼の中身の判定）
- これまでの警告は、依頼を送ってきた**作成者**だけだった（アドレス帳に無い送信者の警告、要注意＝ブラックリストの送信者の警告と確認ダイアログ）。それに加えて、依頼の**中身**を調べて、署名の前に警告を出すようにした。作成者の警告は今までどおり（`SignerTrustNotice`）
- 判定（`lib/signRisk.ts`、通信なし・画面なしの純粋な関数。アドレス帳の扱いは `Trust` で受け取る）。重い順に並べ、同じ警告は1回だけ:
  - **危険（赤）**: 送金先が要注意の連絡先／連署者に追加されるアドレスが要注意の連絡先
  - **注意（黄）**: 送金先・連署者に追加されるアドレスがアドレス帳にない／送金先がネームスペース（エイリアス）で実際の宛先を確認できない／マルチシグの設定変更（連署者・承認数）／承認数・削除数を減らす変更／アカウント制限の変更／内容を読み取れないトランザクション
  - **情報（青）**: 暗号化メッセージ付きの送金（内容を確認できない）
  - 自分のアカウント、依頼の対象の口座そのもの、連絡先・ホワイトリストのアドレスは何も出さない
- 画面: 署名依頼の作成者の警告の下に、警告を並べて表示（`components/SignRiskNotice.tsx`）。**危険**があるときは、「署名に進む」を押したあと、パスワード入力の前に、警告を並べた最後の確認ダイアログ（`SignRiskDialog`）を出す。要注意の送信者のダイアログで「署名に進む」を選んだあとも、中身に危険があればもう一度出す
- 組み込み先: マルチシグ管理の署名待ち（`pages/multisig/MultisigTop.tsx`）、署名・連署QR画面の連署（`pages/signqr/SignQrPage.tsx`）。ボタンを押した瞬間の最新のアドレス帳で判定（`signerTrust.ts` の `checkSignRisks`。`checkSignerTrust` と同じ読み込みに共通化）
- 変更: `src/lib/signRisk.ts`・`src/components/SignRiskNotice.tsx`・`dev-tests/sign-risk.test.ts`（新規）、`src/lib/signerTrust.ts`、`src/pages/multisig/MultisigTop.tsx`、`src/pages/signqr/SignQrPage.tsx`、`src/i18n/messages.json`（`signrisk.*`）
- テスト: `dev-tests/sign-risk.test.ts`（`npx tsx dev-tests/sign-risk.test.ts`。24項目、通信なし。通過）。アドレス帳のテストも通過
- 制限: 画面・ビルド・実ネットワークは**未確認**（この環境では依存パッケージを入れられず、構文だけ確認）。「金額が大きい」「宛先が初めて」などの判定は入れていない（残高や過去の送金先を調べる必要があるため）。オフラインで連署する画面（`/offline`）は、これまでも作成者の警告が無く、今回も付けていない。メタデータの変更・モザイクの発行量の変更などは、種類によっては内容を読み取れず「読み取れないトランザクション」の注意になる

## ハーベスト：キーリンクの個別管理（リモート／VRF／ノード）
- ハーベスト画面（Symbol）の、押せなかった「キーリンク」タブを実装。リモート（アカウントキーリンク）・VRF・ノードの3つのキーを、**公開鍵を指定して1つずつ**リンク・解除・付け替えできる。これまでは「開始（自動生成）」と「全解除」だけだった（どちらも「デリゲートハーベスティング」タブにそのまま残してある）
- キーごとに、いまチェーンにリンクされている公開鍵（なければ「リンクなし」）と、公開鍵（64文字の16進数）の入力欄を表示:
  - **リンクなし** → 「リンク」（入力した公開鍵をリンク）。3つのうち足りないものだけを足すこともできる（途中までの設定の補完）
  - **リンク済み** → 「解除」（チェーン上のリンク中の公開鍵を解除。解除は、いまリンクされているキーを正確に指定する必要があるため、入力ではなくチェーンから読んだ値を使う）と、「付け替え」（新しい公開鍵を入力。**解除と新しいリンクを、1つのアグリゲートで**送る。リンクしたまま上書きはできないため）
  - 入力のチェック: 64文字の16進数／このアカウント自身の公開鍵は不可／いまのキーと同じは不可／ほかの種類のキーとしてリンク済みの公開鍵は不可。手数料（1つ／付け替え）を表示し、残高が足りないときはボタンを押せない
- 送信までの流れは「開始」「停止」と同じ（確認ダイアログに、リンク／解除する内容を一覧→パスワード→送信→完了）。署名の直前にチェーンのリンクを読み直し、解除の対象が変わっていたら送らずに状態を更新して知らせる
- 注意書きを画面に表示: この画面は公開鍵のリンク・解除だけで、秘密鍵は扱わない。リモート・VRFは、その秘密鍵をノードに渡さないとハーベストは始まらない（自分のノードで設定するか、「開始」で自動生成して渡す）。3つが揃っていない間はハーベストされない
- 変更: `src/lib/symbol/harvestKeys.ts`（新規。どのリンク／解除を送るかの判定。通信なし）、`src/lib/symbol/api.ts`（`changeHarvestKeys` を追加。`signHarvestLinks` を使う）、`src/pages/harvest/KeyLinkPanel.tsx`（新規）、`src/pages/harvest/HarvestSettings.tsx`（タブを有効にし、確認・パスワード・完了・エラーの流れを共通化）、`src/i18n/messages.json`（`harvest.keys_*`）
- テスト: `dev-tests/harvest-keys.test.ts`（`npx tsx dev-tests/harvest-keys.test.ts`。20項目、通信なし。通過）
- 制限: 画面・ビルド・実ネットワークは**未確認**（この環境では依存パッケージを入れられず、構文だけ確認）。**「付け替え」＝同じアグリゲートの中で解除→リンクの順に送る処理は、実際のネットワークでの受理を確認していない**（うまくいかなければ、解除してからリンクの2回に分けて送ればよい）。リンクが通っても、ノード側にその鍵の秘密鍵が無ければ実際のハーベストは始まらない。NEMのハーベストは対象外

## マルチシグアカウントの委任ハーベスト（NEM）
- NEM のハーベストに、マルチシグアカウントの委任ハーベスト（重要性転送）を追加。公式 NEM Nano Wallet の「マルチシグアカウントの委任アカウントを管理」と同じ機能。`/multisig/harvest`（マルチシグ画面の各アカウントの「委任ハーベスト」ボタン、ハーベスト画面の案内から）。リモートアカウントの有効化／無効化（マルチシグ名義の重要性転送）→ ノードを選んでハーベストの開始／停止。詳細は FEATURES.md「マルチシグアカウントの委任ハーベスト (NEM)」
- リモートアカウントの導出は NanoWallet と同じ（連署者の鍵でマルチシグのアドレスに署名した結果の後ろ32バイト）。NanoWallet で有効化したものをそのまま扱える。秘密鍵は保存せず、リモートの公開鍵だけを端末に覚える
- 署名待ちで重要性転送を「委任ハーベストの設定」と表示（連署者が中身を知って署名できる）。取引履歴でも「重要性転送」
- 変更: `src/lib/nem/multisigHarvest.ts`・`src/pages/nem/NemMultisigHarvest.tsx`・`dev-tests/nem-multisig-harvest.test.ts`（新規）、`src/lib/nem/tx.ts`（`NemMultisigInner` に `importance`）、`multisigApi.ts`、`history.ts`、`NemMultisigTop.tsx`、`NemHarvest.tsx`、`router.tsx`、`i18n/messages.json`（日・英）
- テスト: `dev-tests/nem-multisig-harvest.test.ts`（`npx tsx dev-tests/nem-multisig-harvest.test.ts`。68項目、通信なし。通過）。期待値は公式の nem-sdk で作った値: リモート鍵の導出12組（メインネット／テストネット、連署者3人、マルチシグ2つ）、マルチシグ名義の重要性転送のバイト列（有効化／無効化 × メインネット／テストネット）が一致。導出の取り違え・有効化と無効化の取り違えをわざと入れて、確実に失敗することも確認。`tsc -b`・`vite build`・既存の NEM テストも通過
- 制限: 画面は**ブラウザで動かしていない**。実際の NEM ノードでの動作（重要性転送の受理、`/account/get/forwarded` の返り方、`/account/unlock`）も**未確認**。`/account/get/forwarded` は、リモートでないアカウントを渡すと「そのアカウント自身」を返す前提（返ってきたアドレスがマルチシグ自身かどうかだけを見ている）。公式の「委任鍵の表示」は入れていない。韓国語・中国語・ロシア語は英語で表示

## マルチシグの委任ハーベスト：委任鍵の表示（NEM）
- 「マルチシグアカウントの委任ハーベスト」（`/multisig/harvest`）に、公式 NEM Nano Wallet の「委任鍵を表示」と同じ「委任鍵」タブを追加。リモートアカウントのアドレス・公開鍵と、パスワードを確認したときだけ秘密鍵を出す
- 秘密鍵は画面の状態にしか持たず、保存しない。「隠す」／約1分／別のタブへ移る／アカウントの切り替え／アプリが背面に回る／画面を離れる、のどれかで隠れる。注意書きを表示（この鍵ではXEMは送れないが、知っている人はハーベストをノードに任せられる）。詳細は FEATURES.md「委任鍵の表示」
- 変更: `src/pages/nem/NemMultisigHarvest.tsx`、`src/i18n/messages.json`（`nemmsharvest.tab_keys` など9キー、日・英）、`dev-tests/nem-multisig-harvest.test.ts`、`docs/FEATURES.md`
- テスト: `dev-tests/nem-multisig-harvest.test.ts` に、リモートの**秘密鍵**が公式 nem-sdk と一致する確認を12組分追加（80項目、通信なし、通過）。秘密鍵だけを壊した変更を入れると失敗することも確認。`tsc -b`・`vite build`・既存の NEM テストも通過
- 制限: 画面は**ブラウザで動かしていない**（隠れる条件の動作も、型とコードの確認まで）。公式の「カスタムのリモートアカウント」（有効化のとき公開鍵を自分で指定する）は未対応

## マルチシグの委任ハーベスト：リモートアカウントの公開鍵を指定する（NEM）
- 「リモートアカウントの有効化」タブに、公式 NEM Nano Wallet の「カスタムされた公開鍵を使用」と同じ機能を追加。このウォレットが作るリモートアカウントの代わりに、公開鍵（64文字の16進数）を入力して、重要性転送（有効化・無効化）を送れる。用途は、自分で用意したリモートアカウントの有効化と、**別の連署者が有効化したリモートアカウントの引き継ぎ**（その連署者の「委任鍵」タブの公開鍵を入れて無効化 → 状態が「未設定」に戻ったら自分で有効化）。詳細は FEATURES.md「リモートアカウントの公開鍵を指定する」
- 無効化は、入力した公開鍵が有効なリモートアカウントかを NIS に確認でき（送る直前にも確認）、確認できたときだけ押せる。公開鍵だけなので、KASANE からそのアカウントでのハーベストの開始・停止はできない（ダイアログと説明に明記）。「別の連署者が有効化したもの」の案内文も、公開鍵の指定を案内する内容に更新
- 変更: `src/lib/nem/multisigHarvest.ts`（`checkNemCustomRemoteKey`、`planNemCustomRemote`）、`src/pages/nem/NemMultisigHarvest.tsx`、`src/i18n/messages.json`（`nemmsharvest.custom_*` など13キーと、`not_activator_note` の更新。日・英）、`dev-tests/nem-multisig-harvest.test.ts`、`docs/FEATURES.md`
- テスト: `dev-tests/nem-multisig-harvest.test.ts` に、公開鍵を指定した重要性転送のバイト列が公式 nem-sdk と一致する確認（有効化／無効化 × メインネット／テストネット、公式の入力例の公開鍵）、入力の検査、送れるものの判定を追加（109項目、通信なし、通過）。判定をわざと壊すと失敗することも確認。`tsc -b`・`vite build`・既存の NEM テストも通過
- 制限: 画面は**ブラウザで動かしていない**。実際の NEM ノードでの動作も未確認（公開鍵を指定した重要性転送の受理、無効化前の `/account/get/forwarded` の確認）。有効化のときの「その公開鍵のアカウントを使ってよいか」は KASANE では調べず、ネットワークの判断に任せる

## 「QRコードのインポート」をホームから設定へ移動／リンク集の修正
- **QRコードのインポート**: ホーム画面（Symbol）のリボンを**やめて**、**設定 > QRコードのインポート**（`/settings/import-qr`）に移した。中身は同じ（署名・連署QR＝署名済み／連署の依頼／連署済み／テンプレートを、カメラ・QR画像・JSONファイル・貼り付けで読み込む。アドレス・請求書のQRも読める）。Symbol のみ。閲覧用プロファイルと Ledger プロファイルでは、設定にも出ない（署名できないため。これまでのホームのリボンと同じ条件）。
  - アドレス・請求書のQRを読み込んだときは、これまでは同じ画面の「送る」が開いたが、今は**ホーム（`/top`）へ移って「送る」を開く**（入力済み）。
  - 「署名・連署用のQRです。…から読み込んでください」の案内文を、「設定の『QRコードのインポート』」に直した（5言語）。
  - 変更: `src/pages/top/Home.tsx`（リボンと展開部分を削除）、`src/store/appStore.ts`（`HomePanel` から `'import_qr'` を削除）、`src/pages/top/ImportQrPanel.tsx` → `src/pages/settings/ImportQrPanel.tsx`（移動。読み込んだ後に `/top` へ）、`src/pages/settings/ImportQrPage.tsx`（新規）、`src/pages/settings/SettingsTop.tsx`（タイルを追加）、`src/router.tsx`、`src/i18n/*`（`settings.import_qr_caption` / `settings.import_qr_hint`、`signqr.use_signqr_screen`）。
- **NEM テストネットの XEM のファウセット**を `https://testnet.nem.tools` に変更（これまでは公式フォーラムの記事）。ラベルも「公式フォーラム」をやめて「NEM テストネット ファウセット」に（5言語）。
- **Symbol のリンクから「Everyday Symbol」を削除**（リンクと、翻訳 `guide.link_everyday`）。マイリンクで自分で追加したものは、そのまま。
- 変更: `src/lib/links.ts`、`dev-tests/links.test.ts`（新規。`npx tsx dev-tests/links.test.ts`。通信なし、10項目、通過）。
- 制限: 画面は**ブラウザで動かしていない**。ビルド（`npm run build`）も未確認（この環境では依存パッケージを入れられないため、構文と翻訳キーの確認まで）。

## 履歴の「署名待ち」: Symbol も連署先のマルチシグ口座の分を常に含める
- ホームの履歴の「署名待ち」タブは、NEM と同じく、設定「マルチシグ口座の取引を表示」がオフでも、このウォレットが連署しているマルチシグ口座（別のマルチシグ経由のものを含む）の署名待ちを出す。これまでの Symbol は、設定をオンにしたときだけ出していた（オフでは自分のアドレスの署名待ちだけ）
- 「承認済み」「未承認」のタブは変えない（設定オンのときだけ口座の分を混ぜる）。設定の説明文も、この違いが分かる文に直した（日本語・英語。ほかの言語は元のまま）
- 変更: `src/pages/top/SymbolHistoryPanel.tsx`（`status === 'partial'` でも連署先の口座を調べる）、`src/i18n/messages.json`（`settings.multisig_history_hint`）
- 制限: ビルド・実ネットワークは未確認。連署先の口座は最初の読み込みで1回だけ調べて使い回す（読めなかったときは自分の分だけを出す）

## NEM の効果音：承認されたときに「ブロードキャスト時の音」が鳴り直す不具合を修正
- 症状: NEM で取引を出すと、出したときに `ding`（ブロードキャスト時）が1回鳴る。承認されると、`ding` がもう一度鳴ってから `ding2`（承認時）が鳴っていた。承認後は `ding2` だけが鳴るのが正しい
- 原因: 「承認前」を見逃した取引に `ding` を先に出す処理（v136）で、取引が同じかどうかをハッシュ1つで見ていた。承認前の一覧と承認済みの一覧では、同じ取引でもハッシュの入る場所が違う（`meta.data` / `meta.hash.data`）ため、出した取引が承認されたときに「承認前を見ていない新しい取引」と間違えられていた
- 修正: 取引の署名（どの一覧でも同じ）と、`meta` のハッシュ（`meta.hash.data` / `meta.data` / `meta.innerHash.data`）のどれかが一致すれば同じ取引として扱う（`liveIds`）。承認前を知らせた取引は、承認のときに `ding` が鳴らず `ding2` だけ。承認前を一度も見ていない取引（別の画面で受け取った着金など）は、これまでどおり `ding` → `ding2` の2回
- テスト: `dev-tests/nem-live-socket.test.ts` に、別のハッシュの形で承認された場合・マルチシグの場合を追加
- 変更: `src/lib/nem/liveReporter.ts`、`src/lib/nem/live.ts`、`docs/FEATURES.md`
- 制限: ビルド・実ネットワークは未確認。ハッシュの入り方は実際のノードの答えで確かめていないので、署名とハッシュのどれかで照合する形にしてある

## マイリンク：「置き場所」を「追加する場所」に変更／選択肢の並びを変更
- 追加・編集ダイアログの項目名を「置き場所」から「追加する場所」に変更（説明文も「追加する場所を、両方、Symbolのみ、NEMのみから選べます」に）。選択肢の並びは「両方」「Symbolのみ」「NEMのみ」。初期値はこれまでどおり、いま選んでいるチェーン
- 英語の項目名も「Add to」に変更。韓国語・中国語・ロシア語は元のまま
- 変更: `src/lib/customLinks.ts`（`LINK_SCOPES` の並び）、`src/i18n/messages.json`、`docs/FEATURES.md`
- 制限: 画面は**ブラウザで動かしていない**。ビルドも未確認

## Home のリボンの並びを変更（NEM・Symbol 共通）
- 左から「保有モザイク」「履歴」「送る」「インボイス」「ネットワーク統計」の順に変更（これまでは保有モザイク、インボイス、送る、履歴の順）。NEM と Symbol で同じ並び
- NEM には「ネットワーク統計」がないため、最後の位置には従来どおり「アポスティーユ」が入る。閲覧用プロファイルでは「送る」が出ないのは変わらない
- 変更: `src/pages/top/Home.tsx`
- 制限: 画面は**ブラウザで動かしていない**。ビルドも未確認

## 送金の数量 0 を拒否しない（NEM・Symbol 共通）／NEMonster の「invalid quantity for nem:xem」を修正
- 症状: NEMonster で「捕まえる」を押すと「処理に失敗しました。invalid quantity for nem:xem」と出て、捕まえられなかった。捕まえる処理は「自分専用の受け口アドレスへの 0 XEM の送金」なのに、送金処理が数量 0 を弾いていた
- 修正: 通常の送金・モザイク送金でも数量 0 を拒否しないようにした（NEM も Symbol も）。マイナスと、空欄・形式の誤りは、これまでどおり拒否
  - NEM: `normalizeNemTransferMosaics` の検査を「0 以下」から「マイナス」だけに（`src/lib/nem/tx.ts`）。NEMonster 専用に入れていた `allowZeroAmount` は不要になったので削除
  - 送る画面（NEM・Symbol）: 「次へ」を押せる条件と、送信時の検査から「数量が 0 より大きい」を外した（`src/pages/top/SendForm.tsx`、`src/pages/send/SendConfirmation.tsx`）。手数料の見積りは、数量が 0 のときも 0 のまま計算（空欄のときだけ 1 として見積る）
  - アグリゲート・QR の読み込みなど、送る画面以外の検査は変えていない
- テスト: `dev-tests/nem-mosaic-transfer.test.ts` の「数量 0 は拒否」を「数量 0 は許可（モザイク・0 XEM とも）、マイナスは拒否」に変更
- 変更: `src/lib/nem/tx.ts`、`src/lib/nem/api.ts`、`src/lib/nem/nemonster.ts`、`src/pages/top/SendForm.tsx`、`src/pages/send/SendConfirmation.tsx`、`dev-tests/nem-mosaic-transfer.test.ts`
- 制限: 画面は**ブラウザで動かしていない**。ビルドも未確認。数量 0 の送金を実際のノードが受理するかは未確認（NEM は 0 XEM を受理する前提。Symbol のモザイク 0 の転送はネットワーク側の判断に任せる）
