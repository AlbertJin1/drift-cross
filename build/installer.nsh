; -----------------------------------------------------------------------------
; Drift Browser — branded NSIS installer experience (v2)
;
; Extends electron-builder's maintained NSIS installer. electron-builder keeps
; ownership of upgrade, shortcut, uninstall and file-integrity logic. Drift
; defaults to a current-user install; browser data lives in %APPDATA%\Drift and
; is never removed by the uninstaller unless the user explicitly opts in.
; -----------------------------------------------------------------------------

; -----------------------------------------------------------------------------
; Re-definition helpers. electron-builder expands these macros in more than one
; compile pass (installer + uninstaller) and defines some MUI symbols itself, so
; a plain !define aborts with "already defined". These helpers are idempotent.
; -----------------------------------------------------------------------------
!macro DriftSet _name _value
  !ifdef ${_name}
    !undef ${_name}
  !endif
  !define ${_name} "${_value}"
!macroend

!macro DriftFlag _name
  !ifndef ${_name}
    !define ${_name}
  !endif
!macroend

!macro customHeader
  BrandingText "Drift Browser  ·  Move at your own pace"
  ShowInstDetails nevershow
  ShowUninstDetails nevershow
  !insertmacro DriftFlag MUI_ABORTWARNING
  !insertmacro DriftSet MUI_ABORTWARNING_TEXT "Drift isn't installed yet.$\r$\n$\r$\nAre you sure you want to quit setup?"
  !insertmacro DriftFlag MUI_UNABORTWARNING
  !insertmacro DriftSet MUI_DIRECTORYPAGE_TEXT_TOP "Drift will be installed in the folder below. To use a different folder, click Browse. Drift needs roughly 300 MB of free space."
  !insertmacro DriftSet MUI_FINISHPAGE_TITLE "Drift is ready"
  !insertmacro DriftSet MUI_FINISHPAGE_TEXT "Drift has been installed.$\r$\n$\r$\nYour bookmarks, history and settings are stored separately from the app, so updating or reinstalling never touches them.$\r$\n$\r$\nClick Finish to close setup."
  !insertmacro DriftSet MUI_FINISHPAGE_LINK "Learn more about Drift"
  !insertmacro DriftSet MUI_FINISHPAGE_LINK_LOCATION "https://github.com/"
  !insertmacro DriftFlag MUI_FINISHPAGE_NOREBOOTSUPPORT
!macroend

!macro customWelcomePage
  !insertmacro DriftSet MUI_WELCOMEPAGE_TITLE "A clearer way through the web"
  !insertmacro DriftSet MUI_WELCOMEPAGE_TEXT "Welcome to Drift. A fast, considered browser that keeps what you need close and the clutter out of the way.$\r$\n$\r$\nSetup installs Drift only for your Windows account and never requests administrator permission. Other Windows accounts can install their own copy in their own user folder.$\r$\n$\r$\nTip: close any running copy of Drift first. Setup will offer to do that for you if you forget."
  !insertmacro DriftFlag MUI_WELCOMEPAGE_TITLE_3LINES
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !insertmacro DriftSet MUI_WELCOMEPAGE_TITLE "Before you leave Drift"
  !insertmacro DriftSet MUI_WELCOMEPAGE_TEXT "This will remove the Drift application from this computer.$\r$\n$\r$\nYour personal profile (bookmarks, history, settings and extensions) is kept by default. On the next screens you can choose to delete it as well.$\r$\n$\r$\nClose Drift before continuing."
  !insertmacro DriftFlag MUI_WELCOMEPAGE_TITLE_3LINES
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; --- Pre-flight: stop a running Drift cleanly instead of failing mid-copy -----
!macro customInit
  nsExec::Exec 'cmd /c tasklist /FI "IMAGENAME eq Drift.exe" 2>NUL | find /I "Drift.exe" >NUL'
  Pop $0
  ${If} $0 == 0
    MessageBox MB_YESNO|MB_ICONQUESTION "Drift is currently running.$\r$\n$\r$\nClose it now so setup can continue? Open tabs are restored the next time you launch Drift." /SD IDYES IDYES drift_close_running IDNO drift_keep_running
    drift_close_running:
      nsExec::Exec 'taskkill /IM Drift.exe /T'
      Sleep 1200
      nsExec::Exec 'taskkill /F /IM Drift.exe /T'
      Sleep 400
      Goto drift_init_done
    drift_keep_running:
      MessageBox MB_OK|MB_ICONINFORMATION "Please close Drift and run setup again."
      Abort
    drift_init_done:
  ${EndIf}
!macroend

; --- Post-install: brand the Apps & Features entry ----------------------------
!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "Publisher" "Drift contributors"
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "HelpLink" "https://github.com/"
  WriteRegDWORD SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "NoRepair" 1
!macroend

; --- Uninstall: profile data is kept unless the user explicitly opts in -------
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Drift profile?$\r$\n$\r$\nThis permanently removes bookmarks, history, settings, cookies and extensions.$\r$\n$\r$\nChoose No to keep them for a future reinstall." /SD IDNO IDYES drift_wipe_profile IDNO drift_keep_profile
    drift_wipe_profile:
      RMDir /r "$APPDATA\Drift"
    drift_keep_profile:
  ${endIf}
!macroend
