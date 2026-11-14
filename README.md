# KASANE Wallet

[![Deploy](https://github.com/YUTOpian/KASANE-Wallet/actions/workflows/deploy.yml/badge.svg)](https://github.com/YUTOpian/KASANE-Wallet/actions/workflows/deploy.yml)
[![CodeQL](https://github.com/YUTOpian/KASANE-Wallet/actions/workflows/codeql.yml/badge.svg)](https://github.com/YUTOpian/KASANE-Wallet/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Symbol** と **NEM** に対応したブラウザウォレット。ビルドすると **HTML 1 ファイル**になり、サーバーなしで（ダブルクリックでも、GitHub Pages でも）動きます。

> ⚠️ 個人開発のソフトウェアで、無保証です。ニーモニック・秘密鍵の扱いには十分注意してください。脆弱性の報告は [SECURITY.md](SECURITY.md) へ。

**公開版:** `https://YUTOpian.github.io/KASANE-Wallet/`

## 特長

- Symbol / NEM（メインネット・テストネット、mijin）を 1 つのアプリで
- 秘密鍵・SSS Extension・Ledger・閲覧用（アドレスのみ）の 4 種類のプロファイル
- オフライントランザクション（署名済みトランザクションを QR にして、あとで読み込んで発行）
- マルチシグ / アグリゲート（CSV 一括）/ ハーベスト / 投票 / DAO / DNS / アポスティーユ
- コンソール（コードを入力してウォレットを操作）
- テーマ・5 言語
- ビルド成果物は `dist/index.html` 1 ファイル。CSP は、ビルド時にインライン script の SHA-256 ハッシュ方式へ差し替え

機能の一覧は [docs/FEATURES.md](docs/FEATURES.md)、変更履歴は [docs/CHANGELOG.md](docs/CHANGELOG.md)。

## はじめる

必要なもの: Node.js 22.12 以上（`.nvmrc` は 22）

```bash
npm ci
npm run dev       # 開発サーバー
npm run build     # dist/index.html を作る
npm run preview   # ビルド結果を確認
```

`dist/index.html` は、ダブルクリックで開いてもそのまま動きます（`file://` 対応）。

## 開発

| コマンド | 内容 |
|---|---|
| `npm run lint` | oxlint |
| `npm run typecheck` | 型チェック（`tsc -b`） |
| `npm test` | `dev-tests/*.test.ts` をすべて実行（`npm test -- links` で絞り込み） |
| `npm run check` | lint → test → build |

参加のしかたは [CONTRIBUTING.md](CONTRIBUTING.md)。

## CI/CD

| ワークフロー | きっかけ | やること |
|---|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | プルリクエスト | lint / test / build、CSP とビルド成果物の検査、成果物をアーティファクトに保存（SHA-256 付き） |
| [`deploy.yml`](.github/workflows/deploy.yml) | `main` への push | CI を通したうえで GitHub Pages に公開 |
| [`release.yml`](.github/workflows/release.yml) | タグ `v*.*.*` の push | CI を通したうえで Release を作成し、`kasane-wallet-<tag>.html` と `SHA256SUMS.txt` を添付 |
| [`codeql.yml`](.github/workflows/codeql.yml) | PR / `main` / 毎週 | CodeQL による静的解析 |
| [`dependabot.yml`](.github/dependabot.yml) | 毎週 | npm と GitHub Actions の更新プルリクエスト |

### GitHub Pages を有効にする（最初の 1 回だけ）

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
2. `main` に push する（または Actions タブで `Deploy` を手動実行）
3. 公開先は `https://<ユーザー名>.github.io/<リポジトリ名>/`

ルーティングは HashRouter、`base` は `./` なので、サブパスで公開しても追加設定は要りません。

### リリースを出す

```bash
npm version 1.0.0          # package.json を更新し、v1.0.0 のタグを作る
git push --follow-tags     # Release が自動で作られる
```

### `main` を守る（おすすめ）

**Settings → Branches（または Rulesets）** で `main` に、プルリクエスト必須と、必須チェック（`Lint` / `Test` / `Build`）を設定します。

## ライセンス

[MIT License](LICENSE) © 2026 YUTO
