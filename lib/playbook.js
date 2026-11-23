/**
 * Per-rule "what now?" playbooks for rules that **hard-block**.
 *
 * Why this exists: a deny without a next step is a dead end, and a dead end
 * invites blind workarounds. Every entry says, in plain language for someone
 * who has never used a terminal:
 *
 *   - why the rule exists (what the command would change),
 *   - what can go wrong,
 *   - how to do the same thing **by hand, outside DSH**, after reading the risks,
 *   - how to undo it,
 *   - and a safer alternative when one exists.
 *
 * The text is deliberately concrete and Windows-first (this machine), but the
 * POSIX forms are mentioned where they differ. It is shown by
 * `node bin/guard.mjs explain <id>` and referenced from deny reasons.
 *
 * Boundary: these are accident-net rules, not a security boundary (D1). The
 * manual steps bypass jev-guard on purpose; they do not make the underlying
 * action safe, and they cannot restore what is genuinely irreversible
 * (a cleared event log, a wiped disk).
 */

/** @typedef {{ zh: string, en: string }} Bilingual */
/** @typedef {{ title: Bilingual, why: Bilingual, changes: Bilingual, risks: Bilingual, manual: { zh: string[], en: string[] }, rollback: { zh: string[], en: string[] }, safer: Bilingual }} PlaybookEntry */

