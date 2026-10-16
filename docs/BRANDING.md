# DLNA Video Server — 名称とデータ保存先

v0.2.3の製品名は DLNA Video Server です。バージョン番号と再生機能は変わりません。

新規導入の標準Data Directoryは `%LOCALAPPDATA%\DLNA Video Server`、DLNA表示名は `DLNA Video Server (PC名)` です。PC名は自動取得します。既存launcher.jsonや明示指定したデータ保存先、保存済みの表示名・UDNは保持します。旧フォルダを探索・自動移行・削除しません。

更新時は旧版を停止・バックアップし、新版を別フォルダに展開してSetup.cmdで以前と同じデータ保存先を明示的に選んでください。新しい展開先には旧launcher.jsonがないため、何も指定せずEnterすると新しい既定保存先になります。設定・catalog・PCRキャッシュ・個体別設定を使い続けるには元の保存先を指定してください。同じデータ領域を同時利用しないでください。

バックアップの既定名は `DLNA-Video-Server-backup-…`、自動起動タスク／ショートカットは `DLNA Video Server <hash>` です。旧 `PT3 DLNA <hash>` 登録は自動変更しません。既存の自動起動を使っていた場合は、旧版のRemove-autostart.cmdで解除してから新版を登録してください。

内部の `PT3_*` 環境変数、`X-PT3-Management` ヘッダー、npm識別子 `pt3-recording-server`、API・設定キーは維持します。既存のカスタムパス、過去のタグ・Release・ZIP名、調査記録、旧公開準備文書、ライセンス本文は歴史的記録として旧名称が残ります。Audit-cache.cmdは配布フォルダ内のruntimeを使い、旧インストール先は自動探索しません。

PrivateはNode.js／FFmpeg同梱・LAN管理、PublicはNode.js同梱・FFmpeg別配置・localhost管理です。今回GitHub Releaseとタグは変更しません。
