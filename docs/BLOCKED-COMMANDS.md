# When jev-guard blocks a command

This page is for the person holding the keyboard, not for the model. A block is
not a dead end: every rule below explains **why** it fired, **what the command
would change**, **what can go wrong**, **how to do it by hand outside DSH** and
**how to undo it**. The same text is available in the terminal, in the current
language:

```sh
node bin/guard.mjs explain <rule-id>
```

Read that output before copying anything from this page. These steps bypass the
guard on purpose; they do not make the action safe, and some effects (a cleared
event log, a wiped disk) cannot be undone at all.

## What a block looks like

- The tool call is refused; the command does not run.
- The reason names the rule id and points at `guard explain <id>`.
- A deny from L0 **cannot** be overridden by a one-shot `guard allow` token. Only
  a human editing the rule can change that — deliberately.
- During a judging-service outage, `never` (danger-full-access) sessions also
  deny non-read-only commands; `ask` sessions still see the usual prompt.

### What the guard does after a block

- **Irreversible rules** (marked below, plus older hard-deny rules with no
  playbook): the next step gets a "stop" message telling the model not to retry
  or rephrase, to explain the block, and to leave the choice to you.
- **Reversible rules**: the task is not interrupted. At the end of the turn a
  single reminder lists what was blocked with the `guard explain` pointer, so
  the model can put it in its final answer.
- Both kinds are written into the session history, so you can read them later.
  They are **strong hints, not a hard pause** — only approval mode (`ask`)
  actually stops and waits for your click.

## The rules

| Rule | Blocks | Irreversible? |
| --- | --- | --- |
| `hosts-overwrite` | writing `/etc/hosts` or `...\drivers\etc\hosts` | no (backup first) |
| `root-cert-import` | adding a root certificate to the machine store | mostly (removal possible) |
| `firewall-off` | disabling Windows Firewall profiles | no |
| `eventlog-security-clear` | clearing the Security event log | **yes** |
| `defender-disable` | disabling real-time protection / adding exclusions | no |
| `uninstall-security-product` | uninstalling AV/EDR | reinstall needed |
| `guard-home-write` | writing jev-guard's own state directory | no (backup first) |
| `system-hosts-write` | `write`/`edit` targeting the system hosts file | no (backup first) |
| `windows-dir-write` | `write`/`edit` inside `%SystemRoot%` | repair possible |
| `startup-write` | `write`/`edit` inside the Startup folder | no |

---

## `hosts-overwrite`

**What it catches.** A shell command that writes the system hosts file
(`Set-Content`/`Add-Content`/`Out-File`, or `echo`/`type`/`tee` redirected into
`/etc/hosts` or `C:\Windows\System32\drivers\etc\hosts`). Reading the file is
fine.

**Why blocked.** hosts wins over DNS; a single wrong line can silently point a
name — including update or security domains — somewhere else.

**What it would change.** The machine's name table for every program.

**Risks.** Broken updates/sign-in; a redirected security domain hiding the real
fault; the change outliving the experiment.

**By hand (PowerShell, outside DSH).**

1. `Copy-Item "$env:SystemRoot\System32\drivers\etc\hosts" "$env:SystemRoot\System32\drivers\etc\hosts.bak" -Force`
2. `Start-Process notepad -Verb RunAs "$env:SystemRoot\System32\drivers\etc\hosts"`
3. Add only the line you need (`IP hostname`), save, then `ipconfig /flushdns`.
4. On POSIX the file is `/etc/hosts`; flush the resolver afterwards.

**Rollback.** Copy `hosts.bak` back over `hosts`, then `ipconfig /flushdns`.

**Safer.** Per-app proxy/split settings, or a local DNS override on the router.

---

## `root-cert-import`

**What it catches.** `certutil -addstore Root|AuthRoot|TrustedPublisher` and
`Import-Certificate -CertStoreLocation Cert:\LocalMachine\Root`.

**Why blocked.** A root in the machine store can vouch for any site.

**What it would change.** Every program using the system trust store starts
trusting certificates signed by that root.

**Risks.** If the root key leaks, traffic can be intercepted; corporate proxies
do this on purpose, personal machines usually should not.

**By hand.**

1. Verify the thumbprint against a trusted channel:
   `Get-FileHash <cert> -Algorithm SHA256`.
2. Only if it matches, as administrator:
   `Import-Certificate -FilePath <cert> -CertStoreLocation Cert:\LocalMachine\Root`.
3. Reopen browsers afterwards.

**Rollback.** Find it by thumbprint under `Cert:\LocalMachine\Root`, confirm,
then `Remove-Item` (or delete it in `certlm.msc`). If corporate policy requires
it, ask IT first.

**Safer.** For one app, `CurrentUser\My`; test in a VM.

---

## `firewall-off`

**What it catches.** `netsh advfirewall set *profiles state off` and
`Set-NetFirewallProfile -Enabled $false|0`.

**Why blocked.** It removes the inbound filter for every listening port.

**What it would change.** Inbound filtering stops for the chosen profiles.

**Risks.** Databases, RDP and dev servers become reachable from the same network;
domain policy may revert it and alert; public exposure can be scanned in minutes.

**By hand.** Prefer one rule:
`New-NetFirewallRule -DisplayName "dev 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow`.
If you truly need a pause: `Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled False`
and turn it back on immediately.

**Rollback.** `Set-NetFirewallProfile -All -Enabled True`, verify with
`Get-NetFirewallProfile | Select-Object Name,Enabled`, remove the temporary rule.

**Safer.** Per-program/port rules with `-RemoteAddress` limited; never disable
the Public profile.

