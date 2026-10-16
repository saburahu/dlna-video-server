# DLNA Video Server — 名称変更と更新互換性

v0.2.3の製品名を「PT3 Recording Server」（PT3 録画サーバー／PT3 DLNA server）から「DLNA Video Server」に変更しました。バージョン番号と再生機能は変わりません。

新規セットアップの既定DLNA表示名は DLNA Video Server です。既存の表示名は、旧既定名も含めそのまま保持します。変更したい場合だけ管理画面で変更してください。UDNは再生成しません。

更新は旧版を停止・バックアップしたうえで、新版を別フォルダに展開し、Setup.cmdで以前と同じデータ保存先を選びます。設定・SQLite catalog・ObjectID・PCRキャッシュ・個体別互換性設定は引き継ぎます。同じデータ領域を旧新版で同時に使用しないでください。

次の旧名称は互換性のため維持します。

- データ領域の既定パス: `%LOCALAPPDATA%\PT3 Recording Server`
- 環境変数 `PT3_*`、管理要求ヘッダー `X-PT3-Management`、既存の設定キーとAPI
- 自動起動タスク／ショートカットの内部登録名 `PT3 DLNA <hash>`（更新・解除で同じ登録を指定するため）
- バックアップの既定ファイル名 `PT3-backup-…`、npmパッケージ識別子 `pt3-recording-server`
- GitHubリポジトリURL、過去のタグ・Release・ZIP名、過去の検証記録

ライセンス本文や第三者ソフトウェアの著作権表示は変更していません。新名称のZIPは今回ローカル生成するもので、既存GitHub Releaseの添付は変更しません。
