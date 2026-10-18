# 動作実績と制限

[README](../README.md) ／ [症状別の確認](TROUBLESHOOTING.md)

以下は特定の素材・環境での実績であり、メーカーの対応保証や全ファイルの再生保証ではありません。入力拡張子、実codec、端末が受信する出力形式は別です。

## 再生方式

| 利用先 | 基本方式 | 注意 |
|---|---|---|
| 根拠が十分なIntel系要求のREGZAクライアント | AVC + AACのJIT、192-byte TTS | ブランド名やIntel表記だけでは許可しません。 |
| 検証済みDBR-T1010型の要求実装 | MPEG-2 video + AAC、独立PCR PIDのJIT、192-byte TTS | 一般のDiXiM機器や全DBRへ適用するものではありません。 |
| VLC | 元ファイルのHTTP Direct Playを優先 | 端末側のdecoder対応が必要。JIT枠を消費しません。 |
| 通常の非保護放送TS | 通常TSの配信経路・PCR索引によるTimeSeek | 初回索引の状態と端末の一覧キャッシュに注意。 |

MP4／MKV／AVI／WMV／ASFは、実codecとストリームを検査し、既存JITで妥当な変換ができる素材を公開します。ASFという拡張子全般の実機確認ではありません。[限定2音声JIT](MULTI-AUDIO.md)は個体別許可と入力条件が必要で、既定は1音声です。多重映像・全音声・字幕をすべて保持するJITではなく、VLC Direct Playでは元ファイルのトラックを保持しやすい方式です。DRM解除機能はありません。破損・暗号化・未対応codecは除外やエラーとなります。

代表的な入力はH.264／HEVC／MPEG-2／MPEG-4／WMV映像、AAC／MP3／WMA音声です。これらの名前だけで全profile・全組み合わせに対応するとは判断しません。音声なし、特殊な複数stream、字幕、アニメーションWebP等には機器別の制限があります。通常TSは192-byte TTS／Content Packet／PCR pacingの既存経路、VLC Direct Playはbyte Rangeを使い、根拠のない時間→byte変換は行いません。

JIT同時実行は最大2本です。CPUソフトウェア変換を使い、GPUは必須ではありません。高解像度／重い入力で常に2本の速度を保証するものではありません。

## 機器別の実機記録

| 機器 | 確認できた主な内容 | 留意点 |
|---|---|---|
| REGZA ZP2 | AVC JITのMP4／HEVC MKV、通常TS、TimeSeek。AVI／WMV等の開発時実績あり | 成功済み条件を維持。すべてのcodec・字幕・音声構成の保証ではありません。 |
| REGZA 55X9900R | AVC JITのMP4／HEVC MKV、対象AVIの補正付き再生と5回のTimeSeek | msmpeg4v3・SD・約23.976fps AVIの帯状破綻には個体別29.97fps補正の実績。初期状態では無効。 |
| REGZA 49Z700X | AVC JITのMP4／HEVC MKV、AVI／WMVの再生、自動判定でのMP4再生 | 各形式・各Seek方法の網羅的な実機確認ではありません。 |
| REGZA DBR-4KZ600 | AVC JITのMP4／HEVC MKV | DiXiMサービスもありますが、実際の要求はIntel系。DBR-T1010と別系統。Seekの個別詳細は独立した記録なし。 |
| REGZA DBR-T1010 | 独立PCR MPEG-2 JITのMP4／HEVC MKV、単発・連続Seek、AVI／WMV、通常TSと約2分へのSeek | AVCや任意のMPEG-2で受信できるとは限りません。過去のMPEG-2 PS診断はフリーズし、無効化を維持。 |
| iPad版VLC | 一覧とDirect Playの実機成功 | 形式別Seekの詳細、全codec・全OS版は未検証。iPhone／macOS版VLCの実機確認は未取得。 |

49Z700XとDBR-T1010で同時再生の実績があります。同時Seek・停止の全組み合わせを各実機で網羅した保証ではありません。

## v0.2.0のruntime検証範囲

配布版はNode.js 24.22.0同梱、FFmpeg／ffprobe 8.1.2別配置で検証しています。**新runtimeで実機再確認した範囲は、ZP2・55X9900R・DBR-T1010の各MP4／HEVC MKV代表2素材の映像・音声再生です。** 上表の過去実績すべてを新runtimeで再検証したわけではありません。全機種・全機能・全編・同時再生・すべてのSeekの再認証ではありません。

従来の開発時記録は主にNode.js 26／FFmpeg 7.1.1です。旧版の利用を推奨するものではありません。新runtimeで確認した27件のJIT要求はunderrun 0、サーバーエラー0でした。49Z700X／DBR-4KZ600／VLCの新runtime実機試験は未取得です。

PC自動検証では合成素材の配信、decode、Seek、終了・cleanup、2本同時JITを確認しています。PCで復号可能なことと実機で再生できることは区別しています。[今回の導入検証](ONBOARDING_VALIDATION.md)も参照してください。

## 共通の制限

- 管理画面・管理APIはサーバーPCのlocalhostからのみ利用できます。
- 未知・矛盾したfingerprintでは不適切なJIT resourceを出しません。以前の個別登録は安全な条件でのfallbackであり、一般配布へ個体情報を埋め込みません。
- 通常TSの索引が未生成の一覧を端末が保持すると、タイムバーやSeekが有効にならない場合があります。索引完成後に停止・一覧再取得・再生を試します。
- 端末のフリーズや再起動が起きたら、同じ試験を繰り返さずログを確認してください。

## 次回配布候補の実績と未解決事項

ZP2とDBR-T1010の代表WMV・AVI・MKV・MP4で限定2音声の切替・位置維持・Seekに成功しています。MKV/MP4は両JITでPC全編HTTP自然EOFを確認。実機では代表MKVの先頭からのEOFと、代表MP4の再GET後18秒からのEOFを区別します。全候補ファイル、新Public ZIP、全個体への保証ではありません。

WMA自然EOFの終端不整合と、一部MP4によるDBRの黒画面・待機表示・復帰不能は未解決です。極末尾Seekの新規索引・事前判定は未採用。[既知の問題](KNOWN-ISSUES.md)を確認し、問題素材のDBR再試験は繰り返さないでください。
