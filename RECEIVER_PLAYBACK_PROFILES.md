# 受信機の互換再生プロファイル

製品版数は0.4.1のまま。未公開の検証ブランチ用設計・実装記録。
正式Releaseおよび既存稼働サーバーへの適用は保留する。

## 通常機能と例外の分離

通常のCFR・AAC 2音声を、個体UDNや素材fingerprintの手動登録で開放する方式から分離した。
個体アドレス・UDNは現在のHTTP要求元との結合・URL bindingに引き続き使用するが、
特定値との一致を一般機能の開放条件にしない。素材fingerprintも更新検出とキャッシュ検証のために使う。
既存の手動許可・無効化・素材固有のCFR必須例外は優先する。

## 分類根拠と限界

現行のIntel UPnP実装分類は、CFRが必要だった代表機とVFRで成功した代表機で共通だった。
そのfingerprint、メーカー名、型番文字列、User-Agentだけでは区別できない。
機種世代・パネル・SoC・製造系統を推定で確定しない。以下はサービス構成に基づく
**経験的な互換性推定**であり、別型番のテレビでの成功証明ではない。

| プロファイル | 必須の現在情報 | WMV3 / H.264 AVI | AAC 2音声 |
|---|---|---|---|
| regza-intel-server-cfr-v1 | Toshiba/TVS REGZA系manufacturer、テレビ製品種別、Intel stackとCM URL構造、MediaServerのみ、ContentDirectory + CM、実GetProtocolInfoのSinkが空 | 適格なSD入力を既存29.97fps CFRで出力 | 適格な組合せに自動適用 |
| regza-intel-renderer-vfr-v1 | 同上のvendor/TV製品種別/stack構造、MediaRendererのみ、AVTransport + RenderingControl + CM、実SinkにAVC_TS_JP_AAC_T | 通常VFRを維持 | 適格な組合せに自動適用 |
| その他・矛盾・情報不足 | 上記のいずれにも合致しない | 従来経路・既存例外を維持 | 新しい自動許可は付けない |

MediaServerのSource広告を受信能力のSinkとして流用しない。空Sink自体はcodec対応の証拠ではない。
同一要求元の現UPnP endpointと実HTTP stackの一致、既存の自動JIT recipe検証も別途必須。
複数endpoint・要求実装の矛盾は従来どおり拒否する。モデル名は分類入力として使用しない。
同じメーカーでも異なる実装、混在したサービス構成、未知クライアントは自動拡張しない。

この分類は誤推定の可能性を持つ。別型番に自動候補を提示できることと、その機種の実機成功は分ける。
実機で得た新しい反証はプロファイル条件の訂正、または明示的個体例外へ反映する。

## 動画側の条件

自動CFRはAVCの既存legacy-jp-observed target、現在のclient bindingがある場合に限定する。
最大720×576、8bit yuv420p、単一映像、23.976fps近傍の既知nominal rate、48kHz stereoの1～2音声を第一範囲とする。
WMV3 Main/ASF + WMA v2/Pro、H.264 High/progressive AVI + MP3、msmpeg4v3/progressive AVI + MP3を区別する。
不明なavg_frame_rate=0/0はnominal r_frame_rateを使い、既知の矛盾するrateを上書きしない。
インターレースなど範囲外入力には自動CFR対応を主張しない。

2音声は既存selectDualAudioのコンテナ・codec・rate・layout・timebase・stream構成・decoder確認を毎回実行する。
既存のMP4/H.264 + AAC-LC、MKV/HEVC + AAC-LCの適格性判定も再利用する。
映像変換の判定と音声能力の判定は独立しており、CFRを選んだだけでは2音声にならない。

WMA Pro入力はさらに独立した制限である。通常配布既定source-clock-v1から全WMA Proを開放しない。
研究用PCM時計・Python・音声索引を追加しない。安全な一般的EOF契約が未完成のため、
WMA Pro一般対応完了とは表現しない。明示的な入力例外は残し、既知の自然EOF制限と64ms監査を維持する。

## CFRで異常を隠さないための監査

既存fps=30000/1001:round=nearと3003tick出力監査を再利用する。
入力のpresentation時刻を詰めず、音声処理を変更しない。CFRと推定source-clock再構成は同時に使わない。
自動CFRではfpsより前のshowinfoを監査し、連番・progressive・PTS欠落/重複/逆行・2秒以上のgapを検出する。
したがって未知の長時間gapをCFR複製で埋めて合格にはしない。
出力の2秒監査、64ms音声監査、TS監査は変更しない。

