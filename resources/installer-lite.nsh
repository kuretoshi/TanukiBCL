!macro customInit
  StrCmp $INSTDIR "$LocalAppData\Programs\bettercrewlinkkai" 0 +2
    StrCpy $INSTDIR "$LocalAppData\Programs\bettercrewlinkkailite"
!macroend

!macro customCheckAppRunning
  DetailPrint "Skipping app-running check for BetterCrewLinkKaiLite local build."
!macroend
