# PT3録画DLNAサーバー

家庭内LANのテレビ・レコーダー・VLCへ、PC上の録画・動画ファイルを配信するWindows向けUPnP/DLNA MediaServerです。初回公開版はv0.2.0です。[Windows配布版と更新情報](https://github.com/saburahu/pt3-recording-server/releases/latest)を参照してください。

このサーバー自身には録画・チューナー制御機能はありません。利用権限のある平文メディアだけを扱ってください。DRM、DTCP-IP、放送の暗号化を解除する機能はありません。

## できること

- 「録画番組 → すべて / フォルダ別」。複数保存ルートを独立した階層として表示し、SQLiteで増分管理します。
- 通常TSを配信し、PCR索引によるTimeSeekを提供。アイドル時の索引事前生成、元ファイルの確実な削除に連動した安全なキャッシュ清掃。
- 対応するMP4/MKV/AVI/WMV/ASFをオンデマンド変換。通信fingerprintに応じAVC JITまたは独立PCR PIDのMPEG-2 JITを選択。最大2本まで独立して再生・Seek・停止できます。
- VLC等の対応候補には、元ファイルのHTTP Direct Playとbyte Rangeを優先します。未判定クライアントへの無条件な再生保証はしません。
- ローカル管理画面で保存先、サーバー名、クライアントごとの限定AVI互換性補正などを設定できます。

## 必要な環境

Windows 10/11 x64。更新されたWindowsと、家庭内の信頼できるPrivateネットワークを使用してください。単独1080p JITは近年の4～6コアCPU・8GiB以上を目安とし、2本同時は6コア以上・16GiB以上を推奨しますが、入力解像度・codec・CPUにより異なります。CPUソフトウェア変換を使い、NVIDIA GPUは不要です。

公開版のPC検証環境はNode.js 24.22.0 LTS、FFmpeg/ffprobe 8.1.2 Windows x64です。**Node.jsはポータブルZIPへ同梱しますが、FFmpeg/ffprobeは同梱しません。** [GyanのWindowsビルド](https://www.gyan.dev/ffmpeg/builds/)から現行essentials/full buildを別途入手し、Setupでbinフォルダを指定してください。古い7.1.1は受け付けません。バージョン下限を満たすことは脆弱性がない証明ではなく、入手元の更新情報を確認してください。

## Windowsで使う

1. 正式公開後のWindowsポータブルZIPを新しいローカルフォルダへ展開します。録画・NAS・dataフォルダへアプリを展開しないでください。
2. FFmpegを別途展開し、ffmpeg.exeとffprobe.exeがある同じbinフォルダを用意します。
3. Setup.cmdを実行します。独立したローカルのデータ保存先、LAN側IPv4、表示名、録画フォルダ、FFmpegのbinを指定します。Node/npm/TypeScriptの手動導入は不要です。
4. Windowsファイアウォールで同梱runtime/node.exeを**Privateネットワークだけ**許可します。既定TCP 19090とSSDPのUDP 1900を使用します。
5. Start.cmdで起動し、**サーバーPC自身の** `http://localhost:19090` を開きます。管理画面/APIは既定でlocalhost限定です。現版にはLAN管理を有効化する設定がなく、別PC・テレビから管理画面は開けません。サーバーPC上のブラウザで設定してください。将来の認証付きLAN管理は未実装です。
6. テレビ等のDLNA一覧から指定したサーバー名を開き、「録画番組」を選びます。

NASの録画はログオンユーザーのアクセス権を使います。設定・SQLite・PCRキャッシュはローカルディスクへ保存します。任意のログオン時自動起動は用意していますが、ログオン前のWindowsサービスではありません。

録画フォルダは通常60秒ごとに軽いstat走査で更新します。Browseは全編PCR解析を待ちません。初回の索引生成にはディスク速度に応じた時間がかかり、索引なしで取得した一覧を機器が保持しているとシークバーが出ない場合があります。生成後に停止・一覧再取得・再生を行ってください。索引の進捗と一時停止は管理画面から確認できます。

## 再生互換性

[対応状況と制限](docs/COMPATIBILITY.md)を参照してください。開発版でREGZA ZP2/55X9900R/49Z700X/DBR-4KZ600、DBR-T1010、iPad版VLCの代表素材を人が確認していますが、全機種・全ファイルの保証ではありません。新runtimeはPrivate版の隔離検証を先に実施し、ZP2/55X9900R/DBR-T1010で代表MP4/HEVC MKVの再生を確認しています。ほかの機器や全編・同時実機再生はPC検証と区別して記録します。

## 更新・バックアップ・削除

再生停止 → Stop.cmd → Backup.cmd → 新版を別アプリフォルダへ展開 → Setup.cmdで同じdataを選択します。設定・UDN・catalog・既存PCRキャッシュを保持します。同じdataやUDNで旧新版を同時起動しないでください。[詳細とロールバック](docs/UPDATE.md)。

削除はStop.cmd、Remove-autostart.cmdの後でアプリフォルダを削除します。録画・data・バックアップは自動削除しません。

## 困ったとき

- FFmpegがない/古い: Setupでbinを再指定し、Diagnose.cmdを実行します。ffmpeg/ffprobeは同じビルドのものを使用してください。
- テレビで見えない: Privateファイアウォール、LAN IPv4、同じLAN/SSID、AP isolationやmulticast遮断を確認。VPN・ゲストネットワークでは未検証です。
- busy: JIT枠は最大2本です。3本目は既存再生を止めずに拒否します。Direct Playや通常TSはJIT枠を消費しません。
- ログ: data/logsと管理画面の診断を確認してください。ログは録画タイトル・パス・IP・UDNを含みます。GitHubや第三者へ添付する前に内容を確認・匿名化してください。自動アップロードはありません。[セキュリティ](docs/SECURITY.md)。

**インターネットへポートを開放したり、管理画面をリバースプロキシで公開しないでください。** DLNAメディア閲覧はLAN内の信頼できる端末向けで、利用者ごとの認証やTLSはありません。

## ソースから開発する

更新済みNode.js 24 LTS以上とFFmpeg/ffprobeを別途用意し、`npm ci` → `npm run typecheck` → `npm test` → `npm run build`。`PT3_DATA_DIR`/`PT3_LOG_DIR`で独立したローカルdata/logを指定し、`PT3_FFMPEG`/`PT3_FFPROBE`で実行ファイルを指定して `npm start`。録画や実行時データはGitへ追加しません。[構築と公開更新手順](docs/DEVELOPMENT.md)。

## ライセンス

本体は[MIT License](LICENSE)、著作権者表記は `saburahu` です。第三者ソフトウェアにはそれぞれ固有のライセンスが適用されます。[監査と配布方針](docs/LICENSE_POLICY.md)、[第三者ライセンス](third-party/README.md)を参照してください。
