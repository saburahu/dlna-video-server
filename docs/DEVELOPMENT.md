# 開発・公開更新

Node 24 LTS以上、FFmpeg/ffprobe、Gitを用意し、この公開用ツリー内で `npm ci` を実行します。アプリ本体の依存はlockfileに固定します。`npm run typecheck`、`npm test`、`npm run build`を実行し、合成fixtureだけで回帰を確認してください。FFmpegがない場合にskipするテストがあるため、公開前は `PT3_FFMPEG`/`PT3_FFPROBE`を指定してskipの有無も確認します。

`npm run audit:public` はpublication-manifest.jsonの明示リストと機密パターンを検査します。新しい公開ファイルを追加する場合、レビュー後にリストへ追加します。検査のためにログや実録画をsourceへコピーしないでください。

## Windows Node-only ZIP

```text
node packaging/build.mjs --node <公式Node24.22.0のnode.exe> --node-license <同じ公式ZIPのLICENSE> --output <新しい配布ディレクトリ>
```

Node SHA256はpackaging/node-runtime-lock.jsonで確認します。FFmpeg/ffprobeはビルダー入力にも配布ZIPにも含めません。`PT3_TEST_FFMPEG_DIR` に別配置のbinを設定し、`node packaging/verify.mjs <配布ディレクトリ>`で隔離HTTP・Direct Play・通常TS・設定移行・管理制限を検証します。検証ポート19204が空いていることを事前確認してください。実機へ再生要求を送る処理はありません。

`node tools/verify-synthetic.mjs --concurrency` は `npm run build` の成果物を使い、テストパターンのMP4/HEVC MKV/AVI/WMVから実FFmpeg/HTTPを通してAVC/MPEG-2、Seek、停止、Direct同時利用、JIT2枠を検証します。ユーザーの録画・実際の個体情報を使いません。出力は新しい一時ディレクトリに保持します。通常視聴とCPU負荷が重ならないときに実行してください。

ZIPはpackaging/archive.ps1で作成し、全内容を再展開してmanifestのSHA256と照合します。PowerShellはその子プロセスだけExecutionPolicy Bypassを使い、永続ポリシーを変更しません。配布物とSHA256SUMS.txt、更新手順、公開Gitのソースコミット、テスト結果をReleaseへ添付する計画です。公開Releaseは明示的な配布指示があるときだけ作り、通常のpushで生成するCIはありません。

## 非公開の開発元から安全に更新する

1. 開発元では実機検証済みの変更を確定する。開発元のGit履歴・.git・remoteを公開側へコピー/merge/forkしない。
2. publication-manifest.jsonの対象ソース/テストを1ファイルずつ比較し、必要な変更だけを新しいreview用ディレクトリへ取り出す。ディレクトリの丸ごとコピーや診断用Markdownの一括投入をしない。
3. 個体設定を含むdefaults、実録画名、IP/UDN/username/絶対パス、GitHub内部URL、認証情報を検査・匿名化し、合成fixtureへ置き換える。管理loopback境界、FFmpeg別配置など公開側の差分を維持する。
4. 独立した公開用依存・runtimeで型チェック/全テスト/ビルド/実HTTP検証を行い、差分と監査結果を確認する。公開用Gitへ公開可能な内容だけを新しいコミットとして残す。
5. `git rev-parse --show-toplevel`とremoteを確認する。公開用の独立リポジトリ以外なら操作を中止する。初回には `node tools/install-push-guard.mjs` で未承認pushと想定外remoteを拒否するローカルhookを設置できる。
6. 実際のPublic作成・初回push・Release発行はオーナーの承認後。ローカルhookのapproval markerは人が承認した後にだけ作る。hookは迂回可能なので秘密情報検査や人の確認の代わりではない。

開発バックアップ用Releaseと公開配布Releaseは、リポジトリもタグも別に扱います。公開版のコミットに開発元の個人名やメールを使用せず、公開用のGit identityを設定します。

## CI

必要に応じWindows runnerでnpm ci/typecheck/test/build/auditを実行します。FFmpegを使わないskip試験だけで再生互換性を保証しません。録画・catalog・診断ログをCIへ渡さず、CIのartifact uploadも既定で行いません。現候補には自動Release workflowはありません。

## 限定2音声の合成HTTP回帰

`npm run verify:dual-audio` はbuild後に実行します。`PT3_FFMPEG` と `PT3_FFPROBE` を別配置の実行ファイルへ指定してください。テストパターンと440/880Hzの2音声MP4/MKVだけを新しい一時領域へ生成し、AVC/MPEG-2、全編短尺EOF、途中Seek、個体未許可の1音声fallback、PID/PMT/PCR/TTS、独立時計、停止とcleanupを確認します。SSDP広告・TV再生命令・実データの参照は行わず、結果は一時領域へ保持します。実機成功の代わりにはしません。
