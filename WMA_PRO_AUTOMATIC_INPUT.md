# WMV3 / WMA Proの技術条件による自動入力

v0.4.1未公開候補。Private/Public共通。従来の素材限定許可だけに依存する方式を改める。
録画の作品名、path、fingerprint、個体UDNの登録を一般許可の条件にしない。
fingerprintは既存のファイル同一性/変更検知と明示例外の照合に引き続き使用する。

## 従来の拒否と成功経路

source-clock-v1のraw codec gateはWMA v2を許可し、WMA Proを拒否していた。
自動client trialからのcatalogJitCandidateがこのgateを使うため、デコーダーが存在してもBrowseにresが出なかった。
source-clock-v2と素材限定例外は、既存のWMA Pro復号・AAC変換への入力を許可するだけである。
v1/v2は時計アルゴリズムの切替ではない。どちらも既存の音声start解析、aresample async=1、
サンプル時計監査、AAC出力、独立終端/TS監査を使用する。研究用PCM時計や索引は接続しない。

代表実機では、同じv2入力経路でWMV3/WMA Proの再生・2音声・Seekが成功している。
別の短い予告素材は、CFR系では過去に1音声の映像再生までで、2音声/Seekの実機成功は未確定。
今回の一般化はこの既存実行経路の入力判定を技術条件へ置き換えるもので、実機成功範囲を水増ししない。

## 自動適格条件

- 現在の観測から得たREGZA互換性profile：regza-intel-server-cfr-v1またはregza-intel-renderer-vfr-v1。
  manufacturerだけで許可せず、現在のrole/services/Sink/Intel実装系列/テレビ種別の証拠を使用する。
- 自動clientの既存binding、legacy入力、WMA入力が有効。出力先はlegacy-jp-observedの既存AVC/AAC経路。
- ASF、映像1本、WMV3 Main、8bit yuv420p、720×576以下、progressiveまたはヘッダーの走査構造不明。
  不明な走査構造は実行時の既存復号・deinterlace/CFR入力監査でさらに確認する。
- 公称24000/1001または30000/1001fps近傍。avg_frame_rate=0/0/欠落はr_frame_rateを使う。
  既知の矛盾する平均や120fpsヘッダー等を都合よく上書きしない。
- WMA Pro stereo、1音声なら44.1/48kHz、2音声なら両方48kHz。同一codec、重複しないstream index。
- ASF audio timebase 1/1000。開始時刻が既存の同一起点範囲内（3ms）、音声durationがcontainerと64ms以内で整合。
  ヘッダー整合はPCM絶対時刻の独立証明ではない。実行中の時計/終端監査を省略しない。
- 実行FFmpegにWMV3/WMA Proデコーダーがある。実際の初期化/復号/出力の成功は実行時に確認。

これらは現在のSD WMV3/CFRおよび2音声の実証範囲との共通範囲である。
保存済みライブラリのWMA Proヘッダー161件中122件がこのメタデータ条件に適合した。
全122件を実配信/実機検証したという意味ではない。特定ファイルを許可する一覧はコードに持たない。

VC-1、WMA Lossless/v1、WMV3 Complex、HD、明示interlaced、未確認の公称cadence、
5.1/96kHz、3音声以上、2音声44.1kHz、混在codec、不整合な開始/終端、decoder不足は今回の自動範囲外。
技術的理由はautomaticWmaProInput.reasonで取得できる。従来の明示opt-in範囲そのものは変更しない。
対応範囲を超える入力を、無音挿入・時刻固定補正・1音声への偽装で新たに通さない。

## 優先順位と他受信機

既存の素材例外は残す。同一receiver/target/pathに無効・古い・重複・壊れたWMA例外があれば、
新しい自動許可で迂回しない。有効な既存例外は従来の検証関数が処理する。
関係のない作品の例外は、新しい適格素材を拒否する根拠にしない。
WMA入力許可とAAC 2音声能力、CFRの適格性は独立。どれか一つで他の安全条件を代用しない。

