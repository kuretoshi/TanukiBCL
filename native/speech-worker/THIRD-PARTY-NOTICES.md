# Native local speech worker

TanukiBCL adapter: GPL-3.0-or-later.

- sherpa-onnx v2.0.2 (Xiaomi / k2-fsa), Apache-2.0. The unmodified `c-api.h` is pinned to v2.0.2. Source: https://github.com/k2-fsa/sherpa-onnx/tree/v2.0.2
- ONNX Runtime distributed with the upstream Windows native library: MIT. https://github.com/microsoft/onnxruntime
- Silero VAD (snakers4): MIT. https://github.com/snakers4/silero-vad
- SenseVoiceSmall (FunAudioLLM / Alibaba), model name `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`. The model card links to the separate FunASR Model Open Source License Agreement v1.1. Preserve the model license and attribution independently of the library license. https://huggingface.co/FunAudioLLM/SenseVoiceSmall and https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE
- tinysegmenter 0.1.1, MIT; Rust Japanese word segmentation. https://crates.io/crates/tinysegmenter/0.1.1

The preparation script retains upstream library/model license texts in the shared speech cache. No model weights are checked into this repository. Distribution must include notices/licenses for the actual selected runtime/model assets. Speech recognition currently uses local inference only; no cloud transcription API is used.
