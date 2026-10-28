> 履歴資料：試験UI撤去時点の記録です。後続の入力・継続監査の修正はDBR_NORMAL_COLOR_PLAYBACK.mdを参照してください。

# DBR隔離試験機能の撤去（v0.4.3候補）

78410ff系の通常MPEG-2 JITについて、ユーザーが通常一覧からの再生・音声切替・約120秒Seek・Seek後の再切替に成功したと報告した。同じ実機試験は再依頼しない。全編自然EOFはPC検証済み、実機では未確認として区別する。

## 撤去範囲

DBR互換性試験タブ、そのJS・状態管理、30秒資産の準備/監査/一時公開/取消サービス、専用API・配信URL・許可セッション、専用受信機選択メソッドと不要テストを削除する。過去の調査資料・実機観測・Git履歴は保持する。旧データや試験ログを自動削除しない。

通常JITのmpeg2-color-normalization、dbr-color-headers、TS/PCM/64ms監査は維持。captured-mpeg2-trialは別の既存mpeg-ts-trial経路が利用しているため維持する。MPEG-2受信機設定が使うendpoint照合処理も維持し、内部名だけmpeg2Peersへ変更する。

## 旧版上書き時

旧public/dbr-color-trial.jsや旧app/srcのモジュールがインストール先へ残っていても、新server/indexはロードしない。旧JS・API・配信URLは大文字小文字違いを含め404で拒否する。HTML/JSはno-storeで返し、ブラウザー再読み込みで削除済みタブを再利用しない。手動削除やPowerShell操作は不要。

旧版への復旧時はStop後に退避したアプリを上書きしてStartする。現在の設定・UDN・catalog・索引を無条件で古いデータへ置換しない。旧アプリに戻すと旧試験UIも戻るが、新候補では無効。

## 通常再生との差分

通常JITの映像・音声・時計・引数・Seek・接続置換・監査モジュールは78410ffと同一。server/catalog側の差分は試験サービスへの接続除去、試験専用のBrowse/ProtocolInfo/UpdateID上乗せ除去と静的UIの再読み込み契約だけ。通常のBrowse描画・ObjectID・JIT URL・受信機選択は変更しない。

全編25分のPC検証は78410ffの記録を保持し、今回の再生core/配布JS一致と短区間の実HTTP回帰で継続性を確認する。新しい再生処理の実機成功を推定せず、今回は再生処理を変更しない。
