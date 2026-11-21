Unicode true
Name "TanukiBCL Shared Speech 2.0.2.1"
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
InstallDir "$LOCALAPPDATA\TanukiBCL\Speech\sherpa-2.0.2"
!include "MUI2.nsh"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${SHARED_ROOT}\SENSEVOICE-MODEL-LICENSE"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "English"
VIProductVersion "2.0.2.1"
VIAddVersionKey /LANG=1033 "ProductName" "TanukiBCL Shared Speech"
VIAddVersionKey /LANG=1033 "FileDescription" "Shared local speech model and native worker"
VIAddVersionKey /LANG=1033 "FileVersion" "2.0.2.1"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Upstream authors; see installed notices"
Section "Shared local recognition"
  SetOutPath "$INSTDIR"
  File "${SHARED_ROOT}\silero_vad.onnx"
  File "${SHARED_ROOT}\SHERPA-LICENSE"
  File "${SHARED_ROOT}\SILERO-LICENSE"
  File "${SHARED_ROOT}\ONNXRUNTIME-LICENSE"
  File "${SHARED_ROOT}\SENSEVOICE-MODEL-LICENSE"
  File "${NOTICES_FILE}"
  File "${RUST_NOTICES}"
  File /oname=ADAPTER-LICENSE "${ADAPTER_LICENSE}"
  SetOutPath "$INSTDIR\runtime"
  File "${SHARED_ROOT}\runtime\TanukiSpeechWorker.exe"
  File "${SHARED_ROOT}\runtime\sherpa-onnx-c-api.dll"
  File "${SHARED_ROOT}\runtime\onnxruntime.dll"
  File "${SHARED_ROOT}\runtime\onnxruntime_providers_shared.dll"
  SetOutPath "$INSTDIR\sensevoice"
  File "${SHARED_ROOT}\sensevoice\model.int8.onnx"
  File "${SHARED_ROOT}\sensevoice\tokens.txt"
  File "${SHARED_ROOT}\sensevoice\LICENSE"
  File "${SHARED_ROOT}\sensevoice\README.md"
SectionEnd
