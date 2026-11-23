# 被 jev-guard 拦下时怎么办

这页是写给**坐在键盘前的人**的,不是写给模型的。被拦不是死路:下面每条规则都说明
**为什么拦**、**这条命令本来会改什么**、**可能出什么问题**、**怎么在 DSH 之外手动做**、
**怎么回滚**。同样的内容可以在终端里按当前语言看:

```sh
node bin/guard.mjs explain <规则 id>
```

照抄本页命令之前,先读一遍终端输出。这些步骤是**故意绕过**阀门的;它们不会让操作变安全,
而且有些后果(清空的事件日志、抹掉的磁盘)**根本无法撤销**。

## 被拦是什么样子

- 工具调用被拒绝,命令不会执行。
- 理由里带规则 id,并指向 `guard explain <id>`。
- L0 的 deny **不能**用一次性 `guard allow` 令牌放行;只有人改规则才能改变,这是故意的。
- 判定服务故障时,`never`(完全访问)会话下非只读命令也会被拒;`ask` 会话仍然弹审批。

### 拦下之后阀门会做什么

- **不可逆的规则**(下表标"不可逆"的,以及没有说明书的旧规则):下一步会立刻收到一条
  "停手"消息,要求模型不要重试、不要换写法,先向你说明,并把选择交给你。
- **可逆的规则**:当下不打断任务。这一回合结束时会出现一条汇总提醒,列出被拦的规则和
  `guard explain` 指引,让模型写进最终回答。
- 两种消息都会写进会话历史,你随时可以回看。它们只是**强提示,不是强制暂停** ——
  真正会停下来等你点"允许/拒绝"的只有审批模式(`ask`)。

## 规则一览

| 规则 | 拦什么 | 可逆吗 |
| --- | --- | --- |
| `hosts-overwrite` | 写 `/etc/hosts` 或 `...\drivers\etc\hosts` | 可(先备份) |
| `root-cert-import` | 把根证书装进本机信任库 | 多数可移除 |
| `firewall-off` | 关闭 Windows 防火墙配置档 | 可 |
| `eventlog-security-clear` | 清空安全日志 | **不可逆** |
| `defender-disable` | 关实时防护 / 加排除项 | 可 |
| `uninstall-security-product` | 卸载杀软/EDR | 需重装 |
| `guard-home-write` | 写 jev-guard 自己的状态目录 | 可(先备份) |
| `system-hosts-write` | `write`/`edit` 指向系统 hosts | 可(先备份) |
| `windows-dir-write` | `write`/`edit` 写进 `%SystemRoot%` | 可修复 |
| `startup-write` | `write`/`edit` 写进启动文件夹 | 可 |

---

## `hosts-overwrite`

**拦什么。** shell 命令写系统 hosts(`Set-Content`/`Add-Content`/`Out-File`,或
`echo`/`type`/`tee` 重定向进 `/etc/hosts` / `C:\Windows\System32\drivers\etc\hosts`)。
读这个文件不受影响。

**为什么拦。** hosts 优先于 DNS;一行写错就能悄悄把某个域名(包括更新或安全域名)指到别处。

**本来会改什么。** 本机所有程序共用的域名解析表。

**风险。** 更新/登录失败;安全域名被改写会掩盖真正的问题;实验结束忘了改回来,故障会一直存在。

**手动做(DSH 之外的 PowerShell)。**

1. `Copy-Item "$env:SystemRoot\System32\drivers\etc\hosts" "$env:SystemRoot\System32\drivers\etc\hosts.bak" -Force`
2. `Start-Process notepad -Verb RunAs "$env:SystemRoot\System32\drivers\etc\hosts"`
3. 只添加需要的那一行(`IP 域名`),保存后 `ipconfig /flushdns`。
4. POSIX 上是 `/etc/hosts`,改完同样要清解析缓存。

**回滚。** 把 `hosts.bak` 覆盖回 `hosts`,再 `ipconfig /flushdns`。

**更安全。** 优先用应用级代理/分流,或在路由器做本地 DNS 覆盖。

