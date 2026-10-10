# ペーパーウォレット

Symbol 公式デスクトップウォレット（1.2.0）にあるペーパーウォレットと同じ内容を、**KASANE デザイン**の PDF（A4・1枚）で作ってダウンロードできます。
PDF はすべて端末の中で作られます（アップロードも保存もしません）。

## どこから作れるか
| 画面 | 内容 |
|---|---|
| ニーモニック生成直後（`/wallet/creation/mnemonic`） | リカバリーフレーズのペーパーウォレット |
| 設定 → バックアップ（リカバリーフレーズ表示） | 同上 |
| ウォレット設定 → バックアップ（秘密鍵表示） | その口座の秘密鍵のペーパーウォレット |

ボタンは、フレーズ／秘密鍵を画面に表示できた後にだけ出ます。

## 載る内容
| | Symbol | NEM |
|---|---|---|
| フレーズ（12/24語、番号付き） | ○ | ○ |
| 秘密のQR | フレーズ QR（type 5）／ 秘密鍵 QR（type 2） | なし（NEM に標準の QR 規格がないため） |
| 公開QR | コンタクト QR（type 1：名前＋公開鍵） | NEM アドレス QR（v2 / type 1） |
| アドレス・公開鍵・ネットワーク・導出パス | ○ | ○ |

- Symbol の QR は公式ライブラリ（symbol-qr-library、公式デスクトップウォレット 1.2.0 同梱版）の JSON 形式（`v:3`、`type`、`network_id`、`chain_id`、`data`）に合わせています。暗号化はしていません（公式のペーパーウォレットと同じ）。
- フレーズのシートは、いま選んでいるチェーン（Symbol / NEM）のルートアカウント（インデックス 0）の情報を載せます。
- ネットワーク（メインネット／テストネット）はヘッダーのバッジに出ます。

## 作り方（公式との違い）
公式は PDF テンプレートに文字を重ねる方式ですが、KASANE ではテンプレートなしで、`pdf-lib` で直接描いています。

- 文字は PDF 標準フォント（Helvetica / Courier）だけを使うので、フォントの同梱が要りません（載る文字はすべて ASCII）。
- ロゴ（ヘキサゴンと五重塔）は `src/assets/kasane_mark.png`（アプリ内の SVG と同じ絵を PNG にしたもの）、ワードマークはベクターで描画。
- QR は `qrcode.react` の `QRCodeCanvas` を画面外に描いて PNG にして埋め込みます。描けていない（真っ白）場合は、白い QR を印刷してしまわないよう、エラーにして止めます。
- iOS（特にホーム画面アプリ）では `<a download>` が効かないため、共有シート（Web Share API）で渡します。

## ファイル
- `src/lib/paperWallet.ts` … PDF のレイアウト（純粋関数。アプリの状態に依存しない）
- `src/lib/paperWalletExport.ts` … 鍵の導出、QR の中身と画像化、ダウンロード
- `src/components/PaperWalletButton.tsx` … ボタン（作成中表示・失敗表示つき）
- `src/pages/wallet/WalletCreationMnemonic.tsx` / `WalletBackup.tsx` … ボタンの設置
- `src/i18n/messages.json` … `wallet.paper_wallet_*`（日本語・英語）
- `src/assets/kasane_mark.png` … ロゴ
- `dev-tests/paper-wallet.test.ts` … 単体テスト（`npx tsx dev-tests/paper-wallet.test.ts`）

## 依存の追加
`package.json` に `pdf-lib`（^1.17.1）を追加しました。**`npm install` を一度実行してください**（`package-lock.json` はまだ更新していません）。

## 未対応
- KASANE 自身のインポート画面で、ペーパーウォレットのフレーズ QR を読み取る機能（いまは 24 語の手入力、または Symbol 公式ウォレットで読み取り）。
- QR のパスワード暗号化。
- 複数インデックスのアカウントをまとめて印刷すること（いまはルート＝インデックス 0 と、画面に出ている 1 口座分）。
