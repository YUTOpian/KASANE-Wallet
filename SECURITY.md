# セキュリティポリシー / Security Policy

KASANE Wallet は、ニーモニックや秘密鍵を扱うウォレットです。脆弱性は、**公開の Issue ではなく非公開で**報告してください。

## 報告のしかた

GitHub の **Security → Report a vulnerability**（Private vulnerability reporting）から報告してください。
（リポジトリの Settings → Code security で「Private vulnerability reporting」を有効にしておく必要があります）

書いてほしいこと:

- 影響（何が盗まれる・壊れる・誤送金につながるか）
- 再現手順、対象のバージョンまたはコミット
- 可能なら、修正案

実際の秘密鍵・ニーモニックは送らないでください（テストネットの使い捨てアカウントで再現してください）。

## 対象

| バージョン | サポート |
|---|---|
| `main` の最新 / 最新のリリース | ✅ |
| それ以前 | ❌ |

## 利用者へ

- 公開版（GitHub Pages）や配布した HTML は、**入手元とチェックサム**を確かめて使ってください。リリースには `SHA256SUMS.txt` が付きます。
- 本アプリは個人開発で、無保証です（[LICENSE](LICENSE)）。多額の資産は、ハードウェアウォレット（Ledger）の利用をおすすめします。
