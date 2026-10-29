# v0.4.4候補: 録画TSの静的放送メタデータ

通常起動・通常の録画フォルダー探索から、安定したTSのSIをアイドル時に自動解析します。手動登録や明示解析を通常利用の前提にしません。テレビ画面の表示成功はまだ未確認です。

## 既存機構への追加

- EITの主番組選定、ARIB文字デコード、section assembler/CRC、PCR索引、RecordingMetadataCache、Program.station、通常DIDLを再利用。
- SDTはcurrent/actual-TSだけを扱い、PATのサービスとTSID、選定eventのONID等を照合します。局名が複数・矛盾・不明なら埋めません。channelNrの生成は未実装です。
- `startTime`と`durationSeconds`は従来どおりEIT番組予定。`recordingRange`は別のTOT/PCR輸送時間軸の推定です。最初／最後の表示フレーム時刻ではありません。
- 新規項目: station、transportStreamId、originalNetworkId、recordingRange（state/basis/segments/anchorCount/spreadMsと、条件成立時だけstartTime/endTime/durationSeconds/uncertaintySeconds）。全TOT標本はキャッシュへ保存しません。

## 自動解析と負荷

既存PCRバックグラウンド管理の後段でSIを解析します。新しいDB・別キュー・管理画面はありません。既定は単一ジョブ、読取上限32MiB/s、安定待ち120秒、メディア終了後の猶予15秒、空き容量ガードを共有。PCR索引がない場合はその生成にも同じ制限がかかります。

PCR完成とSI完成は別状態です。SIの安定待ちや失敗で、完成したPCRを未完成扱いにはしません。既存のpcr-cache.sqliteへmetadata_state／metadata_retry_at／metadata_error／metadata_attemptsの4列だけを追加し、同じ管理サイクルで段階・backoffを管理します。起動時は成功済みメタデータを再確認待ちへ戻して、現在のschemaと実体を順次確認します。既存PCRカウンターはPCR段階の意味を保ち、metadataSuccess／metadataFailed／metadataDeferredを別に返します。

起動時の探索が一度だけでも、安定待ち後に1サイクル最大1件のstat再確認で解析へ進みます。既存のpause/disabled/容量制限も尊重します。再生・Seekでは同一素材でもSIジョブを中断し、別の前景PCR処理も優先します。JIT状態は既存busy検出を使用します。中断はerrorキャッシュへ確定せずpendingのまま再試行、再起動後も既存探索から再開します。処理済みの正常キャッシュは全編再読取しません。

一時的な解析エラーは表示を従来fallbackに戻し、60秒、300秒のbackoffで最大3回まで試行します。3回失敗すると同じfingerprintでは自動再解析を停止し、その状態を再起動後も保持します。素材の更新で回数をリセットします。解析中の更新は安定待ちへ戻します。スキャン後に消えたファイルで後続のキューを止めません。

一覧の同期BrowseでSI全編走査はしません。解析結果の変更は対象Programへ反映してUpdateIDを進めます。refresh APIはキャッシュ再読込を行い、破損等でpendingとなったものだけ既存バックグラウンドへ再確認を通知します（同期の全編解析はしません）。明示analyze/CLIは明示解析のままです。refreshと自動完了の競合による古い値の上書きを防ぎます。

大規模ライブラリーでは総読取量に比例して時間がかかります。32MiB/sで1TiBを1回読むだけでも約9時間、初回PCR生成とSIで2回必要な場合は約18時間が下限の目安です。再生中・一時停止中の延期や解析CPU時間は別です。起動直後に全件を並列処理しません。

## キャッシュ

既存eit-cacheをschema 2へ更新。ファイルのdevice/inode/birth timeを識別に用い、hard linkや別名の同一実体も同じキャッシュを再利用します（inodeが得られない環境ではrealpath）。size/mtime、metadata checksum、schema、型を確認し、同時解析も統合します。inode再利用に対してbirth timeも照合します。

同じキャッシュインスタンスでは読取だけでなく要約・atomic writeまで一つの処理として統合し、別名からの同時renameを防ぎます。別プロセスの明示CLIまで排他する機構ではありません。共有先ファイルシステムの識別情報が再接続等で変われば、安全側で再解析します。

旧schema 1は通常表示用の最新情報とはせずpendingへ戻し、同じ自動経路で再解析します。旧ファイルは新schema保存まで破壊しません。更新後も旧cacheファイルが残ることがあります。原TSやObjectIDは変えません。解析不能時は従来のファイル名等へfallbackします。削除されたファイルは公開対象に戻さず、元TSの削除・書換えはしません。

## 時刻の信頼条件

単一PATサービス、完全走査、連続した健全PCR、3点以上のTOT、アンカー間5秒以上、録画時間の90%以上のカバー、先頭／末尾の未観測30秒以内、TOT−PCRオフセット全幅250ms以内を必要条件とします。250msは今回の約40～47msという実測に対する保守的な受理ガードで、規格値や絶対精度保証ではありません。

PCRラップは既存索引で展開します。PCR不連続／異常interval、複数サービスで対象PCRが曖昧な場合、TOTの時刻飛び、アンカー不足では単一の時刻範囲を通知しません。複数segmentを一つの連続録画として補間しません。映像PTS／表示遅延、放送局側の時刻校正は未測定で、`uncertaintySeconds=1`は分解能の目安であり絶対精度ではありません。