---

## `root-cert-import`

**拦什么。** `certutil -addstore Root|AuthRoot|TrustedPublisher` 和
`Import-Certificate -CertStoreLocation Cert:\LocalMachine\Root`。

**为什么拦。** 本机信任库里的根证书可以为任意站点背书。

**本来会改什么。** 所有使用系统信任库的程序开始信任该根签发的证书。

**风险。** 根私钥泄露会导致流量被中间人解密;企业代理会这么做,个人机器通常不该。

**手动做。**

1. 从可信渠道核对指纹:`Get-FileHash <证书> -Algorithm SHA256`。
2. 一致才以管理员运行:
   `Import-Certificate -FilePath <证书> -CertStoreLocation Cert:\LocalMachine\Root`。
3. 之后重开浏览器。

**回滚。** 按指纹在 `Cert:\LocalMachine\Root` 找到、确认后 `Remove-Item`(或在
`certlm.msc` 删除)。企业策略要求它时先问 IT。

**更安全。** 单个应用用 `CurrentUser\My`;测试放虚拟机。

---

## `firewall-off`

**拦什么。** `netsh advfirewall set *profiles state off` 与
`Set-NetFirewallProfile -Enabled $false|0`。

**为什么拦。** 它让所有监听端口失去入站过滤。

**本来会改什么。** 指定配置档的入站过滤停止生效。

**风险。** 数据库、远程桌面、开发服务器会被同网段直接访问;域策略可能改回来并告警;
公网暴露几分钟内就会被扫描。

**手动做。** 优先只放行一个端口:
`New-NetFirewallRule -DisplayName "dev 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow`。
确实要临时全关:`Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled False`,做完立刻开回来。

**回滚。** `Set-NetFirewallProfile -All -Enabled True`,用
`Get-NetFirewallProfile | Select-Object Name,Enabled` 核对,删除临时规则。

**更安全。** 按程序/端口放行并限制 `-RemoteAddress`;不要在公共网络配置档上关。

---

## `eventlog-security-clear`

**拦什么。** `wevtutil cl Security` 与 `Clear-EventLog -LogName Security`。

**为什么拦。** 它销毁登录、提权和审计证据。

**本来会改什么。** Security 日志里的全部事件被删除。

**风险。** **不可逆**——没有命令能恢复已清空的条目;排查入侵时,这个动作本身就很可疑。

**手动做。** 先归档:
`wevtutil epl Security C:\backup\Security-$(Get-Date -Format yyyyMMdd-HHmm).evtx`,
确认导出文件正常,再 `wevtutil cl Security`。

**回滚。** 已清空的事件无法恢复;如果只是想控制大小,改上限而不是清空:
`wevtutil sl Security /ms:<字节数>`。

**更安全。** 先归档再轮转;安全事件应该送到集中日志。

---

## `defender-disable`

**拦什么。** `Set-MpPreference -DisableRealtimeMonitoring $true` 和
`Add-MpPreference -Exclusion*` / `Set-MpPreference -Exclusion*`。

**为什么拦。** 排除项是恶意软件的常用手法;关实时防护等于拿掉最后一道自动检查。

**本来会改什么。** 整机停止扫描,或指定路径/扩展名/进程不再被检查——重启后可能仍生效。

**风险。** 恶意文件可直接运行;排除整个盘符等于长期关防护;篡改防护可能阻止你改回来。

**手动做。** 只排除一个目录:
`Add-MpPreference -ExclusionPath "C:\work\build"`。要临时暂停:
`Set-MpPreference -DisableRealtimeMonitoring $true`(可能被拒)。核对:
`Get-MpPreference | Select-Object DisableRealtimeMonitoring,ExclusionPath`。

**回滚。** `Set-MpPreference -DisableRealtimeMonitoring $false`;
`Remove-MpPreference -ExclusionPath "C:\work\build"`;被策略锁定时需要管理员改回。

**更安全。** 构建放虚拟机/容器;误报提交给 Microsoft。

---

## `uninstall-security-product`