画質と時間軸は別評価とする。concealing/corrupt decoded frameは画質警告として件数を記録し、
自動的に正常画素と認定しない。エラー隠蔽後も出力frameがあることと、原映像の完全性は同義ではない。
明確なdecode failureは次の復号frameへ対応付け、実際に保持するpresentation範囲内なら拒否する。
Seek要求時刻を最初の復号frame時刻に置換しない。復号用プリロールと保持対象を区別する。
隠蔽警告を一律に拒否すると既存Seekを退行させるため、警告だけで時間軸欠落を断定しない。

## 例外の優先順位と更新

1. 現在の要求元/endpoint/recipeの安全判定。
2. 関連する明示的な個体・素材例外、無効化、重複・破損・stale記録。
3. 矛盾がなければ一般互換プロファイルと入力適格性。
4. 不適格・未分類なら既存fallback/拒否。暗黙のWMA時計変更はしない。

既存設定ファイルの破壊的移行や既存許可の削除は不要。
起動後の現在情報からprofileを再取得し、profile変更は自動URL bindingへ反映する。
GET/runtimeでも再取得してBrowse時との一致を確認する。

## 検証と未検証

複数の合成別型番・別UDN、同型番で異なる技術構成、別メーカー、情報不足、未知target、MPEG-2 target、
不適格入力、明示的無効化、stale素材例外、CFR依存を自動テストする。
実CM readerからのprofile生成もloopbackのXML/SOAPで検証する。
Private/Publicは同じ共通ソース差分と合成fixtureを使用し、Publicへ個体許可を同梱しない。
PublicのFFmpeg/ffprobe非同梱方式は変更しない。

新しい機種での実機再生・音声切替・Seekは未確認。
PC上のCFR/2音声HTTP成功をテレビ成功に数えない。既存の研究用長尺異常の拒否条件も解除しない。

## 今回のPC検証（2026-10-26）

- Private: 型チェック・ビルド成功。Node/Windows契約 594件中593成功、1件既存条件付きskip、失敗0。
- Public: 型チェック・ビルド成功。538件中537成功、1件既存条件付きskip、失敗0。
- 別型番・未登録個体の模擬CFRプロファイル: 4素材10有限区間。2音声/CFRの個体・素材登録ゼロ。
- 別型番・未登録個体の模擬VFRプロファイル: 6素材16有限区間。ZP2相当のVFRを維持。
- WMA Proを含む上記試験だけ、別管理の明示的な診断用入力例外を使用。一般の入力許可とは数えない。
- Public実ビルド・Public初期jit設定のまま: WMA v2/WMVおよびMP3/H.264 AVIで5有限区間。
  個体能力許可・素材CFR許可・WMA Pro入力例外は全て未登録。FFmpegは外部の8.1.2を明示指定。
- 全上記区間でAAC PID257/258、TS continuity/CRC/PCR/PTS、64ms終端監査、Seek、キャンセル・cleanupを検証。
  10/16区間の最大音声終端差18.67ms、underrun 0。
- 元音声との相関: CFR系最低0.99787、VFR系最低0.99553。160x90 lumaの元映像照合最低50.48/49.90dB。
  これは代表frameの内容照合であり全画素完全一致や絶対同期の独立証明ではない。
- 既存の素材許可CFR記録との10区間比較ではframe数一致。FFmpeg引数も一致する。
  再エンコード画素hashは完全一致しなかった。全frameの比較PSNRは最低45.59dB。
  完全な再エンコード再現性は主張せず、元ログと比較結果を保持する。
- 全編自然EOF・新しい型番の実機・新実装の既存実機での再確認は未実施。
  既存WMA Pro自然EOFとWMA v2末尾契約の制限を修正済みとはしない。

最初のsandbox内の全テストはloopback EACCES等で失敗。通常Windows権限での並列実行では
Privateの既存PCR scanner待機テストが一度タイムアウトした。元ログを保持し、
最終候補は並列度4の全件再試験を行い上記の成功を確認した。判定条件は緩めていない。
最初のHTTP監査が音声Seek診断やプリロール、画質警告を誤拒否したログも保持している。

## 実機観測再生による追加確認（2026-10-26）

生のdescription XML、GetProtocolInfo SOAP応答、実Browseヘッダー/XMLを保存記録から再生した。
代表テレビ2台は同じIntel系だが、次の相違は実観測に存在し、テスト用の仮定ではなかった。

