; NoteTOO Updater's default folder must not start with NoteTOO's ("...\Programs\NoteTOO"): NoteTOO's
; installer stops every process whose path starts with its folder, which would include the updater
; running it. electron-builder's documented way to change the default folder is the InstallLocation
; it reads back; a folder the user chose is kept, the old default is moved.
!macro preInit
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $0 "" setDefault
  StrCmp $0 "$LOCALAPPDATA\Programs\NoteTOO Updater" setDefault keep
  setDefault:
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$LOCALAPPDATA\Programs\Updater for NoteTOO"
  keep:
!macroend