**拦什么。** 点名安全产品的 `winget uninstall`、`msiexec /x`、
`wmic ... call uninstall`。

**为什么拦。** Defender 不一定自动接管;中间可能完全没有实时防护。

**本来会改什么。** 移除该产品的服务、驱动和托盘程序。

**风险。** 无防护窗口;残留过滤驱动会导致断网或蓝屏;重装需要许可证/管理员权限。

**手动做。** 用厂商卸载器(设置 > 应用,或厂商工具);要换产品就先装新的、确认接管,
再卸旧的。用
`Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct` 检查。

**回滚。** 从官网重装;确认 `Get-Service WinDefend` 在跑;网络被残留驱动弄坏时在设备管理器卸载后重启。

**更安全。** 先在实验机/虚拟机验证替换流程;生产机不要无替代防护。

---

## `guard-home-write`

**拦什么。** `write`/`edit` 写进 jev-guard 自己的状态目录(`~/.jev-guard`,或
`JEV_GUARD_ALLOW_FILE` 指向的路径)。

**为什么拦。** 这个目录里有 `allow.txt`、`config.json`、`secrets.json`;能写它就能预先授权
命令或替换密钥。

**本来会改什么。** 令牌、阈值/策略,或判定密钥。

**风险。** `allow.txt` 写坏会让某条命令被永久放行;`config.json` 改坏会让插件启动失败;
密钥贴进文件会泄露。

**手动做。** 用 CLI,不要手写文件:
`node bin/guard.mjs allow "<命令>"`、`allow --list`。改配置先备份:
`Copy-Item "$HOME\.jev-guard\config.json" "$HOME\.jev-guard\config.json.bak" -Force`,
用记事本改完跑 `node bin/guard.mjs status`。密钥只用 `node bin/guard.mjs key set` 录入。

**回滚。** 用 `.bak` 覆盖回去并跑 `status`;撤销令牌 `allow --revoke <令牌>`;密钥疑似泄露
就在服务商后台轮换。

**更安全。** 用 CLI 子命令而不是手改;改前备份、改后 `status`。

---

## `system-hosts-write`

**拦什么。** `write`/`edit` 的 `file_path` 是系统 hosts 文件。

**为什么拦 / 会改什么 / 风险。** 同 `hosts-overwrite`。

**手动做。** 先备份,以管理员编辑,`ipconfig /flushdns`。

**回滚。** 还原备份,清解析缓存。

**更安全。** 应用级代理或本地 DNS。

---

## `windows-dir-write`

**拦什么。** `write`/`edit` 写进 `%SystemRoot%`(例如 `System32`)。

**为什么拦。** 系统服务和驱动会加载这些文件;改错一个可能让机器起不来。

**本来会改什么。** 系统二进制/配置/驱动,下次启动或服务重启时生效。

**风险。** 签名校验可能拒绝加载;覆盖正在使用的文件会失败或蓝屏;系统更新可能把它冲掉。

**手动做。** 确认厂商文档点名了这个文件;先备份
(`Copy-Item <目标> <目标>.bak -Force`);重启后用 `sfc /scannow` 或
`DISM /Online /Cleanup-Image /RestoreHealth` 校验。

**回滚。** 还原 `.bak`;没有备份就先 `sfc /scannow`,再 DISM。

**更安全。** 优先官方安装包 / Windows Update / 设置界面。

---

## `startup-write`

**拦什么。** `write`/`edit` 写进当前用户的启动文件夹。

**为什么拦。** 启动文件夹是持久化位置;放进去的程序每次登录都会运行。

**本来会改什么。** 新增一个登录时自动启动的程序。

**风险。** 不是你本意的长期驻留;登录变慢或弹错。

**手动做。** 打开 `shell:startup`,放**快捷方式**(不是脚本本体),在任务管理器“启动”页确认。

**回滚。** 删除 `.lnk`,或在任务管理器“启动”页禁用。

**更安全。** 定时/条件启动用任务计划程序,或用应用自己的“开机启动”开关。
