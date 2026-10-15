# 互換性と検証範囲

開発版の人による代表素材試験では以下を確認しています。個体UDNや録画タイトル・ログは公開資料へ持ち込みません。

| 機器 | 開発版の方式・結果 |
|---|---|
| REGZA ZP2、55X9900R、49Z700X、DBR-4KZ600 | Intel系の複合fingerprintからAVC JIT、代表MP4/HEVC MKV成功 |
| REGZA DBR-T1010 | 専用DiXiM系要求特徴から独立PCR PIDのMPEG-2 JIT、MP4/MKV・連続Seek成功 |
| iPad版VLC | 対応元ファイルのDirect Play成功 |
| iPhone/macOS版VLC、他機器 | 同じ方式の候補だが実機未確認 |

従来の成功記録はFFmpeg 7.1.1/Node 26です。新しいNode 24.22.0 LTS/FFmpeg 8.1.2は、公開用変更と分離した開発版の最小修正でPC検証した後、ZP2/55X9900R/DBR-T1010の3台でMP4/HEVC MKVの再生成功を人が確認しました。計27件のJIT要求はunderrun 0、サーバーエラー0でした。新runtimeでの49Z700X/DBR-4KZ600/VLCの実機、全編自然終了、実機同時再生は未確認であり、従来の結果から保証しません。旧FFmpegを推奨するものではありません。

Intel/DiXiMという名前だけで再生能力を保証しません。実際のBrowse/HTTP要求とサービス構造、identity binding、compatibility evidenceを使い、曖昧な場合は誤ったJIT resourceを公開しません。旧個別許可は安全なfallbackですが、配布版のdefaultsに個体許可はありません。

対応可能な入力は実際のcontainer/codec/stream構成とdecoderで判断します。代表的なH.264/HEVC/MPEG-2/MPEG-4/WMV・AAC/MP3/WMA等を扱いますが、DRMや破損・未対応codecは無条件に再生可能とは扱いません。WMVの音声終端、タイムスタンプ量子化、インターレース、画角は既存の根拠付きplan/validatorで扱います。

一部の低解像度msmpeg4v3・約23.976fps AVIで、55X9900Rの低fps AVC復号が破綻する開発時の観測があります。管理画面で対象クライアント個体に限った29.97fps CFR補正を指定できます。初期状態は無効で、ほかの機器や一般のMP4/MKVへ無条件に適用しません。

通常TSは元データを変更せず192-byte TTS/Content Packet/PCR pacing/TimeSeekを利用します。VLC Direct Playはbyte Rangeのみで、時間→byte変換は捏造しません。未判定クライアント・音声なし・特殊な複数stream・字幕・アニメーションWebPには機器別の制限があります。

過去のMPEG-2 PS試験は再公開しません。固定診断用resourceはdefaultsに含めません。配信の成功と、全機種のDLNA規格完全適合は別です。
