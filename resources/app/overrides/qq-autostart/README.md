# qq-autostart（组合层）

设置页里的「QQ 开机自启」独立开关，默认关。

- 开启：写 `tools/start-qq.vbs`（延迟 N 秒拉起 QQ），并在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 写 `QQAgentQQAutoStart`。
- 关闭：删 Run 值和 VBS。
- 不碰：SnowLuma 的 `autoStart`。崩溃自愈守护（`dafeiyu-watchdog.ps1` 及自启 lnk/vbs）已于 2026-11-27 移除并归档到备份资源库，本层不再涉及。
- 不代填密码；QQ 没设自动登录时，开机后仍要扫码。
- 改完本层或 `routes.mjs` 必须完整重启 QQ Agent 一次，组合层是启动时绑定。

状态存 `data-v05/qq-autostart.json`；接口 `GET/POST /api/qq-autostart`。
