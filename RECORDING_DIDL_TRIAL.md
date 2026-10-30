# 録画DIDLの表示条件比較（開発用・正式仕様未確定）

通常起動では無効。開発起動の環境変数 `PT3_RECORDING_DIDL_TRIAL=1` でのみ有効になる。管理UI・配信プロファイル・永続設定は追加しない。再起動後は必ずAから開始する。

|条件|元がvideoBroadcastである録画項目のクラス|録画由来の日時|
|---|---|---|
|A|videoBroadcast|小数秒、+09:00（現行）|
|B|videoItem|小数秒、+09:00|
|C|videoBroadcast|整数秒、+09:00|
|D|videoItem|整数秒、+09:00|

整数秒条件では表示する小数秒を切り捨てるため、表現精度は1秒未満失われる。UTCキャッシュ・元のアンカー・予定日時の算出は不変。タイムゾーンは省略せず、予定開始を録画先頭へ代用しない。resのdurationやprotocolInfoは変更しない。

開発担当がloopbackの `/api/diagnostics/recording-didl` へJSONでGET、またはPOST `{ "condition": "A" }` 等を送り切り替える。利用者のPowerShell操作や設定編集は不要。ローカルHostと同一Origin、JSONを要求し、通常起動では404。再生・JIT中の切替は409で拒否する。ブラウザー用の新しい画面はない。

切替のたびにBrowse/GetSystemUpdateIDとGENAの更新番号へ同じ改訂分を加える。SOAPログに条件と実応答XML・ハッシュが残る。条件は全クライアント共通で、型番や個体識別への分岐はない。

テレビでは一覧から一旦上の階層へ戻り、同じ録画フォルダーを開き直して表示を比較する。実要求・応答の条件をログで確認するまでは古い一覧キャッシュの可能性を排除しない。実機表示の成功はPCのXMLテストと区別する。

初回A～D比較の基準復元はA。Bの実機成功後に行う独自ID比較では、終了時にIDなしのBへ戻す。開発環境変数を外して再起動すれば機能自体が無効になり、従来のDIDLと更新番号計算へ戻る。受信機の結果が出る前にB～Dを製品の既定値へしない。

## Bの独自サービスID比較

一覧の日時表示で両機の成功報告があるBを基準として、同じローカル制御へ `{ "condition": "B", "regzaIds": true }` を送ると、確認済みの放送識別情報に限り `regza:network_id` / `regza:service_id` を追加できる。falseまたは省略でIDなしのBへ戻る。切替時は同じUpdateID/GENAとSOAPログを使用する。再起動後に許可・選択は復活しない。

表示は小文字16進・接頭辞なし・可変桁。ID名前空間は観測した `urn:schemas-toshiba-co-jp:regzadata-1-0`（末尾スラッシュなし）。必要なxmlns宣言と2要素以外は不変。

confirmed metadataとidentified channelInfo（既存NIT/SDT照合でnetwork_idとONIDの一致を確認済み）、有効な16bit ONID/TSID/SIDを必要とする。TSIDをnetwork_idへ代入しない。地デジとBSの観測に対応し、CS・不明・矛盾した放送区分には追加しない。型番・IP・UDN・作品・固定ObjectIDで許可しない。元録画の実res URLから既存のメタデータを参照するので、一覧とMetadataや別表示経路でも同じ識別値になる。

この対応は既存DMSの送信例と実TSの照合に基づく比較機能であり、独自仕様全体の解明や再生中表示成功を意味しない。TS本体、SI、再生URL、DLNA宣言、時計原点、局名、日時は変更しない。
