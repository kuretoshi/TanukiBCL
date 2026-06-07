!macro customInit
  StrCmp $INSTDIR "$LocalAppData\Programs\tanukibcl" 0 +2
    StrCpy $INSTDIR "$LocalAppData\Programs\tanukibcllite"
!macroend

!macro customCheckAppRunning
  DetailPrint "Skipping app-running check for TanukiBCLLite local build."
!macroend
