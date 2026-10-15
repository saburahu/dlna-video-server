# セキュリティ方針

用途は信頼できる家庭内LANです。管理画面/APIはサーバーPC上のlocalhostからだけ操作でき、別PCからの管理はできません。認証付きLAN管理は未実装です。TCPポートやSSDPをインターネットに転送しないでください。外部用reverse proxy、ゲストLAN、不特定利用者、マルチテナント用途は非対応です。

## 現版の対策

- 管理画面/APIは送信元loopbackのみ。Hostはlocalhost/127.0.0.1/[::1]と実ポートの組合せのみで、DNS rebindingを拒否します。
- 管理APIの書き込みは `X-PT3-Management: 1` と同一Originが前提です。異なるOrigin/クロスサイト要求は拒否し、frame埋め込みも拒否します。ヘッダーは秘密トークンではなく、ブラウザのcross-origin simple requestを避けるためのものです。
- LAN端末はDLNA Browseと選択したmediaのGETだけを使います。UDNをHTTP GETに含むと仮定せず、既存のbindingとfingerprintを維持します。
- ファイルURLはcatalog/ObjectIDから解決し、任意の絶対パスをURLから受け取りません。登録rootとのcanonical path照合、リンクを追わない探索、Direct Playのlease/再stat、JIT枠2本、request世代管理を利用します。
- subprocessは引数配列で起動しshellを利用しません。実行ファイルと録画rootを設定できるローカルOS利用者を信頼します。
- UPnPイベントcallbackは要求元と同じhostだけを認め、redirectを追いません。端末description/capability取得もredirect禁止・同一private host等の検査があります。
- 診断ログのAuthorization/Cookie等のヘッダーは保存前にマスクします。録画タイトル・UDN・IP・パスまで匿名化する機能ではありません。

## 残る制約

DLNA media閲覧には利用者別パスワード/TLSがなく、同じ信頼LANの端末は公開された録画を閲覧できます。loopbackの悪意あるOSプロセスや、管理者に設定権限を与えた端末を隔離するsandboxではありません。FFmpeg decoderを安全に隔離するOS sandboxもありません。信頼できない破損/細工されたメディアを処理しないでください。

同一OSユーザーが走査とopenの間にファイルを差し替える全TOCTOU攻撃を排除する保証はありません。設定APIが既知の録画rootを公開するのは意図したローカル管理機能です。公開フォルダに認証情報・秘密鍵を置かないでください。

Node/npm/FFmpegの更新・公式security情報を確認してください。FFmpegの最低バージョン判定は全CVEの不存在を保証しません。旧7.1.1を公開用の推奨バイナリとして同梱しません。

不具合報告のログは必要区間だけをコピーして、IP、UDN、username、絶対パス、録画名、トークンを人が確認・匿名化してください。元ログは手元に保管し、録画本文やcatalogを公開Issueへ添付しないでください。自動アップロードはありません。