/** @type {Record<string, PlaybookEntry>} */
export const PLAYBOOK = Object.freeze({
  'hosts-overwrite': {
    title: { zh: '覆盖系统 hosts 文件', en: 'Overwrite the system hosts file' },
    why: {
      zh: 'hosts 文件把域名直接映射到 IP,优先级高于 DNS。改写它可以悄悄把任何网站指到别处。',
      en: 'The hosts file maps names to IPs and wins over DNS. Editing it can silently point any site somewhere else.',
    },
    changes: {
      zh: '把某个域名在本机解析到指定 IP;常见用途是屏蔽广告或做本地开发,常见事故是打错一个字符后所有相关域名失效。',
      en: 'Makes this machine resolve a name to a chosen IP. Common legitimate uses are ad-blocking and local development; a single typo can break every name in the file.',
    },
    risks: {
      zh: '打错会让更新、登录、证书校验失败;把安全软件/更新域名指向别处会掩盖真实问题;忘了改回来时,故障会一直存在。',
      en: 'A typo breaks updates, sign-in and certificate checks; redirecting security or update domains hides the real problem; if you forget to revert, the fault persists.',
    },
    manual: {
      zh: [
        '先备份:在普通 PowerShell 里运行 Copy-Item "$env:SystemRoot\\System32\\drivers\\etc\\hosts" "$env:SystemRoot\\System32\\drivers\\etc\\hosts.bak" -Force',
        '以管理员身份打开记事本:Start-Process notepad -Verb RunAs "$env:SystemRoot\\System32\\drivers\\etc\\hosts"',
        '只添加你确实需要的那一行(格式:IP 空格 域名),保存后运行 ipconfig /flushdns 让缓存失效。',
        'POSIX 上是 /etc/hosts,编辑后同样需要清缓存(systemd-resolved 用 resolvectl flush-caches)。',
      ],
      en: [
        'Back it up first: Copy-Item "$env:SystemRoot\\System32\\drivers\\etc\\hosts" "$env:SystemRoot\\System32\\drivers\\etc\\hosts.bak" -Force',
        'Open Notepad as administrator: Start-Process notepad -Verb RunAs "$env:SystemRoot\\System32\\drivers\\etc\\hosts"',
        'Add only the line you actually need (format: IP, space, hostname), save, then run ipconfig /flushdns.',
        'On POSIX the file is /etc/hosts; flush the resolver cache afterwards (resolvectl flush-caches on systemd-resolved).',
      ],
    },
    rollback: {
      zh: [
        '还原备份:Copy-Item "$env:SystemRoot\\System32\\drivers\\etc\\hosts.bak" "$env:SystemRoot\\System32\\drivers\\etc\\hosts" -Force',
        '再运行 ipconfig /flushdns;确认文件末尾没有残留的测试行。',
      ],
      en: [
        'Restore the backup: Copy-Item "$env:SystemRoot\\System32\\drivers\\etc\\hosts.bak" "$env:SystemRoot\\System32\\drivers\\etc\\hosts" -Force',
        'Run ipconfig /flushdns again; check that no test lines are left at the end of the file.',
      ],
    },
    safer: {
      zh: '优先用应用的代理/分流设置,或路由器/DNS 的本地覆盖;不要改安全软件、更新服务的域名。',
      en: 'Prefer per-app proxy/split settings or a local DNS override on the router; never redirect security or update domains.',
    },
  },

  'root-cert-import': {
    title: { zh: '把根证书装进本机信任库', en: 'Install a root certificate into the machine trust store' },
    why: {
      zh: '本机信任库里的根证书可以为任意站点签发证书。装错一张,等于允许别人冒充所有 HTTPS 站点。',
      en: 'A root certificate in the machine store can vouch for any site. Installing the wrong one lets someone impersonate every HTTPS site.',
    },
    changes: {
      zh: '让所有使用系统信任库的程序(浏览器、更新器、命令行工具)信任该根证书签发的证书。',
      en: 'Makes every program that uses the system trust store (browsers, updaters, CLI tools) trust certificates signed by that root.',
    },
    risks: {
      zh: '该根证书的私钥一旦泄露,攻击者可对你的流量做中间人解密;很多企业代理会这么做,但个人机器上通常是事故。',
      en: 'If the root key leaks, an attacker can man-in-the-middle your traffic. Corporate proxies do this deliberately; on a personal machine it is usually an accident.',
    },
    manual: {
      zh: [
        '先核对证书指纹(在来源可信的渠道拿到 SHA-1/SHA-256):Get-FileHash <证书文件> -Algorithm SHA256',
        '确认指纹一致后,以管理员身份运行:Import-Certificate -FilePath <证书文件> -CertStoreLocation Cert:\\LocalMachine\\Root',
        '只在确实需要时导入;导入后关闭并重开浏览器。',
      ],
      en: [
        'Verify the thumbprint against a trusted source first: Get-FileHash <cert-file> -Algorithm SHA256',
        'Only if it matches, run as administrator: Import-Certificate -FilePath <cert-file> -CertStoreLocation Cert:\\LocalMachine\\Root',
        'Import only when truly needed; close and reopen browsers afterwards.',
      ],
    },
    rollback: {
      zh: [
        '按指纹定位:Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object Thumbprint -eq <指纹>',
        '确认是刚装的那张后删除:... | Remove-Item;也可以打开 certlm.msc,在“受信任的根证书颁发机构”里删除。',
        '删除后重开浏览器;如企业策略要求该证书,先联系 IT,不要自行删除。',
      ],
      en: [
        'Locate it by thumbprint: Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object Thumbprint -eq <thumbprint>',
        'After confirming it is the one you just added: ... | Remove-Item; or remove it in certlm.msc under Trusted Root Certification Authorities.',
        'Reopen browsers afterwards. If corporate policy requires it, ask IT before removing.',
      ],
    },
    safer: {
      zh: '只给单个应用用的证书请装到 CurrentUser\\My(而不是 LocalMachine\\Root);测试请用虚拟机。',
      en: 'For a single app, install into CurrentUser\\My instead of LocalMachine\\Root; test in a VM.',
    },
  },

  'firewall-off': {
    title: { zh: '关闭 Windows 防火墙', en: 'Turn off the Windows firewall' },
    why: {
      zh: '防火墙是入站连接的第一道过滤。整体关掉会让本机所有监听端口对局域网/公网可达。',
      en: 'The firewall filters inbound connections. Turning it off exposes every listening port to the LAN or the internet.',
    },
    changes: {
      zh: '指定配置档(Domain/Private/Public)的入站过滤停止生效;出站默认本来就不拦。',
      en: 'Inbound filtering stops for the chosen profiles (Domain/Private/Public); outbound traffic was already allowed by default.',
    },
    risks: {
      zh: '数据库、远程桌面、开发服务器等会被同网段的人直接访问;企业域策略可能把它改回来并告警;公网暴露可能几分钟内就被扫描到。',
      en: 'Databases, RDP and dev servers become reachable from the same network; domain policy may revert it and raise an alert; public exposure can be scanned within minutes.',
    },
    manual: {
      zh: [
        '先想清楚要放行哪个端口/程序,而不是关掉整个防火墙。',
        '只放行一个端口(管理员):New-NetFirewallRule -DisplayName "dev 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow',
        '确实要临时全关:Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled False,做完立刻开回来。',
      ],
      en: [
        'Decide which port or program needs access instead of disabling everything.',
        'Open one port only (admin): New-NetFirewallRule -DisplayName "dev 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow',
        'If you really must disable it temporarily: Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled False, then turn it back on immediately.',
      ],
    },
    rollback: {
      zh: [
        '重新开启全部配置档:Set-NetFirewallProfile -All -Enabled True',
        '核对状态:Get-NetFirewallProfile | Select-Object Name,Enabled',
        '删除临时放行规则:Remove-NetFirewallRule -DisplayName "dev 8080"',
      ],
      en: [
        'Re-enable all profiles: Set-NetFirewallProfile -All -Enabled True',
        'Check: Get-NetFirewallProfile | Select-Object Name,Enabled',
        'Remove the temporary allow rule: Remove-NetFirewallRule -DisplayName "dev 8080"',
      ],
    },
    safer: {
      zh: '优先按程序/端口放行,并限制 -RemoteAddress 到本机或局域网;不要在公共网络配置档上关防火墙。',
      en: 'Prefer per-program/per-port rules with -RemoteAddress limited to localhost or the LAN; never disable the Public profile.',
    },
  },

  'eventlog-security-clear': {
    irreversible: true,
    title: { zh: '清空安全日志', en: 'Clear the Security event log' },
    why: {
      zh: '安全日志记录登录、提权、审计事件;清空后这些记录无法重建,等于销毁证据。',
      en: 'The Security log records sign-ins, privilege use and audit events. Clearing it destroys evidence that cannot be rebuilt.',
    },
    changes: {
      zh: '删除 Security 日志里的全部事件;日志文件本身还在,但内容清空。',
      en: 'Deletes every event in the Security log; the log file remains but its contents are gone.',
    },
    risks: {
      zh: '不可逆 —— 没有“恢复已清空日志”的命令;合规/取证场景会直接失去依据;如果是排查入侵,清除动作本身就很可疑。',
      en: 'Irreversible: there is no command that restores cleared entries; compliance/forensics lose their basis; during an incident, clearing it looks suspicious by itself.',
    },
    manual: {
      zh: [
        '先导出留存(管理员):wevtutil epl Security C:\\backup\\Security-$(Get-Date -Format yyyyMMdd-HHmm).evtx',
        '确认导出文件能打开、大小正常,再决定是否清空。',
        '确实要清:wevtutil cl Security',
        'POSIX 上对应的是 journald/rsyslog 的日志轮转与删除,同样先归档。',
      ],
      en: [
        'Export it first (admin): wevtutil epl Security C:\\backup\\Security-$(Get-Date -Format yyyyMMdd-HHmm).evtx',
        'Confirm the export opens and has a sane size before clearing anything.',
        'Only then: wevtutil cl Security',
        'On POSIX this corresponds to journald/rsyslog rotation and deletion; archive first as well.',
      ],
    },
    rollback: {
      zh: [
        '已清空的事件无法恢复;只能从之前的导出文件导入查看。',
        '如果只是想把日志变小,改用增大上限/轮转,而不是清空:wevtutil sl Security /ms:<字节数>。',
      ],
      en: [
        'Cleared events cannot be restored; you can only read a prior export.',
        'If the goal is size, raise the limit / rotate instead of clearing: wevtutil sl Security /ms:<bytes>.',
      ],
    },
    safer: {
      zh: '先归档再轮转;安全事件应该上报到集中日志,而不是留在本机等清空。',
      en: 'Archive, then rotate; security events belong in a central log, not on the local disk waiting to be cleared.',
    },
  },

  'defender-disable': {
    title: { zh: '关闭 Defender 实时防护或添加排除项', en: 'Disable Defender real-time protection or add an exclusion' },
    why: {
      zh: '实时防护是最后一道自动拦截;排除项会让指定路径/进程完全不被扫描,常被恶意软件利用。',
      en: 'Real-time protection is the last automatic line of defence; an exclusion stops scanning a path/process entirely and is a common malware trick.',
    },
    changes: {
      zh: '实时扫描停止,或指定路径/扩展名/进程不再被检查;重启后可能仍生效,直到改回来。',
      en: 'Real-time scanning stops, or the chosen path/extension/process is no longer checked; it can survive a reboot until reverted.',
    },
    risks: {
      zh: '下载/解压的恶意文件可直接运行;排除整个盘符等于长期关防护;篡改防护(Tamper Protection)可能阻止你改回来。',
      en: 'Downloaded or unpacked malware can run unchecked; excluding a whole drive is effectively permanent disablement; Tamper Protection may block the revert.',
    },
    manual: {
      zh: [
        '优先只排除一个具体目录(管理员):Add-MpPreference -ExclusionPath "C:\\work\\build"',
        '临时关实时防护:Set-MpPreference -DisableRealtimeMonitoring $true(可能被篡改防护拒绝)。',
        '改完立刻验证:Get-MpPreference | Select-Object DisableRealtimeMonitoring,ExclusionPath',
      ],
      en: [
        'Prefer excluding one concrete directory (admin): Add-MpPreference -ExclusionPath "C:\\work\\build"',
        'To pause real-time protection: Set-MpPreference -DisableRealtimeMonitoring $true (Tamper Protection may refuse).',
        'Verify immediately: Get-MpPreference | Select-Object DisableRealtimeMonitoring,ExclusionPath',
      ],
    },
    rollback: {
      zh: [
        '恢复实时防护:Set-MpPreference -DisableRealtimeMonitoring $false',
        '删除排除项:Remove-MpPreference -ExclusionPath "C:\\work\\build"',
        '再核对 Get-MpPreference;如果设置被策略锁定,需要管理员在安全中心/组策略里改回。',
      ],
      en: [
        'Re-enable real-time protection: Set-MpPreference -DisableRealtimeMonitoring $false',
        'Remove the exclusion: Remove-MpPreference -ExclusionPath "C:\\work\\build"',
        'Check Get-MpPreference again; if policy pins the setting, an administrator must revert it in Security Center/Group Policy.',
      ],
    },
    safer: {
      zh: '把构建目录放到虚拟机/容器里跑;误报请提交给 Microsoft,而不是长期关防护。',
      en: 'Run the build in a VM/container; report false positives to Microsoft instead of disabling protection long-term.',
    },
  },

  'uninstall-security-product': {
    irreversible: true,
    title: { zh: '卸载安全防护产品', en: 'Uninstall a security product' },
    why: {
      zh: '卸载第三方杀软/EDR 后,Windows Defender 不一定自动接管;中间可能有一段完全没有防护的窗口。',
      en: 'After removing third-party AV/EDR, Windows Defender does not always take over automatically; there can be a window with no protection at all.',
    },
    changes: {
      zh: '移除该产品的服务、驱动和托盘程序;如果它是当前注册的 AV,系统会进入“无实时防护”状态。',
      en: 'Removes the product’s service, drivers and tray app; if it was the registered AV, the system ends up with no real-time protection.',
    },
    risks: {
      zh: '卸载期间和之后可能无防护;残留驱动/网络过滤层会导致断网或蓝屏;重新安装通常需要原许可证或管理员权限。',
      en: 'You may be unprotected during and after removal; leftover drivers/filter layers can break networking or cause a BSOD; reinstalling usually needs the licence or admin rights.',
    },
    manual: {
      zh: [
        '优先用产品自带卸载器(设置 > 应用 > 已安装的应用,或厂商的专用卸载工具),不要在文件系统里硬删目录。',
        '如果只是想换产品:先装新产品的兼容模式,确认接管后再卸旧的。',
        '卸载后立刻检查:Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct',
      ],
      en: [
        'Use the product’s own uninstaller (Settings > Apps, or the vendor tool); do not just delete its folder.',
        'If you are switching products, install the new one first, confirm it registered, then remove the old one.',
        'Check immediately afterwards: Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct',
      ],
    },
    rollback: {
      zh: [
        '从厂商官网重新下载安装包并安装(离线环境请提前留好安装包)。',
        '确认 Windows Defender 已接管:Get-Service WinDefend;必要时在“Windows 安全中心”里打开实时防护。',
        '如果网络被残留过滤驱动弄坏,在设备管理器里卸载该网络过滤驱动后重启。',
      ],
      en: [
        'Reinstall from the vendor’s official installer (keep an offline copy for offline machines).',
        'Confirm Defender took over: Get-Service WinDefend; enable real-time protection in Windows Security if needed.',
        'If a leftover filter driver broke networking, remove that driver in Device Manager and reboot.',
      ],
    },
    safer: {
      zh: '先在企业/虚拟机环境验证替换流程;生产机不要在没有替代防护时卸载。',
      en: 'Validate the swap in a lab/VM first; never leave a production machine without a replacement.',
    },
  },

  'guard-home-write': {
    title: { zh: '改写 jev-guard 自己的状态目录', en: 'Write into jev-guard’s own state directory' },
    why: {
      zh: '这个目录里有 allow.txt(一次性授权)、config.json(阈值)和 secrets.json(API 密钥)。能改它就能关掉阀门或偷走密钥。',
      en: 'This directory holds allow.txt (one-shot grants), config.json (thresholds) and secrets.json (the API key). Whoever can write it can disable the valve or steal the key.',
    },
    changes: {
      zh: '写入 allow.txt 会预先授权命令;改 config.json 会改阈值/策略;写 secrets.json 会替换判定服务的密钥。',
      en: 'Writing allow.txt pre-authorises commands; editing config.json changes thresholds/policy; writing secrets.json replaces the judging key.',
    },
    risks: {
      zh: '手工拼错 allow.txt 会让某条命令被永久放行;改坏 config.json 会让插件启动失败;把密钥贴进日志/仓库会泄露。',
      en: 'A malformed allow.txt can permanently allow a command; a broken config.json stops the plugin from starting; pasting the key into logs/repos leaks it.',
    },
    manual: {
      zh: [
        '一次性授权请用命令,不要手写文件(在交互式终端里):node bin/guard.mjs allow "<命令>"',
        '查看现有令牌:node bin/guard.mjs allow --list',
        '要改配置,先备份:Copy-Item "$HOME\\.jev-guard\\config.json" "$HOME\\.jev-guard\\config.json.bak" -Force',
        '再用记事本改,保存后运行 node bin/guard.mjs status 确认能读。',
        '密钥只通过 `node bin/guard.mjs key set` 从标准输入录入,不要写进文件或聊天。',
      ],
      en: [
        'For a one-shot grant use the command, not a hand-written file (interactive terminal): node bin/guard.mjs allow "<command>"',
        'List existing tokens: node bin/guard.mjs allow --list',
        'Before editing config, back it up: Copy-Item "$HOME\\.jev-guard\\config.json" "$HOME\\.jev-guard\\config.json.bak" -Force',
        'Edit it in Notepad, save, then run node bin/guard.mjs status to confirm it still parses.',
        'The key is entered only through `node bin/guard.mjs key set` from stdin; never put it in a file or chat.',
      ],
    },
    rollback: {
      zh: [
        '配置改坏:把 .bak 覆盖回去,再跑 node bin/guard.mjs status。',
        '多授了令牌:node bin/guard.mjs allow --revoke <令牌> 或从 allow.txt 删除对应行(删除前先备份)。',
        '密钥疑似泄露:立刻在服务商后台轮换密钥,再跑 node bin/guard.mjs key set 写入新密钥。',
      ],
      en: [
        'Broken config: copy the .bak back, then run node bin/guard.mjs status.',
        'Over-granted: node bin/guard.mjs allow --revoke <token>, or remove the line from allow.txt (back it up first).',
        'Key possibly leaked: rotate it in the provider console, then store the new one with node bin/guard.mjs key set.',
      ],
    },
    safer: {
      zh: '用 CLI 子命令而不是手改文件;改配置前先备份,改完跑一次 status。',
      en: 'Use the CLI subcommands instead of hand-editing; back up before editing and run status afterwards.',
    },
  },

  'system-hosts-write': {
    title: { zh: '改写系统 hosts 文件', en: 'Write the system hosts file' },
    why: {
      zh: '与 hosts-overwrite 相同:它能把域名解析指向任意 IP,而且优先于 DNS。',
      en: 'Same as hosts-overwrite: it can point names at any IP and wins over DNS.',
    },
    changes: {
      zh: '修改本机域名解析表;影响所有程序,包括更新与安全软件。',
      en: 'Changes this machine’s name table; affects every program, including updaters and security software.',
    },
    risks: {
      zh: '写错会让更新/登录失败;被指向恶意 IP 时流量会在你不知情时被接管。',
      en: 'A mistake breaks updates/sign-in; a malicious redirect takes over traffic without your knowledge.',
    },
    manual: {
      zh: [
        '先备份:Copy-Item "$env:SystemRoot\\System32\\drivers\\etc\\hosts" "$env:SystemRoot\\System32\\drivers\\etc\\hosts.bak" -Force',
        '以管理员身份用记事本打开并只改需要的那一行,保存后 ipconfig /flushdns。',
      ],
      en: [
        'Back it up: Copy-Item "$env:SystemRoot\\System32\\drivers\\etc\\hosts" "$env:SystemRoot\\System32\\drivers\\etc\\hosts.bak" -Force',
        'Open it in Notepad as administrator, change only the line you need, save, then ipconfig /flushdns.',
      ],
    },
    rollback: {
      zh: ['还原 hosts.bak 并 ipconfig /flushdns;核对没有残留行。'],
      en: ['Restore hosts.bak and run ipconfig /flushdns; check for leftover lines.'],
    },
    safer: {
      zh: '优先用应用级代理或本地 DNS;不要改安全/更新域名。',
      en: 'Prefer per-app proxies or local DNS; never redirect security/update domains.',
    },
  },

  'windows-dir-write': {
    title: { zh: '写入 Windows 系统目录', en: 'Write inside the Windows directory' },
    why: {
      zh: 'System32 等目录里的文件被系统服务和驱动直接加载;改错一个文件可能让机器起不来或功能失效。',
      en: 'Files under System32 are loaded by services and drivers; one wrong edit can make the machine unbootable or break features.',
    },
    changes: {
      zh: '替换/新增系统二进制、配置或驱动;下次启动或服务重启时生效。',
      en: 'Replaces/adds a system binary, config or driver; takes effect on the next boot or service restart.',
    },
    risks: {
      zh: '签名校验可能拒绝加载;覆盖正在使用的文件会失败或蓝屏;系统更新可能把改动冲掉或冲突。',
      en: 'Signature checks may refuse to load it; overwriting an in-use file fails or causes a BSOD; Windows Update may overwrite or conflict with it.',
    },
    manual: {
      zh: [
        '先确认这是厂商文档要求的具体文件,并记录版本/来源。',
        '备份原文件:Copy-Item <目标> <目标>.bak -Force(必要时先 takeown/icacls 取得写权限)。',
        '替换后重启,再用 sfc /scannow 或 DISM /Online /Cleanup-Image /RestoreHealth 校验系统文件。',
      ],
      en: [
        'Confirm the vendor documentation names this exact file, and record its version/source.',
        'Back up the original: Copy-Item <target> <target>.bak -Force (take ownership with takeown/icacls only if required).',
        'Reboot, then verify system files with sfc /scannow or DISM /Online /Cleanup-Image /RestoreHealth.',
      ],
    },
    rollback: {
      zh: [
        '还原备份:Copy-Item <目标>.bak <目标> -Force',
        '没有备份时用系统修复:sfc /scannow;仍不行则 DISM /Online /Cleanup-Image /RestoreHealth。',
      ],
      en: [
        'Restore the backup: Copy-Item <target>.bak <target> -Force',
        'Without a backup, repair with sfc /scannow; if that fails, DISM /Online /Cleanup-Image /RestoreHealth.',
      ],
    },
    safer: {
      zh: '优先用官方安装包/Windows Update/设置界面;不要在 System32 里手改文件。',
      en: 'Prefer the official installer/Windows Update/Settings UI; do not hand-edit files in System32.',
    },
  },

  'startup-write': {
    title: { zh: '写入启动文件夹', en: 'Write into the Startup folder' },
    why: {
      zh: '启动文件夹里的程序会在每次登录时自动运行,是持久化最常用的位置之一。',
      en: 'Programs in the Startup folder run at every sign-in; it is one of the most common persistence locations.',
    },
    changes: {
      zh: '新增一个登录时自动启动的快捷方式/脚本;对当前用户生效(或所有用户,取决于路径)。',
      en: 'Adds a shortcut/script that starts at sign-in, for the current user (or all users, depending on the path).',
    },
    risks: {
      zh: '恶意程序把自己放这里就能长期驻留;写错会让登录变慢或弹错;用户通常不会注意到新增项。',
      en: 'Malware placed here persists; a mistake slows sign-in or shows errors; users rarely notice a new entry.',
    },
    manual: {
      zh: [
        '先确认这确实是你要长期自动运行的程序,并知道它的完整路径。',
        '用资源管理器打开 shell:startup,把快捷方式放进去(不要放脚本本体)。',
        '在任务管理器的“启动”页确认它出现,并记住可以随时禁用。',
      ],
      en: [
        'Confirm this is something you want running at every sign-in, and know its full path.',
        'Open shell:startup in Explorer and put a shortcut there (not the script itself).',
        'Check Task Manager > Startup to confirm it appears, and remember it can be disabled there.',
      ],
    },
    rollback: {
      zh: [
        '删除该快捷方式:Remove-Item "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\<名称>.lnk"',
        '或在任务管理器“启动”页右键禁用;重启后确认不再运行。',
      ],
      en: [
        'Delete the shortcut: Remove-Item "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\<name>.lnk"',
        'Or disable it in Task Manager > Startup; reboot and confirm it no longer runs.',
      ],
    },
    safer: {
      zh: '需要定时/条件启动时用任务计划程序(能看见、能审计),或应用自己的“开机启动”开关。',
      en: 'For scheduled/conditional startup use Task Scheduler (visible and auditable), or the app’s own autostart toggle.',
    },
  },
})

/**
 * Look up one playbook entry.
 * @param id - rule id.
 * @returns the entry, or undefined.
 */
export function playbookFor(id) {
  return Object.hasOwn(PLAYBOOK, id) ? PLAYBOOK[id] : undefined
}
