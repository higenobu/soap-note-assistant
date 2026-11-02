# LLM-jp ASR 専用モデルの分離検証（実験用）

既存の CPU Whisper (`compose.asr.yml`, 8003) と別の Compose プロジェクトで
`Atotti/llm-jp-4-8b-speech-asr` を起動する。Web/EC2 の経路は変更しない。
このモデルは Atotti 公開の Whisper-large-v3 encoder + adapter + LLM-jp decoder。
LLM-jp 名前空間の公式配布モデルとは区別する。医学用途での精度は未評価。

- [モデルカード](https://huggingface.co/Atotti/llm-jp-4-8b-speech-asr)（Apache-2.0）
- [実装](https://github.com/Atotti/ja-speech-llm/tree/b04d5061e4ccb68f8955a2af9483c143a860d6d0)
- 実装コードを上記コミットに固定。モデル revision は既定 `main`、結果に取得 revision を記録。
  比較を再現する場合は health の `model_revision` のコミットを `.env` の `LLM_ASR_REVISION` に指定する。
  encoder/processor の追加取得は上流設定に従うため、全依存モデルの完全な固定ではない。
- 上流 `generate()` は `inputs_embeds` を使用し、生成トークンだけを返す。
  モデルカード例の入力長によるスライスは行わない（短い認識結果が消えるのを防ぐ）。

## deepstation で起動

ホストの Python/CUDA/ドライバ、既存サービスを更新しない。Docker の GPU 利用には
既存 NVIDIA Container Toolkit が必要。Python 3.12 / PyTorch 2.5.1 CUDA 12.1 は
新コンテナ内だけに入る。初回は複数モデルの取得があるので、ディスク空きと待ち時間に注意。
CPU 起動への自動切替はせず、GPU 不在なら起動失敗とする。

```bash
cd ~/work/soap-note-assistant
git pull --ff-only
nvidia-smi
df -h .
```

`.env` の既存 `JWT_SECRET` / `JWT_ALGORITHM` / `ASR_ALLOWED_USERS` を使う。
LLM API と同じ秘密鍵を設定する。秘密鍵や `.env` を Git に追加しない。
GPU は他の利用者・処理と調整した番号を追加する。前回の表示では GPU 1/2 にも
Isaac Sim が動いていたため、空きメモリだけで専有可能とは判断しない。
以下は **GPU 1 の割当を確認した場合だけ** の設定例。

```dotenv
LLM_ASR_GPU=1
```

```bash
chmod 600 .env
docker compose -p soap-llm-asr --env-file .env -f compose.llm-asr.yml up -d --build
docker compose -p soap-llm-asr --env-file .env -f compose.llm-asr.yml logs --tail=50 llm-asr
curl --fail --show-error http://127.0.0.1:8004/soap-api/health
```

health が `status: ok`, `experimental: true`, `device: cuda:0` を返せば準備完了。
コンテナ内の cuda:0 は割り当てた物理 GPU（例では 1）を指す。health は稼働確認だけで
認識精度を保証しない。GPU メモリ不足の場合は既存処理を停止せず、このサービスを停止する。
実機の Docker build / モデルロード / 推論 / VRAM 使用量は別途検証が必要。
本リポジトリの CPU モックテストはそれらの代用ではない。

## 同じ音声の比較

最初は個人情報を含まない 10–30 秒の日本語音声を使う。両サービスの上限に合わせて
60 秒以内・32 MB 以内。ASR 専用モデル側は 20 秒区間で処理し、端数も処理する。
時刻は固定区間であり発話の正確な境界ではない。話者識別はしない。
生成上限を超えた場合は部分的な成功として返さず 422 とする。
区間境界の語の欠落・重複、無音の幻聴も原音と照合する。

1. 原音を人が確認して正解文字起こしを UTF-8 `reference.txt` に保存する。
2. 必要なら `terms.json` に `["アムロジピン", "5mg", "発熱はない"]` のような重要語句を用意。
   これらのファイルや音声をリポジトリに置かない。
3. LLM API にログインして得た有効な `access_token` を、以下の非表示プロンプトへ入力。
   トークンをコマンド引数に入れない。両サービスで許可されたユーザーを使う。

```bash
python3 scripts/compare_asr.py /private/sample.wav /private/reference.txt \
  --terms /private/terms.json --output /private/asr-comparison.json
```

標準ライブラリのみ。Token file を使う場合は `--token-file /private/token.txt` とし、
そのファイルの権限は 600 以下にする。ファイル名は実在パスに置き換える。

- 端末には CER と処理秒数・RTF（処理秒数 / 音声秒数）のみ表示。
- JSON は認識原文・正解文・モデル情報・語句出現数を含むためアクセスを制限する。
  新規ファイルを権限 600 で作成し、既存ファイルには上書きしない。Git に追加しない。
- CER は文字編集距離 / 正解文字数。生の CER と NFKC + 空白除去の CER を両方記録。
  小数点・符号・句読点は除去しない。挿入誤りで 100% を超える場合もある。
- 語句出現数は完全一致の補助指標で、同義語や臨床的正しさは判定しない。
- 一方の API が失敗しても他方を試し、失敗側に CER を付けない。終了コード 1。
- 同時実行で GPU/CPU の負荷が変わるため逐次送信。初回ウォームアップ後に複数回比較する。
  複数録音・話者・雑音条件で評価し、モデルの優劣を 1 例だけで判断しない。

音声 API は JWT と許可ユーザーを検査し、音声は一時領域から処理後削除する。
評価レポートは評価者が明示的に作成・保管するもの。医療者が原音と照合するまで
SOAP・診療記録へ確定反映しない。今回の検証では EC2 の公開経路・画面を切り替えない。

## 停止

```bash
docker compose -p soap-llm-asr --env-file .env -f compose.llm-asr.yml down
```

既存 `soap-asr` は継続動作。モデルキャッシュを残すので `down -v` は不要。

## 複数文の欠落を調べる診断情報

短文は正解でも複数文では欠落する場合、GPU障害やモデル性能と即断しない。
今回のコード確認では、共通デコーダーは末尾のリサンプリング結果も取り込み、
20秒固定分割は全サンプルを処理する。上流モデルの `generate(inputs_embeds=...)` は
生成トークンだけを返すので、入力トークン長でのスライスは行わない。
上限は512生成トークン。EOSはdecoderのgeneration_config（なければtokenizer）に従う。
EOSによる終了は、音声を全部文字起こしできたことを保証しない。

入力の有効フレーム数をサンプル数から計算した期待値と照合し、不一致はエラーにする。
上流WhisperFeatureExtractorのattention maskは、音声サンプル単位からhop_lengthごとの
フレーム単位へ変換される。Whisper encoderはstride 2、adapterはkernel単位でプーリング。
診断のadapter_audio_tokensはこの計算に基づく値であり、文字起こしの正しさを表さない。

`.env` に以下を追加して、実験サービスだけ再ビルド・再作成する。
モデルは同じrevisionを使い、認識文や生成トークン列をログに追加しない。

```dotenv
LLM_ASR_DIAGNOSTICS=1
LLM_ASR_REVISION=085d2fc4fcffe1722036ce1bcbeffeca0f2f5e6b
```

```bash
docker compose -p soap-llm-asr --env-file .env -f compose.llm-asr.yml up -d --build llm-asr
curl --fail --show-error http://127.0.0.1:8004/soap-api/health
```

起動完了後、同じ「複数文」の音声と対応する正解文で compare_asr.py を再実行する。
認識結果JSONの `results.llm-asr.response.diagnostics` に区間ごとの入力秒数、特徴量形状、
有効マスクフレーム数、生成トークン数、EOSの設定、終了理由を付ける。
診断自体に認識本文・音声値・全文トークンIDは含まれないが、同じレポートには認識本文が入る。

```bash
python3 - /private/asr-comparison.json <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    data = json.load(stream)
print(json.dumps(data["results"]["llm-asr"].get("response", {}).get("diagnostics", []),
                 ensure_ascii=False, indent=2))
PY
```

- `input_seconds` と `mask_seconds` は丸め誤差（通常0.01秒未満）以外は一致する必要がある。
- `finish_reason: eos` かつ512未満なら、トークン上限ではなくモデルのEOSによる終了。
  内容欠落の原因がEOSだけと確定するわけではない。原音・前処理・モデル挙動も調べる。
- `finish_reason: other` は終了条件の追加調査が必要。
- 上限到達でEOSなしなら従来通り422。部分結果を成功扱いしない。
- EOSを無効化したり、最低生成長を強制したりする変更は行わない。無音での捏造や繰り返しを
  増やす可能性があるため、まず診断で条件を確認する。

診断のCPUテストには実際の Transformers 4.51.0 の WhisperFeatureExtractor を使用する
（モデル重みの取得・GPU推論は行わない）。開発テスト環境へ `transformers==4.51.0` も追加する。
