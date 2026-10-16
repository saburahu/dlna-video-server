# DLNA Video Server

Windows PC上の録画・動画を、家庭内LANのテレビ・レコーダー・VLCで見るためのソフトウェアです。**サーバー自体に録画・チューナー制御機能はありません。** 適法に利用できる平文メディアを扱い、DRM・DTCP-IP・放送の暗号化を解除する機能は提供しません。

**[最新版のダウンロード](https://github.com/saburahu/pt3-recording-server/releases/latest)** → AssetsのWindows ZIPを選びます。`Source code (zip)` は利用者向け配布版ではありません。

## できること・必要なもの

- TS、MP4、MKV、AVI、WMV／ASFなどを「録画番組 → すべて／フォルダ別」から参照。保存先は複数登録でき、サブフォルダも探索します。
- REGZA等には必要に応じて再生時に変換し、VLCには可能な範囲で元ファイルをそのまま配信します。変換は最大2本同時。対応可否は実際のcodec・機器で変わります。
- 新規導入では全対応メディアを30分ごとに差分更新。手動再スキャンは待ち時間なく開始できます。既存の保存済み間隔は保持します。詳しくは[メディアスキャン](docs/MEDIA-SCAN.md)。TSのPCR索引は空き時間に準備します。
- 配布対象はWindows 10／11 **x64**。今回の導入試験はWindows 11で、Windows 10のクリーンVM試験は未実施です。
- Node.jsは同梱済み。Git・npm・TypeScriptの導入は不要です。**FFmpegとffprobeは別途必要**です。CPUで変換し、NVIDIA GPUは不要です。

## 初回再生まで

1. Windows ZIPをダウンロードし、**すべて展開**します。ZIP内から直接実行しないでください。
2. [FFmpeg導入ガイド](docs/FFMPEG.md)に従い、`ffmpeg.exe` と `ffprobe.exe` のある **binフォルダ**を用意します。v0.2.0で実機確認した版は8.1.2です。最新版という意味ではありません。
3. `Setup.cmd` を開き、録画フォルダとFFmpegのbin等を入力します。[入力項目ごとの説明](docs/SETUP.md)を参照してください。
4. Setupは最後にサーバーを起動し、管理画面を開きます。**起動済みならStart.cmdを重ねて実行する必要はありません。** Windows FirewallはPrivateネットワークだけ許可します。
5. テレビ等で指定したサーバー名 →「録画番組」→「すべて」または「フォルダ別」→ 動画を選びます。

管理画面は**サーバーPC自身の** `http://localhost:19090`（ポート変更時はその番号）です。**別PCからの管理は現版ではできません。** DLNAで動画を見る機器は別PC・テレビでも構いません。認証付きLAN管理は未実装です。

v0.2.3では端末探索失敗後の自動復旧を改善しました。v0.2.0 ZIPやRelease添付の初期文書より、このWeb版の手順を優先してください。v0.2.2は全メディア再スキャンと状態表示を改善し、新規導入の自動間隔を30分にした版です。保存済み間隔・再生方式・runtimeは維持します。v0.2.1のSetup終了コード修正も含みます。[変更履歴](CHANGELOG.md)

## 動作実績と困ったとき

[機器・形式・Seekの確認範囲](docs/COMPATIBILITY.md)に、REGZA ZP2、55X9900R、49Z700X、DBR-T1010、DBR-4KZ600、iPad版VLCの実績を記載しています。全機種・全ファイルの対応保証ではありません。新runtimeでの実機確認は3台・各代表MP4／HEVC MKVで、全機能の再検証ではありません。

| 症状 | 最初に見るページ |
|---|---|
| テレビにサーバー／番組が見えない | [接続・一覧](docs/TROUBLESHOOTING.md#サーバーが見つからない) |
| 再生できない・黒画面・無音・AVIが崩れる | [再生](docs/TROUBLESHOOTING.md#選択すると再生できませんになる) |
| 開始が遅い・タイムバーなし・Seek不可 | [PCR索引とSeek](docs/TROUBLESHOOTING.md#pcr索引とseek) |
| FFmpegが認識されない | [FFmpegの確認](docs/FFMPEG.md#認識されないとき) |
| 更新・移行・削除をしたい | [バックアップと更新](docs/UPDATE.md) |
| 不具合を報告したい | [ログの採り方](docs/LOGS.md) → [Issues](https://github.com/saburahu/pt3-recording-server/issues/new/choose) |

**信頼できる家庭内LAN専用です。インターネットへポートを開放しないでください。** メディア閲覧に利用者別認証やTLSはありません。[セキュリティ](docs/SECURITY.md)

本体は[MIT License](LICENSE)、Copyright (c) 2026 saburahu。[第三者ライセンス](third-party/README.md)。開発する方は[開発・ビルド手順](docs/DEVELOPMENT.md)を参照してください。


v0.2.3の端末探索復旧については[詳しい説明](docs/CLIENT-DISCOVERY.md)を参照してください。既存の設定・UDN・catalog・PCR索引は保持します。

名称変更前からの更新と内部名称の維持については [名称変更・互換性](docs/BRANDING.md) を参照してください。
