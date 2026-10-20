@echo off
:: 第二个微信账号：独立数据目录 C:\myself\my-soft\Weixin2
:: 会先关闭当前微信实例（不同数据目录不能同时在线）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0weixin-multi.ps1" -DataDir "C:\myself\my-soft\Weixin2"
pause
