# FFmpeg／ffprobeの準備

[導入手順へ戻る](SETUP.md)

FFmpegは動画の検査・変換、ffprobeは形式やcodec情報の取得に使います。**両方が必要です。** Windows ZIPにはNode.jsだけが同梱され、FFmpeg／ffprobeは含まれません。

## 入手先とバージョン

[FFmpeg公式のダウンロード案内](https://ffmpeg.org/download.html#build-windows)にはWindowsビルドの提供元として[Gyan](https://www.gyan.dev/ffmpeg/builds/)が掲載されています。FFmpeg公式がexeを直接配布しているという意味ではありません。広告のダウンロードボタンや無関係な配布サイトを使わないでください。

v0.2.0でPC検証とREGZA 3台・各2素材の実機再生確認を行ったのは **Gyan 8.1.2 essentials build** です。[8.1.2の配布ページ](https://github.com/GyanD/codexffmpeg/releases/tag/8.1.2)のAssetsから `ffmpeg-8.1.2-essentials_build.zip` を選ぶと、その構成を再現できます。`Source code` はexeを含みません。ZIPを選べばWindowsの「すべて展開」を使えます。

**8.1.2は動作確認版であり、最新版・脆弱性がない版という意味ではありません。** 配布元の更新・[セキュリティ情報](https://ffmpeg.org/security.html)も確認してください。新しい版や別提供元のビルドを使う場合、Setupの検査を通っても再生互換性は未検証です。今回の文書更新でruntimeを別版へ変更していません。7.1.1はSetupで拒否されます。

## 展開してbinを選ぶ

1. FFmpegのZIPをアプリや録画とは別のローカルフォルダへすべて展開します。
2. 展開した `ffmpeg-8.1.2-essentials_build` → `bin` を開きます。
3. 同じフォルダに `ffmpeg.exe` と `ffprobe.exe` があることを確認します。拡張子を隠す設定では `ffmpeg`／`ffprobe` と見える場合があります。
4. エクスプローラーのbinのアドレス欄を選び、表示されたフルパスをコピーします。
5. Setupの `FFmpeg bin directory` に貼り付けます。

例えば実際に次のように配置した場合、指定するのは最後のbinまでです。

```text
C:\Tools\ffmpeg-8.1.2-essentials_build\bin
  ffmpeg.exe
  ffprobe.exe
```

`ffmpeg.exe` 自体、ZIP、binの一段上のフォルダを指定しないでください。パスの前後に引用符を付けず、環境変数表記も直接入力しません。PATHへの登録や、Node.jsの別インストールは不要です。

ファイルをZIP配布物の `runtime` へ上書きしないでください。FFmpegの配置を後で移動したら、再生停止→Stop.cmd→Setup.cmdで新しいbinを指定します。起動中の再設定は拒否されます。

## 認識されないとき

| エラー・状況 | 確認すること |
|---|---|
| FFmpeg/ffprobeがない・Configure FFmpeg first | ZIPを展開したか、両exeがあるbinを選んだか。引用符付きのパスを貼っていないか。 |
| 同じビルドから配置してください | ffmpegとffprobeを別々の配布元・バージョンから混ぜていないか。ペアで置き直す。 |
| 古い／未判定のFFmpeg | 実際のバージョンと提供元を確認。検証済み8.1.2との違いを記録する。 |
| Required encoder missing | 本アプリに必要なlibx264、mpeg2video、aacを含むビルドか。バージョン番号だけでは判断できません。 |
| Stop this data directory before setup/import/backup | FFmpegの不足ではなく、指定dataでサーバーが動いている状態。先にStop.cmd。 |

`Diagnose.cmd` は配置・同梱Node・必要encoder・SQLite等を点検します。詳しいFFmpegの版を確認する場合は、**FFmpegのbinフォルダ**でPowerShellを開きます。

```powershell
.\ffmpeg.exe -version | Select-Object -First 1
.\ffprobe.exe -version | Select-Object -First 1
```

PowerShellでは先頭の `.\` を省略しないでください。現在フォルダのexeを名前だけでは実行しません。不具合報告には版の最初の行を記載してください。
