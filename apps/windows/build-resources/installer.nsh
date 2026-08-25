; Lumii NSIS custom macros
; 安装完成后刷新 shell 图标缓存，避免桌面/任务栏仍显示旧的 Electron 默认图标。

; 卸载时是否一并删除用户数据（"1" = 删除）。默认保留。
Var /GLOBAL LumiiPurgeUserData

!macro customInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

; 卸载器启动时询问是否清理用户数据。
; 策略：默认保留（deleteAppDataOnUninstall=false）；仅在用户明确选择"是"时才删。
; MB_DEFBUTTON2 让默认焦点落在"否"，避免顺手回车误删聊天记录与记忆库。
; 自动更新会静默调用卸载器，此时绝不能弹窗（会挂住升级流程），一律保留数据。
!macro customUnInit
  StrCpy $LumiiPurgeUserData "0"

  IfSilent lumii_skip_purge_prompt

  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "是否同时删除 Lumii 的个人数据？$\r$\n$\r$\n包括聊天记录、记忆库、技能与本地配置。$\r$\n$\r$\n选择“否”将保留这些数据，便于以后重新安装后继续使用。" \
    /SD IDNO IDYES lumii_confirm_purge IDNO lumii_skip_purge_prompt

  lumii_confirm_purge:
    StrCpy $LumiiPurgeUserData "1"

  lumii_skip_purge_prompt:
!macroend

; 仅当用户在 customUnInit 明确确认后才删除数据目录。
; 覆盖三处运行时位置：Electron userData($APPDATA)、缓存($LOCALAPPDATA)、
; 以及 Lumii 自己的数据根 ~/.lumii（见 AGENTS.md 的运行时数据约定）。
!macro customUnInstall
  StrCmp $LumiiPurgeUserData "1" 0 lumii_keep_user_data

  DetailPrint "正在删除 Lumii 个人数据..."
  RMDir /r "$APPDATA\Lumii"
  RMDir /r "$LOCALAPPDATA\Lumii"
  RMDir /r "$PROFILE\.lumii"
  DetailPrint "Lumii 个人数据已删除"
  Goto lumii_uninstall_done

  lumii_keep_user_data:
    DetailPrint "已保留 Lumii 个人数据"

  lumii_uninstall_done:
!macroend
