# ライセンスと配布方針

## 本体: MIT

利用・改変・再配布の条件が簡潔なMITを採用しています。Copyright (c) 2026 saburahu。第三者ライブラリのライセンスを置き換えず、各表示義務を維持します。

ライセンス本文はルートのLICENSE、第三者の原文はthird-party/を参照してください。

## 第三者ソフトウェア

production依存はaribts 1.3.5とそのclosure（crc、buffer、base64-js、ieee754、iconv-lite、safer-buffer）。MITおよびBSD-3-Clauseです。開発依存TypeScriptはApache-2.0、tsx/esbuild/@types/node/undici-types等はMIT。正確なバージョンと本文はlockfile/third-partyを参照します。

Node.jsはMITを主体とし、多数の第三者コンポーネントの表示を含みます。Node-only ZIPには実際に同梱する公式Node 24.22.0の完全なLICENSEをそのまま添付します。

## FFmpeg: 別配置方式を採用

旧Windows配布版はGyan 7.1.1 full build、`--enable-gpl --enable-version3 --enable-libx264 --enable-libx265`等を含むGPLv3構成でした。`--enable-nonfree`はありません。GPL該当バイナリの一般配布に、ライセンス本文やURLだけを付ければ十分とは扱いません。

| 方針 | 必要な対応 |
|---|---|
| A: FFmpeg同梱 | その正確なビルドと全GPL dependencyに対応するsource、patch、ビルド手順/スクリプト、ライセンス/著作権表示、GPLv3上の対応source提供方法を整備・検証する。現状は完全な対応sourceセット未整備で採用不可。|
| B: Nodeのみ同梱、FFmpeg別配置 | FFmpeg/ffprobeのexe/dllをReleaseへ含めない。利用者が公式案内から別途取得し、binを指定。Setupで存在/同一ビルド/バージョン/必要encoderを検査し、不足を案内する。利用者向けに配布元とライセンス案内を記載。|

Windows配布版はBを採用しています。現在のFFmpeg 8.1.2もGPL部品を含み得ますが、本プロジェクトのReleaseからは配布しません。外部プロセスとのファイル/CLI連携であり、本体にFFmpeg/x264のコードを取り込む・リンクする変更は行っていません。Bは利用者や別の再配布者のライセンス義務を消すものではありません。

旧7.1.1の実機互換性を理由に、脆弱性修正のない旧binaryを一般公開へ持ち込みません。更新runtimeはPC検証と限定したREGZA受信機での再生確認を行っています。確認範囲はCOMPATIBILITY.mdを参照してください。

## 根拠

- https://choosealicense.com/licenses/mit/
- https://www.apache.org/licenses/LICENSE-2.0
- https://ffmpeg.org/legal.html
- https://ffmpeg.org/doxygen/trunk/md_LICENSE.html
- https://www.gnu.org/licenses/gpl-faq.html#MereAggregation
- https://ffmpeg.org/security.html
- https://nodejs.org/en/about/previous-releases
- https://www.gyan.dev/ffmpeg/builds/

ライセンス、著作権表記、FFmpeg別配置、localhost管理・信頼LAN配信の方針はオーナー承認済みです。更新時にもruntime/security状況と配布条件を再確認します。
