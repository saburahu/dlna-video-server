# 受信機互換性：出力と再生ソフトウェアの分離

受信レシピの実証根拠と、現在のBrowse/GETに対応するUPnP実装・カデンス推定を別に記録します。同居DMSのSource広告やメーカー・製品種別だけで受信能力を決めません。ConnectionManagerは対応device自身の記述に限定し、別deviceのサービスを合成しません。矛盾・複数一致・情報不足は安全側へ戻します。

AVC系の既存CFR/VFR選択は維持します。server/renderer等の観測レイアウトによる推定は、未検証の別型番の実機成功保証ではありません。RECORDERという説明だけで、実際に対応するIntel要求のAVC候補を否定しません。CFR必要性の推定とAVCデコード候補の選択は別です。

MPEG-2＋AAC＋独立PCRの既存レシピを保持。追加WMA Pro入力と通常AAC2音声は`jit.json`の`mpeg2InputTrial: true`に限定した未実機検証の試験候補です。既定無効。作品・個体登録ではなく技術条件と現在要求の対応で判断します。既存の明示拒否や素材例外を迂回しません。

ASF/SD WMV3 Main、23.976/29.97、stereo WMA v2/Pro、適格なH.264 AVI/MP3、および従来適格MP4/H.264/AAC・MKV/HEVC/AACを評価します。開始・終端・timebase・トラック数・デコーダーを検査します。full-range/yuvj420p/SMPTE 240M入力は既知の重大な失敗との共通条件としてMPEG-2経路で拒否します。因果や全危険入力の検出は保証しません。PSは使用しません。

PC検証はPrivate/Public各10実素材区間、合成EOF/Seek/同時制御、元音声との独立照合を含みます。実機成功とは区別します。WMA Pro自然EOF、WMA v2末尾無音契約、入力復号警告、Vorbis副音声は未解決。64ms監査は変更しません。Publicは引き続きFFmpeg非同梱です。
