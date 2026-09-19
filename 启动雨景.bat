@echo off
rem 如果降雨数据变成雨 —— 本地启动脚本
cd /d "%~dp0"
start "" http://127.0.0.1:8642/index.html
python -m http.server 8642
