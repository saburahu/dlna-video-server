# 公開・更新チェックリスト

初回公開のMIT（Copyright 2026 saburahu）、Node同梱/FFmpeg別配置、localhost管理、独立Public repository/Releaseはオーナー承認済みです。

## 初回検証

- 明示allowlistのソース/合成テストだけを独立Gitへ取り出し、元開発Gitの履歴/remote/個体設定/録画/catalog/ログは持ち込まない。
- 独立npm ci、型チェック、ビルド、452/452テスト（skip 0）、情報検査0件、npm audit0件。パターン検査は未知の秘密の不存在を完全には証明しない。
- 合成MP4/HEVC MKV/AVI/WMV×両JIT×3範囲=24件の実HTTP/decode/Seek/終端検証。2executor重複、3本目拒否、Seek/停止/枠再利用/cleanupを検証。
- Node-only配布版を開発フォルダ外で起動し、SQLite/DLNA/TS TimeSeek/VLC Direct/Range/HTTP Seek/定期更新/backup/import/UDN/バージョン切替/管理拒否を検証。
- 新runtimeは開発版のPC・実機確認を先行。ZP2/55X9900R/DBR-T1010の各MP4/HEVC MKV再生成功。全機能/全機種再検証ではない。

## 毎回の公開前

1. 選別したファイル、公開Git root/remote、ライセンス、個体情報/実録画名/認証情報を検査する。公開用Git以外なら中止する。
2. 独立テストと実HTTPを通し、確認済み/未確認範囲を記録する。
3. クリーンな公開ソースcommitからNode-only ZIPを作り、FFmpeg/ffprobe非同梱とNode/第三者licenseを確認する。
4. 別配置起動とZIP再展開全ファイルSHA-256を確認する。
5. 明示的な配布操作時だけReleaseへZIP/SHA-256/導入手順/既知制限/対応source commitを登録する。通常pushでの自動Releaseは行わない。
6. ダウンロードした添付のサイズ/hashとGitHubのPublic設定/source commit/tagを再確認する。

開発側からの更新では履歴をmerge/forkせず、publication-manifest.jsonの各ファイルをレビューする。管理保護/外部FFmpeg/合成fixtureを維持し、開発バックアップと公開Releaseを混同しない。