CFR系は適格入力に既存の29.97fps CFR、VFR系は既存VFR。
2音声48kHzはAAC PID257/258、1音声は通常のAAC PID257。出力は48kHz。
新しい29.97fps WMA pairは観測互換性profileのあるreceiverに限定し、
未知clientの古い明示2音声許可を拡張しない。DBR等の既存の別出力は変更しない。
別型番が同じ観測profileに合致すれば同じ判断をするが、別型番の実機成功とは表現しない。

## 通常視聴と自然EOF

自然EOFが完全解決するまでBrowse/再生開始を一切禁止する必要はない。
有限区間、Seek、通常GETの開始とキャンセルは、既存時計/TS/終端監査を通して利用できる。
全編の最後までの音声coverageは別の契約であり、64ms監査を緩めない。

短いWMA Pro予告の通常GETを人工終端/Seekなしで受信したところ、約30秒出力後、
両profileともAudio does not cover requested segment endpointでHTTP異常終了を再現した。
入力duration29.866秒、HTTP経過約30.4～30.6秒。FFmpeg出力が得られたことを自然EOF成功とは数えない。
既存の長い代表素材の約84.67/77.50ms差、WMA v2の末尾契約、長尺映像ギャップ/703ms問題は未解決。
研究用の索引時計の拒否条件を変更せず、これらの素材を全編合格にしたとは主張しない。
今回、固定85ms補正、音声の削除/追加、新しいEOF時計、Python依存を導入しない。

## 実測と残る確認

作品/個体/素材の許可が空のPrivate/Public初期設定で、両profile各14区間、計56区間を確認。
既知の代表2音声入力に加え、未登録の別2音声48kHz/23.976fps、1音声44.1kHz/23.976fps、
2音声48kHz/29.97fpsを含む。新しい型番のTV操作を行った試験ではない。

- Browse由来URL、冒頭/12秒/120秒、実映像・各音声、AAC PID、CFR3003tick/VFR、64ms/TS、cancel/reGET、cleanupを検証。
- 未登録2音声入力の300～360秒を両profileで60秒ずつ、通常ペーシングで受信。
- 44.1kHz単音声の120秒Seekは8回反復成功。
- 58区間の元動画内容照合は、音声相関最低0.99599（基準0.97）、代表画素最低51.37dB（基準27dB）。
  4:3の比較には製品と同じ縦横比保持/余白処理を適用。比較条件不一致の元結果も保存した。
- WMA v2/MP3は両版・両profileで32区間の実HTTP回帰。通常TS等と他receiverは全自動回帰で確認。
- VC-1/WMA Proと5.1の実素材は初期Browse拒否を維持。未確認条件を許可へ置き換えない。

単音声CFR監査で一度frame番号欠番が発生した。原stderr未保存のため、その発生原因は未確定。
prefixが別行に分離した完全video bodyや、audio/video bodyの同一行混在を扱えるよう解析を補強した。
frame番号連続性、PTS逆行/重複、2秒以上gap、interlaced、未知PTSの拒否は維持し、分割fixtureと反復実HTTPで検証。
独立試験間の共有Seekキャッシュ競合による初回EPERMも保存し、試験ごとのデータ分離で再実行した。

今回の新しい一般入力を実配備したテレビでの確認はまだ必要。
特に予告の2音声/Seek、別作品、44.1kHz単音声、29.97fps入力を両profile代表で確認する。
PC成功から可聴切替や全編正常終了を推定しない。自然EOFは既知の制限として扱う。
PublicのFFmpeg/ffprobe非同梱、既存設定/許可の保持、製品番号0.4.1を維持する。
実サーバー、main、タグ、Release、録画は変更せず、push/配備/新ZIP作成は行わない。

### 最終自動検証

Privateは618/618、Publicは556/556成功、skip/失敗0。両版の型チェック/ビルドも成功。
FFmpeg/ffprobe8.1.2、Node24.22.0を明示し、通常TS/スキャン/Seekの実サーバーテストも含めた。
WMA Proの有限HTTP66区間と既存形式の回帰32区間、計98区間で完了/underrun0/cleanupを確認。
有限区間の音声終端差は最大18.67ms、64msを維持。全編自然EOF成功とは数えない。
