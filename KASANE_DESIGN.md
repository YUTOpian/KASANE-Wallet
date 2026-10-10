# KASANE デザイン統一 (v12)

全画面を KASANE デザインに統一しました。Symbol / NEM のどちらを選んでいるかで、同じ KASANE デザインの「色味」だけが変わります。

| | Symbol | NEM |
|---|---|---|
| グラデーション | coral → pink → lavender | lavender → aqua → mint |
| ステージ背景 | くすんだ紫グレー (#2B262D) | くすんだ青緑グレー (#232A29) |
| アクセント(ダーク) | pink #E58AAE | aqua #7ED1C0 |

共通: 文字は KASANE ワードマークの淡い黄緑、グラデーション上の文字はインク色 (#262129)、細い字のタイトル、丸いボタン。

## 仕組み
- `src/theme/kasaneTheme.ts` … `createKasaneTheme(mode, chain)` が全画面のテーマ。`useTheme().kasane` で、グラデーション・ステージ背景・メニュー色などのトークンを取れる。
- `src/main.tsx` … ストアの `themeMode`(ダーク/ライト)と `chain` からテーマを作る。
- `src/theme/designScope.ts` … 画面グループごとにデザインを**固定**する。welcome → プロファイル → 新規作成/インポート → ニーモニック表示 → 完了、およびプロファイル設定・バックアップ・パスワード入力の画面は、常にダーク＋ロゴ全体のグラデーション（coral→pink→lavender→aqua→mint）の**中立の配色**で、Symbol / NEM どちらの色味も付かない（保存済みチェーン・テーマ設定・タイルの選択に影響されない）。それ以外は、Symbol 画面は常に Symbol 色、NEM 画面は常に NEM 色（サイドメニューで選んだチェーンで決まる）。ダーク/ライトの設定が効くのは Symbol / NEM 画面のみ。
- `KasaneStage` … メニューなし画面の枠。上記の固定ルールに従う。
- 旧 `raccoonTheme.ts` と `lib/chainColors.ts` は廃止。

## 動作の変更点
- 初期のテーマは「ダーク」(KASANE本来の見た目)。保存済みの旧データも、更新後の最初の起動で一度だけダークに切り替わる(その後は設定 > テーマの選択が保たれる)。
- ライトテーマも KASANE の配色（淡いクリーム/ミントのステージ）で用意。
- インポート / ログイン系の画面(名前・完了・パスワード必須)も KASANE の枠に変更。
- 「エクスプローラーで見る」などのボタンは、個別の色指定をやめて KASANE グラデーションのボタンに統一。

NEMonster の絵(`nemonster.css`)と紙ウォレットの出力(`paperWallet.ts`)は、作品・印刷物なのでそのまま。
