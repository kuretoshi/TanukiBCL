# 共有音声認識モデルの導入

通常版・Lite版・.NET版・Tauri版のボイスストーンに共通の、Windows x64向けローカル認識モデルです。

1. Microsoft Visual C++ v14 Redistributableのx64版が必要です。未導入の場合は[Microsoft公式ダウンロードページ](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist)からx64版を導入してください。モデルのネイティブライブラリが使用する実行環境で、共有モデルのインストーラーには同梱していません。
2. ベタクルを終了し、詳細設定の「共有モデルをダウンロード」または[共通インストーラー](https://github.com/kuretoshi/TanukiBCL/releases/download/v3.2.69/TanukiBCL-SharedSpeech-Setup-2.0.2.1.exe)を実行してください。
3. ベタクルを再起動してください。詳細設定に「共有モデルで認識する」がOnと表示されます。対応するタヌキ丼β24を使用してください。

モデルは同一Windowsユーザーの `%LOCALAPPDATA%/TanukiBCL/Speech/sherpa-2.0.2` に1組だけ置きます。各版での再インストールは不要です。タヌキ丼未検出時はモデルを起動せず、検出解除時は録音・認識を終了します。

PC参加者は各自の端末、Web・Android・iOS参加者の分はPCホストが認識します。スマートフォンへのモデル導入と音声認識APIキーは不要です。モデル未準備・スイッチOffの場合は従来のVoskを使用します。変身とNGワードの認識エンジンは従来どおりです。

設定された録音時間が終わってから認識し、ゲーム内で単語を確認して設置・再録音・取消できます。実マイクと多人数時の性能は未確認です。
