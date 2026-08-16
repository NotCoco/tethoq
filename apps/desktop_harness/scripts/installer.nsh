!macro customInstall
  CreateDirectory "$SMPROGRAMS\Tethoq"
  CreateShortCut "$SMPROGRAMS\Tethoq\Tethoq Bridge.lnk" "$INSTDIR\resources\bridge-companion\Tethoq Bridge.exe" "--background" "$INSTDIR\resources\bridge-companion\Tethoq Bridge.exe" 0 SW_SHOWNORMAL "" "Tethoq Bridge"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Tethoq\Tethoq Bridge.lnk"
  RMDir "$SMPROGRAMS\Tethoq"
!macroend