## DIDL

| 属性 | 通知する値 |
|---|---|
| dc:title / genre | 既存confirmed判定による番組名等。未確認なら従来fallback |
| dc:date | confirmed録画の先頭時計（recordingOrigin、または既存のconsistent録画範囲のstart）。明示JST +09:00。番組予定でNPT0を代用せず、録画原点を得られないconfirmed項目では省略。未確定metadataの従来fallbackは維持 |
| upnp:channelName | 照合できたSDT局名をProgram.station経由で通知。既存の外部設定値は保持 |
| upnp:scheduledStartTime / scheduledEndTime | confirmedのEIT番組予定。録画前後マージンを加算しない |
| dc:description | 既存番組説明に、条件を満たした録画範囲を「TOT/PCR推定・TS輸送時刻・絶対精度未校正」と明示して追加。JST秒表示 |
| res@duration / URL / ObjectID | 既存値を維持。予定番組長で上書きしない |

scheduledStart/EndとchannelNameは[ContentDirectory:1](https://upnp.org/specs/av/UPnP-av-ContentDirectory-v1-Service.pdf)にも存在し、レコーダーの実送信も確認しました。recordedStartDateTime等は同規格に見当たらず今回の実機送信例も不足するため追加しません。録画範囲を予定日時に偽装せず、説明で推定と示します。DIDLの提供と、REGZA/DBRの標準画面で実際に表示されることは別の検証です。

動的な放送時計、SI再注入、映像への時計焼込み、新しい再生方式は実装しません。既存CFR/VFR、JIT、音声、Seek、64ms監査の設定は変更しません。

## リリース前に必要な確認

REGZA/DBRで、通常一覧／番組説明に局名と予定日時が表示されるか、JST解釈、録画範囲の説明表示を確認する必要があります。表示しない機器へ対応済みとは表現しません。地デジ／BSのchannelNr生成は、ARIB運用と規格の照合が済むまで保留します。全外字・DRCS、編集TSのsegment別時計、校正済み絶対精度は対応範囲外です。

RC監査では、PATのTSID変更、存在しない日付・zone欠落、0秒予定区間を拒否する反証を追加しました。失敗上限状態は素材の更新まで保持します。cache破損は再起動または既存refreshの再読込でpendingとなり、低優先度で再構築します。同期Browseからの全編走査は行いません。

開発環境の実録画検証で、statのミリ秒未満のmtimeとProgram.modifiedのISOミリ秒表現を直接比較すると、自動解析の結果が一覧へ反映されないことを確認しました。公開時の照合をISO保存精度へ揃え、解析前後とキャッシュの厳密なstat照合は維持しています。ミリ秒未満のmtimeを持つ実ファイルを使い、refresh/analyzeを呼ばず通常起動だけでDIDLが更新されるHTTP回帰テストを追加しました。

実機写真で、一覧・番組詳細・再生タイムラインがUTCの時分をそのまま壁時計として表示する9時間ずれを確認。confirmedの放送由来dc:dateとscheduledStart/Endのみ、同一時点のJSTオフセット表記へ変更しました。cacheのUTC値・原TS・再生時刻・一般動画の日付fallbackは維持します。既存のディレクトリー表示revisionを2へ進め、UpdateIDとイベント通知で古い日時宣言の再取得を促します。日跨ぎ／年跨ぎ／閏日、既に+09:00の入力、瞬間の同値をテスト。実機の修正後表示は再確認まで未確認です。録画範囲の信頼条件250msは変更していません。

### 録画余白と時計原点の分離

EIT予定開始は録画先頭ではありません。dc:dateを番組予定へ固定すると、受信機の再生時計が録画前余白ぶんずれます。予定はscheduledStart/Endへ残し、dc:dateにはTOT/PCRから得たファイルNPT0の時刻を使います。TS切詰め、映像PTS変更、予定時刻からの余白推測はしません。

追加recordingOrigin（version1、tot-pcr-prefix、estimated/unavailable、startTime、anchors、first/lastSeconds、spreadMs、uncertaintySeconds）は先頭時計だけの証拠です。先頭20秒の観測窓、TOT3点以上・5秒以上のspan、先頭アンカー10秒以内、250ms以内の局所offset幅、単一サービス/連続した全体PCRを必要条件とします。既存recordingRangeの全編250ms判定は不変。局所原点が得られても、全編範囲をconsistentへ変更しません。

既存schema2のうち、全編時計検証済みだが録画範囲のoffset幅が不整合で先頭情報がないconfirmed cacheは、既存背景処理で最大64MiBのprefixを再読取して原点だけを補完します。旧全編EITを部分EITで上書きせず、SID/TSID/ONIDと現statを照合。prefixが20秒を覆えなければ既存の全編解析へ戻します。中断時は不完全cacheを保存せず、同じ源への並行要求は既存仕組みで統合。成功/不採用の結果をcacheに保持して繰返し読取を防ぎます。Browse同期解析・新DB・別カタログ・別管理画面はありません。

1秒という時刻分解能の目安/絶対精度未校正は維持。これは最初の表示フレームの絶対時刻や、編集・放送時計飛び後も動的表示が正確なことの保証ではありません。新しい動的時計APIは追加せず、受信機がNPTへ加算する基準時刻を提供します。
