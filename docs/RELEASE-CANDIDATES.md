# Private / Public 同期候補の検証

製品SemVerは両版とも0.4.1です。ビルドSHAは異なって構いません。
PublicはNodeのみ同梱し、FFmpeg／ffprobeは別途指定します。Privateの
個別設定・許可や研究用Python経路をPublicへ持ち込みません。

`packaging/release-sync.mjs`へ両ソースと両展開済み配布物を指定すると、
package・アプリ・manifest・Release Notesのバージョン、edition、既定許可、
runtime方式と共通再生コードを照合します。不一致なら終了コードは非ゼロです。
`--for-publication`は公開承認待ちフラグも拒否します。タグやReleaseは作成しません。

Public管理画面のlocalhost制限と公開root外へのアクセス拒否を維持しています。
許可機構の詳細は[限定入力と2音声](SCOPED-INPUT.md)、再生保証の限界と
自然EOFの既知事項はRelease Notesを参照してください。

配布テストは`DLNA_TEST_INSTALL_ROOT`以下のedition別`current`／`alternate`
へ固定展開します。node.exeの場所を毎回変えず、停止・所有確認・再展開と
毎回異なるdataで初期化条件を作ります。同じHTTP試験ポートのためパッケージ
smoke試験は直列に実行します。SSDPは無効です。稼働中・不明なプロセスや
テスト領域外のdataがあれば拒否し、既存プロセスは終了しません。

この方式は開発試験だけのものです。利用者のインストール先、自動起動、
ファイアウォール等のセキュリティ設定は変更しません。警告の自動クリックや
広い例外規則は使用しません。

追加の再生回帰監査により以前の候補合格判定は撤回しました。[受信機能力と素材例外](DUAL-AUDIO-CAPABILITY.md)を参照してください。公開判定には実SHAへ結びつけた --compatibility-evidence の必須ケースを追加し、欠落・失敗を拒否します。
