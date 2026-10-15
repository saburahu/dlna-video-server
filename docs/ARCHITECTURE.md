# 構成

`src/server.ts`がHTTP/UPnPと管理画面を統合し、`store`が通常TS、`media-catalog-index`/`folder-index`がSQLiteと複数ルート階層を扱います。走査とBrowseは全編解析から分離します。

source inspection → client identity → implementation fingerprint → capability evidence → PlaybackDecision → transform plan → executor → HTTP deliveryという境界を維持します。クライアント名や単一User-Agentを再生能力と同一視しません。

JITはCPU software encodeで、AVCと独立PCR MPEG-2のtargetが別です。最大2枠、セッション/世代ごとのSeek置換、cancel/cleanup、共有analysis cacheを持ちます。Direct PlayはJIT admissionを使用しません。

PCR work coordinatorが再生/Seekを優先し、backgroundの索引作成は原則1本です。SQLiteから待ち状態を再構築し、ソース削除は成功した走査と猶予/再確認で扱います。NAS失敗やroot解除を即削除とみなしません。

アプリ本体、data、logs、録画は分離します。Windows wrapperはruntime/FFmpegの確認、オフラインbackup/import、ログオン自動起動だけを担当し、再生エンジンを別実装しません。管理APIのlocalhost境界はDLNAのLAN配信とは分離しています。
