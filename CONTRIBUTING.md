# 開発への参加

## 準備

Node.js 22.12 以上（`.nvmrc` は 22）。

```bash
git clone <このリポジトリ>
cd KASANE-Wallet
npm ci
npm run dev        # 開発サーバー
```

## コマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー（Vite） |
| `npm run lint` | oxlint |
| `npm run typecheck` | 型チェック（`tsc -b`） |
| `npm test` | `dev-tests/*.test.ts` をすべて実行 |
| `npm test -- links nem-dao` | 名前に一致するテストだけ実行 |
| `npm run build` | 型チェック＋本番ビルド（`dist/index.html` 1 ファイル） |
| `npm run check` | lint → test → build（プルリクの前に） |

## テストの書き方

- 置き場所: `dev-tests/<名前>.test.ts`。単体で `npx tsx dev-tests/<名前>.test.ts` として動く。
- 失敗があれば `process.exit(1)` で終わる（`npm test` はこの終了コードで判定する）。既存のテストの書き方に合わせる。
- 鍵・署名・暗号まわりを変えたら、必ずテストを足す。

## ブランチとコミット

- `main` に直接 push せず、ブランチ → プルリクエスト。`main` に入ると GitHub Pages に自動で公開される。
- ブランチ名の例: `feat/nem-harvest`、`fix/balance-lag`、`docs/readme`
- コミットメッセージは [Conventional Commits](https://www.conventionalcommits.org/ja/) をおすすめ: `feat: …` / `fix: …` / `docs: …` / `refactor: …` / `test: …` / `chore: …`

## リリース

```bash
npm version 1.2.3          # package.json を更新して v1.2.3 のタグを作る
git push --follow-tags     # タグを push すると Release が自動で作られる
```

## 秘密情報

ニーモニック・秘密鍵・パスワード・`.env` は、コミットしない・Issue やログに貼らない。
