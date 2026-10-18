# 複数音声の扱い

[README](../README.md) ／ [対応実績](COMPATIBILITY.md) ／ [既知の問題](KNOWN-ISSUES.md)

このページの限定2音声JITは**mainの次回配布候補**です。既存v0.2.3のRelease ZIPには
含まれません。全動画・全受信機を2音声にする機能ではありません。

## Direct PlayとJIT

VLC等へのDirect Playでは元ファイルを変更せずHTTP配信するため、元の音声トラックを
保持します。トラックの選択・復号はクライアント側の機能です。3音声以上が入っていても、
それがJITで3音声変換できるという意味ではありません。

テレビ向けJITでは、入力条件と**検証した受信機個体の明示的許可**が一致するときだけ
音声2本を独立したAAC PIDとして変換します。初期状態では許可を登録せず、従来の
第1音声のみです。機種名、IP、User-Agentだけでは有効化しません。

## 限定条件

すべて「映像1本・音声ちょうど2本」、個別時計・開始終端・decoder条件の検査が必要です。

| コンテナと映像 | 音声 | 主な制限 |
|---|---|---|
| ASF、WMV3 Main、SD、約23.976fps | WMA Pro×2 またはWMA v2×2 | 48kHz stereo、同種codec、許容範囲の開始・終端 |
| AVI、H.264 High、progressive、SD、約23.976fps | MP3×2 | 48kHz stereo、yuv420p、検証したtime baseと終端 |
| MP4、H.264 High、progressive、約23.976fps | AAC LC×2 | 48kHz stereo、yuv420p、最大1920×1080、対応する開始・終端 |
| MKV、HEVC Main、frame sequence | AAC LC×2 | 48kHz stereo、yuv420p、最大1920×1080、0<fps<=61に加えて従来JIT条件と開始・終端の検査 |

拡張子とcodec名だけでは判断しません。フルレンジの`yuvj420p`、異なるcodec混在、
多channel、fps不明、3音声以上などはこの条件に含めません。条件外／未許可は1音声へ
戻し、理由を診断ログの`DUAL_AUDIO_SELECTION`へ記録します。第1音声自体が実行不能なら
再生を許可するとは限りません。音声なしや字幕保持にも別の制限があります。

WMV3/WMA Proは入力側にも`automaticClients.wmaInputs=source-clock-v2`の明示選択が
必要です。配布既定の入力policyは自動で拡大しません。この選択もWMA Lossless、WMA v1、
VC-1との未検証構成を許可するものではなく、自然EOF成功の保証ではありません。

## 設定と実績

現時点では2音声許可を登録する専用Web UIはありません。高度な設定としてデータ領域の
`experimental-catalog/jit.json`に任意の`dualAudioPermissions`を保持する仕組みです。
設定項目は `version=jit-dual-audio-permission-v1`、`enabled`、`deviceId`、`sinkHash`、
`implementationFingerprint`、`targetProfile`、検証根拠を記した`reference`です。
空配列／項目なしが初期状態で、ほかの利用者の設定・UDNをコピーしてはいけません。
稼働中のファイル手編集は推奨しません。未検証機器へ試験を強制する手順は提供しません。

登録は過去の許可にすぎず、再生時には現在の受信機能力・identityとBrowseで発行した
URLを再確認します。別機器のURL流用や、一覧取得後の音声構成変更は拒否します。
両音声の独立時計、64ms終端検査、PCR/TTS、2本同時上限を維持します。

開発時にはZP2（AVC）とDBR-T1010（独立PCR MPEG-2）で限定WMV・AVI・MKV・MP4の
代表素材の音声切替・位置維持・Seekに成功しています。長尺MKV/MP4は両方式でPCの
全編HTTP自然EOFを確認しました。実機の全編確認は素材・要求経路ごとに範囲が異なり、
全候補ファイルの成功や新Public ZIPそのものの実機成功を意味しません。

## 未対応・未解決

特殊な組み合わせへの対応拡張は現段階で区切ります。3音声JITや全codec対応を約束しません。
WMA自然EOFの時刻不整合と、一部MP4によるDBR-T1010の復帰不能事象は未解決です。
そのMP4は1音声fallbackで問題が出ており、2音声化すれば直るという根拠はありません。
詳しくは[既知の問題](KNOWN-ISSUES.md)を確認してください。
