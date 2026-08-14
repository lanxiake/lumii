; Lumii NSIS custom macros
; 安装完成后刷新 shell 图标缓存，避免桌面/任务栏仍显示旧的 Electron 默认图标。

!macro customInstall
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
