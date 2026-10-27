# MPEG-2受信機別拡張試験（v0.4.3候補）

## 設定の境界

旧 `mpeg2InputTrial` は許可に使いません。個体を選択する管理API `GET/POST /api/clients/mpeg2-trials` を使用します。初期状態は両機能OFFです。

保存先は既存データ領域のexperimental-catalog/jit.jsonの `mpeg2ReceiverTrials` 配列です。各レコードはversion、deviceId、controlUrl、sinkHash、implementationFingerprint、targetProfile、wmaProInput、dualAudio、reference、configuredAtを持ちます。実際の要求と対応する現在のendpoint、UDN/Sink/実装、MPEG-2 targetのbindingを毎回検査します。IP/型番/UDN/作品の固定値を製品コードに埋め込みません。

- A: wmaProInput=false / dualAudio=false。新規拡張OFF。
- B: false / true。適格なWMA v2/MP3/AAC等の2音声をAAC PID321/322に変換。WMA Pro自動入力はOFF。
- C: true / true。適格なWMA Proも試験。
- WMA単独: true / false。適格WMA Proを1音声で試験。

既存の明示許可・無効化・素材固有例外は維持され、今回のスイッチはそれらを削除・上書きしません。新しい試験許可より既存拒否が優先されます。機能OFFは既存の有効な明示許可を取り消す操作ではありません。

旧一括フラグは無視し、管理APIで設定する際にfalseへ退役させます。旧候補へ戻した際の意図しない一括有効化を防ぐためです。ほかの設定や許可を変更しません。

## 操作

対象受信機でサーバーのフォルダー一覧を開いてから再生停止状態にします。他の配信・変換があれば設定変更は拒否されます。以下はサーバーが動作するWindows上のPowerShellで実行します。管理APIの一覧から操作者が機器を選び、現在の個体を再照合したうえで保存します。テレビへのPlay/Seek命令は送りません。

```powershell
$api='http://localhost:19090/api/clients/mpeg2-trials'
$s=Invoke-RestMethod $api
for($i=0;$i -lt $s.clients.Count;$i++) {
  $c=$s.clients[$i]
  [pscustomobject]@{Number=$i;Model=$c.description.modelName;IP=$c.remoteIp;Eligible=$c.eligible;Wma=$c.wmaProInput;Dual=$c.dualAudio;Reason=$c.reason}
}
$n=[int](Read-Host '試験する受信機のNumber')
if($n -lt 0 -or $n -ge $s.clients.Count){throw '選択番号を確認してください'}
$selectedDevice=$s.clients[$n].deviceId
function Set-Mpeg2Trial([bool]$Wma,[bool]$Dual) {
  $state=Invoke-RestMethod $api
  $row=@($state.clients | Where-Object deviceId -eq $selectedDevice)
  if($row.Count -ne 1){throw '個体の対応が不明です。再選択してください'}
  $payload=@{id=$row[0].id;revision=$row[0].revision;wmaProInput=$Wma;dualAudio=$Dual}|ConvertTo-Json
  Invoke-RestMethod $api -Method Post -ContentType 'application/json' -Headers @{'X-PT3-Management'='1'} -Body $payload | Out-Null
  (Invoke-RestMethod $api).clients | Where-Object deviceId -eq $selectedDevice |
    Select-Object eligible,wmaProInput,dualAudio,configuredWmaProInput,configuredDualAudio,reason
}
Set-Mpeg2Trial $false $false # A
# Set-Mpeg2Trial $false $true  # B
# Set-Mpeg2Trial $true  $true  # C
# Set-Mpeg2Trial $true  $false # WMA単独
# Set-Mpeg2Trial $false $false # 新規拡張を戻す
```

設定変更後は受信機の一覧を開き直してください。選択した受信機の古いURLは意図的に無効になります。他の受信機のURLには影響しません。再起動後は保存した設定を保持しますが、現在の要求とendpointの再確認までは有効になりません。configured*は保存値、wmaProInput/dualAudioは現在の有効値です。保存値だけで配信許可しません。ONはEligible=trueの現在の受信機だけに許可します。保存済みのoffline行も選択でき、OFFへ戻せます。エラー時に許可を広げるfallbackはしません。

## 検証・制限

MPEG-2 TSの既存レシピ、独立PCR256、映像320、AAC321/322、3003tick周期、64ms監査を保持します。full-range/yuvj420p/SMPTE240Mの危険条件や未対応入力を、試験許可で迂回しません。PSは使用しません。WMA Pro自然EOFは未解決です。

追加の通常2音声とWMA Proのテレビ実機成功は未確認。PCでのTS生成・時計・音声対応の確認と、実機音声切替を区別してください。初回は照合を通過したAVI/MP3とWMA Proの代表例だけを使用します。WMA v2で相関に未解決の区間があり、初回候補から除外しています。サンプル未満の位置合わせで改善した数値を新たな合格基準にはしません。

## 配布と復旧

標準の停止→アプリ上書き→起動を使用します。新しい更新ツールは不要です。既存launcher.jsonとデータ領域を保持し、Setupの再実行やデータ初期化はしません。拡張だけ戻す場合は状態Aへ変更します。アプリを旧候補へ戻す場合もデータを古いDBで上書きせず、標準Stop/Startと退避済みアプリを使用してください。

## v0.4.3候補の検証記録

型チェック・ビルド、Private659件/Public597件のNode全テストを確認。実HTTPでは受信機別A/B/C/WMA単独・未選択受信機・サービス再生成/復旧の各版22項目、合成10＋同時制御3条件、危険条件/対象外4素材の拒否を検証。配布物の管理APIは未確認受信機や不正Originを拒否する。これらはPC検証であり、追加機能のテレビ実機成功ではない。

WMA v2には音声内容照合が未確定の例があり初回実機候補から除外。位置合わせの追加解析で改善した値を、元の判定に置き換えていない。初回は照合済みAVI/MP3とWMA Proの代表例に限定する。64ms監査・既知のEOF制限はそのまま。
