# Windowsで初回再生するまで

[READMEへ戻る](../README.md) ／ [FFmpeg](FFMPEG.md) ／ [困ったとき](TROUBLESHOOTING.md)

## 1. 配布ZIPを取得して展開

[Releasesの最新版](https://github.com/saburahu/pt3-recording-server/releases/latest)のAssetsから `PT3-Recording-Server-…-win-x64.zip` と `SHA256SUMS.txt` を取得します。GitHubの緑色のCodeボタンや `Source code (zip)` ではなく、Windows用ZIPを選びます。

必要ならダウンロード先でPowerShellを開き、v0.2.1では次でSHA-256を確認します。別の版では実際のファイル名へ置き換え、結果を同じReleaseのSHA256SUMS.txtと照合します。

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\PT3-Recording-Server-0.2.1-win-x64.zip'
```

エクスプローラーで「すべて展開」し、書き込み可能なローカルフォルダへ置きます。アプリを録画フォルダ・dataフォルダ・NAS・書込み制限のあるProgram Filesへ置かないでください。展開先には `Setup.cmd`、`Start.cmd`、`runtime`、`app` が見えます。

Node.jsは同梱済みです。別途Node.js、Git、npm、開発ツールを入れる必要はありません。FFmpeg／ffprobeは[別途準備](FFMPEG.md)します。

## 2. Setup.cmdへ入力

`Setup.cmd` を開きます。**録画・変換中の既存データを設定する場合は、先に全端末の再生を停止し、旧アプリのStop.cmdで停止してください。** 新規導入で旧環境がなければ停止操作は不要です。

表示は英語ですが、入力する意味は次のとおりです。

| 表示される項目 | 初めて使う場合の入力 |
|---|---|
| Data directory | 通常はEnter。表示されたローカルの保存先を使います。既定は `%LOCALAPPDATA%\PT3 Recording Server`。録画そのものではなく設定・catalog・PCR索引等の保存先です。 |
| HTTP port [19090] | 通常はEnter。ほかのDMSと同じPCで並行利用する場合は空いている1024～65535の番号に変更します。 |
| LAN IPv4 address | 通常はEnterで自動選択。複数NIC・VPNがある場合は、表示された一覧からテレビと同じLANのIPv4を入力します。テレビのIPではありません。 |
| FFmpeg bin directory | `ffmpeg.exe` と `ffprobe.exe` があるbinフォルダのフルパス。[選び方](FFMPEG.md)。 |
| Import stopped old PC data directory | **新規導入ならEnter**。録画フォルダをここへ入れないでください。既存環境の復元・移行専用です。 |
| Recording folders separated by \| | 録画の保存先。例 `D:\Recordings`。複数なら半角の縦棒で区切ります（下の例）。実際には自分の存在するフォルダを指定します。 |
| Server name shown on TV | テレビで区別できる名前。Enterなら既存名またはPC名を使います。 |
| Library refresh interval in seconds | 新規導入ではEnterで30分（1800秒）。既存の保存済み間隔は保持。必要なら30～86400秒。 |
| Start automatically at this user logon? | 自動起動したい場合は `y`。初回確認だけなら `n` またはEnter。Windowsログオン後の自動起動であり、ログオン前のサービスではありません。 |

複数録画フォルダの入力例（区切りの前後に空白を入れません）：

```text
D:\Recordings|E:\Videos
```

**パス入力欄には引用符を付けず、エクスプローラーのアドレス欄からコピーした実際のフルパスを入力します。** `%LOCALAPPDATA%` などの環境変数表記は、Setup入力欄では自動展開されません。既定値を使う場合はEnterを押してください。

設定済みデータではImport／Recording foldersの質問は出ません。録画フォルダの追加・修正は管理画面「設定」の「録画フォルダー（1行1件）」から行えます。Setupを再実行する際、ポートやLANアドレスを変更済みならその値を入力してください。

## 3. 起動と管理画面

通常のSetupは最後に起動し、ブラウザを開きます。`Started: http://localhost:…` が表示されていれば、**Start.cmdをもう一度開く必要はありません**。v0.2.0の同梱文書で別途Startを案内していても、起動済みなら省略してください。

Windows Firewallの確認が出た場合、同梱の `runtime\node.exe` に対して、信頼できる**プライベートネットワークだけ**を許可します。標準ではTCP 19090とSSDPのUDP 1900を使います。組織・管理PCで変更できない場合は管理者に確認し、ファイアウォール全体を無効化しないでください。

ブラウザが開かなくても、サーバーPCで `http://localhost:19090` を開ければ確認できます。ポートを変えた場合はその番号です。現版はlocalhost管理限定なので、別PCからサーバーのLANアドレスを指定しても管理できません。

管理画面「設定」で録画フォルダを確認し、「番組一覧」の「全メディアを再スキャン」でTS・MP4・MKV・AVI・WMV・ASFとサブフォルダを更新します。ダッシュボードに総数・内訳・探索/codec解析の状態を表示します。表はTS番組情報用です。その他動画はDLNAの「すべて／フォルダ別」で参照します。[探索完了と再生準備完了の違い](MEDIA-SCAN.md)も確認してください。

NAS上の録画は、サーバーを起動したWindowsユーザーに読み取り権限が必要です。設定・SQLite・PCR索引はローカルディスクへ保存します。元録画は変更しません。

## 4. テレビ・VLCで選ぶ

テレビ等を同じLANにつなぎ、ホームネットワーク／DLNA／ネットワークメディア等のメニューで指定したサーバー名を探します。メニュー名は機器によって異なります。

「録画番組」→「すべて」または「フォルダ別」→ 動画を選択します。VLCではネットワーク内のUPnP/DLNAサーバー一覧から同じ階層を開きます。サーバーの管理画面をテレビから開く操作ではありません。

まず短く再生して映像・音声を確認し、停止・再開を試してください。TSでタイムバーが出ない場合は、PCR索引の準備と機器の一覧キャッシュを[確認](TROUBLESHOOTING.md#pcr索引とseek)します。再生できる形式・方式は[動作実績](COMPATIBILITY.md)を参照してください。

Windowsの警告やSetupのエラーが出たら、そのまま何度もStartを重ねず、[症状別ガイド](TROUBLESHOOTING.md)を確認してください。端末がフリーズ・再起動したら同じ再生を繰り返さず、[ログ](LOGS.md)を保存します。
