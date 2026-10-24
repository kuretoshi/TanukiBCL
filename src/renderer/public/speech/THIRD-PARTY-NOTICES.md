# Local Japanese speech recognition

The packaged application includes Vosk Browser 0.0.8 and vosk-model-small-ja-0.22.
Both are distributed under Apache License 2.0. Vosk Browser runs Vosk/Kaldi in a
WebAssembly worker. Desktop clients recognise their own microphone. A host additionally recognises identified Web/mobile participants for active hero and forbidden-word jobs. Recognition is local; no speech service receives audio or transcripts.

- Vosk Browser: https://github.com/ccoreilly/vosk-browser
- Vosk API: https://github.com/alphacep/vosk-api
- Kaldi: https://github.com/kaldi-asr/kaldi
- Japanese model: https://alphacephei.com/vosk/models.html
- Full license: Apache-2.0.txt in this directory.

Run `powershell -File scripts/prepare-hero-speech.ps1` before building. Downloads
are pinned to SHA-256 checksums in that script. Generated assets are not committed.
