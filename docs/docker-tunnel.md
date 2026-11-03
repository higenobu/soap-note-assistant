# sudo / linger 不要の Docker SSH トンネル

**deepstation の通常ユーザー matsu の Bash で設定する。EC2ではない。**
既存の CPU Whisper (127.0.0.1:8003) へ、EC2 の 127.0.0.1:18003 から中継する。
実験用GPU ASR (8004) は接続先にしない。EC2 Apache の既存設定は変更不要。

必要条件は、sudoなしで操作できる Linux の常駐 Docker Engine と Compose v2、
既存のEC2用SSH鍵、および確認済みのEC2ホスト鍵。コンテナを `-d` で起動するため
端末を閉じても継続し、SSH切断検知後は `restart: unless-stopped` で再接続を試みる。
ホスト再起動後は Docker daemon が起動すれば再開する（手動停止した場合を除く）。
Dockerそのものを起動するサービスの設定は変更しない。
rootless Docker の daemon 自体がログアウトで終了する環境では、この方式だけで常駐化できない。
その場合は管理者による常駐daemon等の準備が必要。通常のユーザーサービスは不要。

## 1. 鍵と接続先を確認

以下はこの環境で現在使用中の鍵パスの例。実際のパスと異なる場合だけ置き換える。
秘密鍵をリポジトリへコピーしない。鍵・JWT・ASR設定をイメージへ取り込まない。

```bash
cd ~/work/soap-note-assistant
chmod 600 /home/matsu/news.pem
ssh -F /dev/null -i /home/matsu/news.pem -o IdentitiesOnly=yes \
  -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes \
  ec2-user@18.225.212.235 true
ssh-keygen -F 18.225.212.235 -f /home/matsu/.ssh/known_hosts
```

接続エラーまたはホスト鍵が見つからない場合は、そのまま進めず接続先と指紋を確認する。
StrictHostKeyChecking=no や未検証の ssh-keyscan 結果の採用で回避しない。
このDocker版はssh-agentをマウントせず、パスフレーズの対話入力にも対応しない。
鍵がssh-agent依存でしか使えない場合は別途構成が必要。既存鍵のパスフレーズを削除しない。

## 2. 設定・ビルド（手動トンネルを止める前に実施可能）

```bash
cp -n deploy/tunnel.env.example .env.tunnel
chmod 600 .env.tunnel
nano .env.tunnel
sh scripts/tunnel-compose.sh build
```

`.env.tunnel` は鍵とknown_hostsの **絶対パス** のみを指定する。`.gitignore` の `.env.*` で
Git対象外になる。JWT_SECRETなどのAPI秘密値は不要。
wrapper が通常ユーザーのUID/GIDを取得し、同じUID/GIDのコンテナユーザーをビルドする。
これにより鍵を600のまま読み取れる。rootユーザーとしての実行は拒否する。
known_hosts は読み取り可能であること。2ファイルとも読み取り専用マウントし、
ホストディレクトリ全体、ssh-agent、Dockerソケットはマウントしない。
ビルドコンテキストは `service/tunnel` だけであり、`.env` や秘密鍵を送信しない。
初回ビルドはDebianイメージとOpenSSHパッケージの取得が必要。

## 3. systemd / 手動版から切り替える

```bash
systemctl --user disable --now soap-asr-tunnel.service
pgrep -a -u "$USER" ssh | grep 18003
```

サービスが存在しない場合は、そのエラーを確認して先へ進める。
手動版SSHが残っていれば、起動したターミナルでCtrl+C、またはそのトンネルだと確認した
PIDだけを `kill PID` で停止する。他のSSH接続は停止しない。
18003番は同時に1本しか確保できないため、切り替え時に短い中断が発生する。

```bash
sh scripts/tunnel-compose.sh up -d
sh scripts/tunnel-compose.sh ps -a
sh scripts/tunnel-compose.sh logs --tail=30 tunnel
```

このシェルは閉じてもよい。Docker daemon とASRコンテナは稼働させておく。
`Up` はSSH接続完了やASR稼働の保証ではないため、次のEC2側疎通を必ず確認する。
SSHプロセス自身が切断された場合はDockerがバックオフしながら再起動する。
keepaliveは30秒ごと、3回の未応答で切断を検知する設定。検知・復旧は即時ではない。
`ExitOnForwardFailure` はEC2側ポート確保の失敗を検出するが、ASR自体の停止は検出しない。

## 4. EC2側で確認

```bash
curl --max-time 10 --fail --show-error http://127.0.0.1:18003/soap-api/health
curl --max-time 10 --fail --show-error https://llm-jp.com/soap-api/health
```

`status: ok`, `device: cpu`, `model: small` なら現行CPU ASRへ中継できている。
SSHの再起動は音声認識コンテナの起動を代行しない。deepstation の8003も確認すること。

## 5. 停止・再開・更新

以下はdeepstation側。

```bash
sh scripts/tunnel-compose.sh stop
sh scripts/tunnel-compose.sh up -d
```

鍵の内容・所有者・known_hostsの置換後は、ファイルのbind mountを更新するため再作成する。
UID/GIDが変わる場合は再ビルドも必要。

```bash
sh scripts/tunnel-compose.sh up -d --build --force-recreate
```

削除する場合は `sh scripts/tunnel-compose.sh down`。ホストの鍵・known_hostsは削除されない。
systemd版へ戻す場合は先にDocker版をdownし、その後にユーザーサービスを再開する。

## トラブル時

- `remote port forwarding failed`：手動版/systemd版などが18003を使用していないか確認。
- `Host key verification failed`：登録済み指紋とEC2の正しい指紋を確認。検証を無効化しない。
- `Permission denied (publickey)`：鍵パス・所有権・UID/GID、対話やagentへの依存を確認。
- ファイル不存在：bind mountは自動でディレクトリを作らず失敗する。絶対パスを修正する。
- コンテナがUpでもAPIが不通：deepstationの8003とEC2の18003をそれぞれ確認。

## 検証範囲

ローカルではCompose YAMLとOpenSSHの設定展開、wrapperの引数転送・UID/GID設定を確認する。
Dockerイメージのビルド、EC2とのSSH接続、切断後再接続、ホスト再起動後の復旧は
deepstation/EC2上で確認が必要。既存EC2のSSH認証・ASRのJWT認証は維持する。

参考: [Compose services](https://docs.docker.com/reference/compose-file/services/)、
[OpenSSH ssh_config](https://man.openbsd.org/ssh_config)。
