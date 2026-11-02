# deepstation音声認識サービス + EC2 Web画面

**配置用の初期設定です。実サーバーへの配置・実モデル・実録音・性能は未検証です。**

## 1. deepstation上で起動

既存のLLM-JP・Isaac Sim・GPU設定を変更しません。CPUだけを使用します。

```bash
cd ~/work
git clone https://github.com/higenobu/soap-note-assistant.git
cd soap-note-assistant
cp .env.example .env
chmod 600 .env
nano .env
```

`.env`のJWT_SECRETとJWT_ALGORITHMには既存LLM-JP APIと同じ値を**ローカルで**設定します。
チャットやGitHubに秘密値を貼らないでください。ASR_ALLOWED_USERSには音声認識を許可する既存APIのユーザー名をカンマ区切りで記載します。
API側でユーザーを無効化するときはASR側の許可一覧も更新してください。すでに発行済みのトークンは有効期限まで有効な場合があります。

```bash
ss -ltn | grep ':8003'
docker compose -p soap-asr --env-file .env -f compose.asr.yml up -d --build
docker compose -p soap-asr --env-file .env -f compose.asr.yml logs --tail=50 asr
curl --fail --show-error http://127.0.0.1:8003/soap-api/health
```

最初のssで8003番が使用中なら、既存サービスを止めずComposeのホストポートと転送設定を変更します。
初回はモデルのダウンロードが必要です。healthがokになったら次へ進みます。GPUはコンテナに渡していません。
8CPU・8GiBの上限を設定しています。CPU small/int8は検証開始用であり、医学用語の認識精度や実時間処理を保証する設定ではありません。

## 2. api.kcg.eduのHTTPSゲートウェイに中継を追加

EC2からdeepstationの127.0.0.1には直接接続できません。**api.kcg.eduのゲートウェイがdeepstation上にあるか、まず確認**します。同じサーバーの場合のみ、ゲートウェイの種類に合わせて以下を使用します。

- Nginx: `deploy/nginx-asr.inc` を既存のapi.kcg.eduのHTTPS server内へinclude。`nginx -t`後にreload。
- Apache: `deploy/apache-asr.inc` を同HTTPS VirtualHost内の広いProxyPassより前へinclude。`httpd -t`後にreload。

既存の `/llmjp/` の転送を保持してください。ゲートウェイが別サーバーなら、ループバックポートの例をそのまま適用せず、プライベート経路や認証付きトンネルを設定します。8003番を全世界に開放しません。

外部からは `https://api.kcg.edu/soap-api/health` が返ることを確認します。transcribeはJWT認証が必要です。
TLSは既存ゲートウェイで終端し、同じホスト内だけ127.0.0.1のHTTPを利用します。

## 3. EC2へ画面を配置

```bash
git clone https://github.com/higenobu/soap-note-assistant.git ~/soap-note-assistant
cd ~/soap-note-assistant
sudo sh scripts/install-static.sh
sudo install -m 644 deploy/apache-web.inc /etc/httpd/llmjp/apache-soap.inc
```

`/etc/httpd/conf.d/llmjp-web-https.conf` のllm-jp.comの443番VirtualHost内へ1回だけ追加します。

```apache
Include /etc/httpd/llmjp/apache-soap.inc
```

既存のSSLProxyEngine・証明書検証設定・`/llmjp/`と血液検査アプリの設定は保持します。
既存VirtualHostの10MB制限に対し、音声用 `/soap-api/` は32MBまで許可します。

```bash
sudo httpd -t
sudo httpd -S
```

Syntax OKと対象VirtualHostを確認してから反映します。

```bash
sudo systemctl reload httpd
curl --fail --show-error https://llm-jp.com/soap-api/health
```

## 4. 架空データで確認

https://llm-jp.com/soap/ を開きます。HTTPS環境とマイク権限が必要です。

1. 「架空会話で試す」で編集・SOAP分類を確認。
2. テスト用アカウントでログインし、架空会話の送信に同意してSOAPを作成。
3. 医師以外の発話がO/A/Pに混入しないこと、欠落・追加がないことを確認。
4. 同意済みの短いテスト録音（まず30秒程度）を認識し、原音とのずれを確認。
5. 話者・薬剤名・数値・否定表現を修正し、再度SOAP分類。
6. 医師確認チェック後にコピー・PDF。編集すると確認チェックが解除されることを確認。
7. 録音中・処理中の消去とログアウトで、遅延応答が結果を復活させないことを確認。

初期版の話者分離は手動です。音声認識の単位は必ずしも1人の発話に一致しません。
複数人・複数SOAP区分が混ざる区間は発話を手入力で分割してください。

## 更新・停止

Web更新は `git pull --ff-only origin main` と `sudo sh scripts/install-static.sh`。
音声認識サービス更新はdeepstationのチェックアウトで同じComposeのupコマンドを実行します。

```bash
docker compose -p soap-asr --env-file .env -f compose.asr.yml down
```

モデルボリュームを残すため、通常の停止では-vを付けません。JWT設定変更時はComposeを再作成します。

## 実データ利用前

録音同意・話者確認・情報へのアクセス権限、API・ゲートウェイのログ保存、コピー/PDFの管理を施設の運用に合わせてください。
CPU時間・メモリ・認識精度・話者修正の負担を測定し、モデル変更やGPU利用はその結果から判断します。
この初期版は自動話者分離・リアルタイム字幕・電子カルテ自動登録・DB履歴・医学的な自動判断を提供しません。


## 代替: deepstationでsudoを使えない場合のSSHトンネル

この方法ではapi.kcg.eduのゲートウェイ設定を変更しません。音声認識はdeepstationの
127.0.0.1:8003、EC2の転送先は127.0.0.1:18003です。ASRのJWT認証・許可ユーザー設定は同じです。

deepstationからEC2へのSSH接続に使う鍵を指定して実行します。秘密鍵はGitやチャットへ送らないでください。

```bash
ssh -i /path/to/ec2-key.pem -N -T \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:18003:127.0.0.1:8003 ec2-user@18.225.212.235
```

このターミナルを開いたまま、**別ターミナルのEC2側**で次を確認します。
deepstation側で18003番を確認しても接続できません。

```bash
curl --fail --show-error http://127.0.0.1:18003/soap-api/health
```

EC2上でWeb画面とトンネル用設定を配置します。

```bash
cd ~/soap-note-assistant
git pull --ff-only origin main
sudo sh scripts/install-static.sh
sudo install -m 644 deploy/apache-web-tunnel.inc /etc/httpd/llmjp/apache-soap.inc
```

既存のllm-jp.comの443番VirtualHost内に、以下がなければ1回だけ追加します。

```apache
Include /etc/httpd/llmjp/apache-soap.inc
```

```bash
sudo httpd -t
sudo httpd -S
```

Syntax OKを確認後:

```bash
sudo systemctl reload httpd
curl --fail --show-error https://llm-jp.com/soap-api/health
```

公開画面は https://llm-jp.com/soap/ です。既存の /llmjp/、血液検査、Flaskの設定を維持します。
トンネル用とゲートウェイ経由用の設定を同時にincludeしないでください。
18003番を外部へ開放する必要はありません。ブラウザからEC2まではHTTPS、
EC2からdeepstationまではSSH暗号化、両サーバー内のループバック区間だけHTTPです。

これは初期デモ用の手動トンネルです。SSH切断後は再接続が必要です。
常駐化する場合は、施設で許可された専用SSHアカウント・鍵・サービス管理方式で、
接続先と転送先を制限して構成してください。