---

## `eventlog-security-clear`

**What it catches.** `wevtutil cl Security` and
`Clear-EventLog -LogName Security`.

**Why blocked.** It destroys sign-in, privilege and audit evidence.

**What it would change.** Every event in the Security log is deleted.

**Risks.** **Irreversible** — no command restores cleared entries; during an
incident the act itself looks suspicious.

**By hand.** Archive first:
`wevtutil epl Security C:\backup\Security-$(Get-Date -Format yyyyMMdd-HHmm).evtx`,
confirm the export, and only then `wevtutil cl Security`.

**Rollback.** None for cleared events; if the goal was size, raise the limit
instead: `wevtutil sl Security /ms:<bytes>`.

**Safer.** Archive then rotate; ship security events to a central log.

---

## `defender-disable`

**What it catches.** `Set-MpPreference -DisableRealtimeMonitoring $true` and
`Add-MpPreference -Exclusion*` / `Set-MpPreference -Exclusion*`.

**Why blocked.** Exclusions are a common malware trick; disabling real-time
protection removes the last automatic check.

**What it would change.** Scanning stops for the machine, or for the excluded
path/extension/process — and can survive a reboot.

**Risks.** Malware runs unchecked; excluding a drive is effectively permanent
disablement; Tamper Protection may block the revert.

**By hand.** Exclude one directory:
`Add-MpPreference -ExclusionPath "C:\work\build"`. To pause:
`Set-MpPreference -DisableRealtimeMonitoring $true` (may be refused). Verify:
`Get-MpPreference | Select-Object DisableRealtimeMonitoring,ExclusionPath`.

**Rollback.** `Set-MpPreference -DisableRealtimeMonitoring $false`;
`Remove-MpPreference -ExclusionPath "C:\work\build"`; if policy pins it, an
administrator must revert it.

**Safer.** Build in a VM/container; report false positives to Microsoft.

---

## `uninstall-security-product`

**What it catches.** `winget uninstall`, `msiexec /x` and
`wmic ... call uninstall` naming a security product.

**Why blocked.** Defender does not always take over automatically; the machine
can end up with no real-time protection.

**What it would change.** The product's service, drivers and tray app are removed.

**Risks.** Unprotected window; leftover filter drivers can break networking or
cause a BSOD; reinstalling needs the licence/admin rights.

**By hand.** Use the vendor uninstaller (Settings > Apps or the vendor tool);
install the replacement first and confirm it registered, then remove the old one.
Check with
`Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct`.

**Rollback.** Reinstall from the official installer; confirm
`Get-Service WinDefend` is running; remove a broken filter driver in Device
Manager and reboot.

**Safer.** Validate the swap in a lab/VM; never leave production unprotected.

---

## `guard-home-write`

**What it catches.** `write`/`edit` into jev-guard's own state directory
(`~/.jev-guard`, or the path in `JEV_GUARD_ALLOW_FILE`).

**Why blocked.** That directory holds `allow.txt`, `config.json` and
`secrets.json`; writing it can pre-authorise commands or replace the key.

**What it would change.** Tokens, thresholds/policy, or the judging key.

**Risks.** A malformed `allow.txt` permanently allows a command; broken
`config.json` stops the plugin; a key pasted into a file can leak.

**By hand.** Use the CLI, not a hand-written file:
`node bin/guard.mjs allow "<command>"`, `allow --list`. Back up config first:
`Copy-Item "$HOME\.jev-guard\config.json" "$HOME\.jev-guard\config.json.bak" -Force`,
edit in Notepad, then `node bin/guard.mjs status`. Enter the key only via
`node bin/guard.mjs key set`.

**Rollback.** Restore the `.bak` and run `status`; revoke a token with
`allow --revoke <token>`; rotate a leaked key in the provider console.

**Safer.** CLI subcommands over hand-editing; back up and run `status`.

---

## `system-hosts-write`

**What it catches.** `write`/`edit` whose `file_path` is the system hosts file.

**Why blocked / changes / risks.** Same as `hosts-overwrite`.

**By hand.** Back up, edit as administrator, `ipconfig /flushdns`.

**Rollback.** Restore the backup, flush DNS.

**Safer.** Per-app proxy or local DNS.

---

## `windows-dir-write`

**What it catches.** `write`/`edit` inside `%SystemRoot%` (for example
`System32`).

**Why blocked.** Services and drivers load those files; one wrong edit can make
the machine unbootable.

**What it would change.** A system binary/config/driver, effective on next boot
or service restart.

**Risks.** Signature checks may refuse it; overwriting an in-use file fails or
BSODs; Windows Update may overwrite it.

**By hand.** Confirm the vendor document names this file; back it up
(`Copy-Item <target> <target>.bak -Force`); reboot and verify with
`sfc /scannow` or `DISM /Online /Cleanup-Image /RestoreHealth`.

**Rollback.** Restore the `.bak`; otherwise `sfc /scannow`, then DISM.

**Safer.** Official installer / Windows Update / Settings UI.

---

## `startup-write`

**What it catches.** `write`/`edit` inside the per-user Startup folder.

**Why blocked.** Startup is a persistence location; malware placed there runs at
every sign-in.

**What it would change.** A new program starts automatically at sign-in.

**Risks.** Long-term persistence for something you did not intend; slower or
error-prone sign-in.

**By hand.** Open `shell:startup`, put a *shortcut* there (not the script), and
confirm it in Task Manager > Startup.

**Rollback.** Delete the `.lnk` or disable it in Task Manager > Startup.

**Safer.** Task Scheduler for scheduled/conditional runs, or the app's own
autostart toggle.