| 観測項目 | CFR代表テレビ | VFR代表テレビ |
|---|---|---|
| 実device role | MediaServerのみ | MediaRendererのみ |
| 実サービス | ContentDirectory / ConnectionManager | AVTransport / RenderingControl / ConnectionManager |
| CM URL構造 | MediaServer系 | MediaRenderer系 |
| 実Sink | 空 | AVC_TS_JP_AAC_Tを含む非空Sink |
| 実製品種別記述 | TOSHIBA OLEDTV | TOSHIBA LCDTV |
| 実HTTP Browse UA | Intel SDK系 | Intel SDK系 |

型番、UDN、IPを除去・変更しても同じ結果になる。製品種別はテレビであることの補強に使い、
OLEDだからCFR、LCDだからVFRという規則にはしていない。
**空SinkやDMS roleだけではCFRの必要性を証明できない。** 実機のCFR/VFR成功知見と
上記構成の関連に基づく推定であり、別型番での成功証明ではない。

同メーカーのレコーダーにもIntel DMS/空Sinkがある反例を発見した。
旧v1判定はこれを含め得たため、v2では現在のmodelDescriptionにテレビ製品種別を要求し、
レコーダー記述を拒否する。製品種別不明、混在role、矛盾する実装、能力不足は自動拡張しない。
従来のJIT/fallbackおよび明示例外は維持するが、CFRが必要な未知機をVFRで再生できるとは主張しない。

`test/fixtures/receiver-observations.json`は観測XML/プロトコル/要求を基に識別値だけを匿名化したもの。
`receiver-observation-replay.test.ts`はこれをproduction readerへHTTP/SOAPで再生する。
`PT3_RECEIVER_OBSERVATIONS`を指定するとGit外の未加工記録でも同じテストを実行できる。
生記録、実個体情報、実素材情報は配布・Public履歴に含めない。

Public既定の実用範囲:

- WMV3 Main + WMA v2: 既存のSD/23.976fps近傍/48kHz stereo等の条件内で自動CFR/VFRと2音声。
- H.264 High/progressive AVI + MP3: 同様の既存適格条件で自動CFR/VFRと2音声。
- WMV3 + WMA Pro: 一般開放しない。明示的入力例外と既知EOF制限は独立して維持。
- MP4/MKV等: 従来JITとAAC pair等の既存適格性を維持。別コンテナをCFRへ一律変更しない。
- WMV3 Complex/29.97fps、走査構造が不明なAVI等: 今回の自動CFR/2音声の適格範囲とは分ける。
  拒否・1音声fallback・既存JITのどれになるかは従来判定による。設定追加で適格性を偽装しない。

WMA Proの一般化には、配布可能な共通PCM時計/索引、自然EOFとSeekの共通時刻定義、
ソース変更/索引破損時の拒否、一般素材のA/V・EOF回帰が不足する。今回追加実装しない。
64ms監査、既知の異常素材制限は維持する。

Private向けフォルダー交換ラッパーは既存control.mjs stop/backup/startを再利用する。
アプリのみ交換し、ライブ許可・設定を一切書き換えない。既存ZP2/Xの例外もそのまま残す。
旧アプリを退避し、復旧時も現在のcatalog/設定/許可を古いバックアップで上書きしない。

### 今回の最終結果

Private: 型チェック/ビルド成功、607件中606成功・既存skip1・失敗0。
Public: 型チェック/ビルド成功、546件中545成功・既存skip1・失敗0。
上記には匿名化観測再生3件と、Git外の未加工観測再生3件を含む。
新しいCFR/VFR選択の異種要求40件を混在させ、前要求の選択が持ち越されないことも確認した。

観測profileで既存成功素材と未登録の別WMV3 Main/WMA v2・H.264 AVI/MP3を検証した。
CFR系16有限区間、VFR系22有限区間でBrowse URL、2 AAC PID、Seek、TS/64ms、cleanupが成功。
動画ごとのCFR/2音声許可は空にした。WMA Proだけは別の明示的診断入力例外を維持した。
Complex/29.97fps入力は実HTTPで1音声fallbackになり、想定外の2音声成功とは数えていない。
走査構造が不明な別AVIは適格性不足として分け、実probeでprogressiveと確認できた別AVIを使用した。

**内容照合は一括合格にしていない。** 追加WMV冒頭の副音声は相関0.96265で既存診断基準0.97未達。
他の追加位置とAVIでは基準を満たす。CFR/VFRの対応する0/12/120秒・両音声の各2.5秒PCMは
バイト一致し、今回の映像profile選択で音声差が増えた証拠はない。元の未達ログを保持する。
この入力の音質と実機での受容性は別途確認し、閾値を下げて合格にしない。

新候補は実機確認用であり正式Release合格ではない。
両版のmain/タグ/Releaseは維持し、実サーバーへの更新はユーザーの実行段階まで行わない。
