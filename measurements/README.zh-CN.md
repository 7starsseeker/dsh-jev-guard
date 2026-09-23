# 实测件

> [English](README.md) | **简体中文**

这里是 [`docs/MEASUREMENTS.md`](../docs/MEASUREMENTS.md) 背后的原始记录。那份文档里的每一节都只引用了一次运行的汇总;这个目录放的是运行本身,所以一个数字能追回到产生它的那条命令。

它们是**证据,不是构建输入**:这里没有任何文件被自检执行、被 `lib/` 读取、或被发布到 npm。

## 1. 这里有什么

| 路径 | 是什么 | 支撑哪一节 |
|---|---|---|
| `offline-report-737.json` | 737 条命令语料,每条命令一条记录(`command` / `source` / `action` / `p` / `model` / `threshold` / `ms`)。运行配置:`threshold 0.5`,**未**补齐脚本正文 | §3 |
| `offline-report-737-inline.json` | 同 737 条命令,以 `inlineScripts: true` 重判一遍(配置 `threshold 0.6`)。多一个 `enriched` 字段,说明补了什么(脚本正文、包脚本) | §3(三分、脚本补齐一行)、§7.1 |
| `offline-report-737.md`、`offline-report-737-inline.md` | 两次运行打印出来的摘要,含被标记命令的清单 | §3 |
| `probe-scripts.json`、`probe-scripts.md` | 18 个脚本盲区用例,各判两次(只看命令行,再补齐正文) | §4 |
| `calibration-114/cases.zh.json` | 三臂校准的 40 个 case / 114 个问题 | §2 |
| `calibration-114/results.json` | 全部响应(120 条记录)与全部计分判定(342 = 3 臂 × 114) | §2 |
| `calibration-114/report.md`、`run.log`、`run2.log`、`run3.log` | 那一次运行的报告与三次运行的日志 | §2 |
| `calibration-114/run_calibration.py` | 产出它们的脚本 —— §2 的「复现」一行指向的就是它 | §2 |

## 2. 来源

这两批都是 **2026-09-20** 在维护者本机上、由当时的(v0.1.0)工具链产出的,产生地点是本仓库之外的两个工作目录。那两个目录已于 2026-09-23 归档后清理;这里的副本就是从那份归档里解出来的:

`~/dsh-workspace/backups/jev-leftovers-workspace-20260923.tar.gz`(864,371 字节,368 条)。

下面每个字节数与 sha256 都是**最初写下时**那份原始件的值 —— 十三份里有七份,入库的副本与它逐字节相同(见 §3):

| 这里的路径 | 字节 | 原始件 sha256 |
|---|---|---|
| `offline-report-737.json` | 292247 | `aac68c58d4be025fe6613a179d0efb59b4de7c143d27d606cc7442ebe091a6df` |
| `offline-report-737-inline.json` | 303418 | `f1162830cf9f1f093109e1ef74d8c9187a5a4acc8e24fdbe0916b37ed30fa12e` |
| `offline-report-737.md` | 2235 | `ee5fc99a4c68432f0241b9c5ebf6901581f47b018c30c39e5f0c7c40e8efcbfe` |
| `offline-report-737-inline.md` | 1809 | `ca2f84639ca75a41da8e31d90dddd09278576812ac896e32a22acc63e23dd525` |
| `probe-scripts.json` | 4182 | `c9f4da7de135a5a6793c45defb9fdfbd7caaa4a8873c534f3bff815698d4de63` |
| `probe-scripts.md` | 1891 | `5280624fd34677ba603c572910f3d9fbd57f9a1ba75589a7e740e324cb2e7f1f` |
| `calibration-114/cases.zh.json` | 16466 | `530924d7942ba08b8b318364d34385ea6175716d90e90b9694042ba707153578` |
| `calibration-114/results.json` | 348997 | `51c405d125d5b7e624caf8240c7d851b9cb98e76d3a5c6e60fe292d7e28793e2` |
| `calibration-114/report.md` | 2448 | `3c10659425cc7064af040b3f3ec33efbf419bc151835d7341f980e9ea21f05c4` |
| `calibration-114/run_calibration.py` | 21607 | `4f586fa2436b49c0d5a330459f7ce0dab7edd8d0d9fd9c207fd2c393c8d25315` |
| `calibration-114/run.log` | 3485 | `540f563179f9dd208895c424d0c93f821d90593eda2ad83e1616c375facabe62` |
| `calibration-114/run2.log` | 3495 | `d2dcb6ece569dda4bec3f5128ba267358782b2accf884cba6df0bf03b5ee7253` |
| `calibration-114/run3.log` | 3736 | `d3a2780a3b93ec0183a7b1722e8cd62a927f6e0228babd2a86f261430fcae0a5` |

## 3. 脱敏

737 语料是**真实的 shell 历史**:本项目诞生时那个会话日志里的 `tool/call` 条目,加上 `~/.bash_history`。它按「公开仓库该带什么」审过一遍,下面这些片段被替换。两张表是穷尽的 —— 入库文件里除它们之外没有任何改动。

| 片段 | 占位符 | 处数 | 性质 |
|---|---|---|---|
| Linux 家目录路径 | `<HOME>` | 570 | 身份 |
| 该用户名的裸出现 | `<USER>` | 78 | 身份 |
| WSL 盘挂载 | `<DRIVE_<字母>>/` | 42 | 身份 |
| Windows 用户名 | `<WINUSER>` | 6 | 身份 |
| 两个字面量掩码密钥(`sk-…`、`tvl…`,头尾可见) | `<REDACTED-KEY>` | 6 | 凭据 |
| 一个第三方提交名与它的 noreply 地址 | `<REDACTED-IDENTITY>`、`<REDACTED-EMAIL>` | 2 + 2 | 第三方 |
| 命令语料里其它 AI 工具与厂商的名字 | `<other-tool>` | 850 | 第三方工具 |

四条身份规则是可逆的(按逆规则替换即可逐字节还原原文);另外三条是单向的,其中工具名那条会把几个不同的名字合并成同一个占位符。十三份里有六份变了 —— `offline-report-737.json`、`offline-report-737-inline.json`、它们各自那份摘要、`probe-scripts.json` 与 `probe-scripts.md`;其余七份与上面的原始件逐字节相同。

**刻意保留的东西。** 项目名、容器名、DSH 生态的关键词、库名与 RFC1918 地址仍然出现,因为命令讲的就是这些 —— 一份把主题过滤掉的判定记录不再是记录。被换成 `<other-tool>` 的那些词,拿原始件一 diff 就能看见,这里不重复写出来,理由与替换它们相同。`measurements/` 不在 `package.json` 的 `files` 白名单里,所以这里的一切都进不了 npm 包;D11(「包内只说 DSH」)说的是包,而这个目录不构成对其中任何名字的支持声明。

**替换的正确性**(每条都是断言出来的):两份 JSON 仍能解析;`results` 仍是 737 条;`cfg`、`stats`、`byAction`、`bySource` 一字未变;每条记录的 `p` / `action` / `ms` / `source` / `threshold` / `model` 未变;校准那几份与原始件深度相等;把入库文件按逆规则还原,得到的正是「原始件 + 那几处单向遮蔽」。

因此被改写的命令原文**不再等于**判定时给模型看的那份文本:每条记录旁边的 `p` 与 `action` 是按原文本产出的。

还残留的 `sk-` 搜索会命中 `ui-skin`、`task-board`、`disk-usage` —— 普通词的子串,不是密钥。

## 4. 怎么自己核

```bash
# 整份语料:期望 737 与四个汇总块
node -e "const d=require('./measurements/offline-report-737.json');console.log(d.results.length,JSON.stringify(d.stats),JSON.stringify(d.byAction),JSON.stringify(d.bySource))"

# 校准逐臂:期望 114 中的 103/102/102 与置信度 0.867/0.869/0.867
node -e "const s=require('./measurements/calibration-114/results.json').scored;for(const a of ['A','B','C']){const x=s.filter(v=>v.arm===a);console.log(a,x.filter(v=>v.correct).length+'/'+x.length,(x.reduce((t,v)=>t+v.confidence,0)/x.length).toFixed(3))}"

# 不该再有身份形状的东西,且处数与 §3 一致
# 期望:<HOME> 570 / <USER> 78 / <DRIVE_ 42 / <WINUSER> 6 / <REDACTED- 10 / <other-tool> 850
node -e "const fs=require('fs'),p=require('path');const w=d=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?w(p.join(d,e.name)):[p.join(d,e.name)]);const t=w('measurements').filter(f=>!/README/.test(f)).map(f=>fs.readFileSync(f,'utf8')).join('');for(const x of ['<HOME>','<USER>','<DRIVE_','<WINUSER>','<REDACTED-','<other-tool>'])console.log(x,(t.split(x).length-1))"
```

## 5. 文档里的数字对到哪

[`docs/MEASUREMENTS.md`](../docs/MEASUREMENTS.md) §2、§3、§4 的每一个数都用这些文件重算过:

| 文档里的说法 | 用什么重算 | 重算值 |
|---|---|---|
| 确定性预筛命中 174/737 | `bySource.prefilter` | 174 |
| 真实调用 Jev 563 条 | `bySource.jev` | 563 |
| 三分 98.51% / 0.81% / 0.68% | 全 737 的 `p` 分带 0.5 / 0.7,inline 那次 | 726 / 6 / 5 |
| 延迟均值 297–301ms,P50 267ms,P95 367–405ms | 两次运行 563 次调用的 `ms` | 297 / 268 / 367 与 301 / 267 / 405 |
| `p` P50 0.01,P90 0.13,max 0.82 | 那 563 次调用 | 0.5 那次:0.01 / 0.13 / 0.82;inline 那次:0.01 / 0.14 / 0.82 |
| 「脚本补齐命中 18 条(2.4%),新增误报 0 条」 | 带非空 `enriched` 字段的记录 | 737 中的 18 条,其中跨过 0.5 向上的是 **0** 条(向下的 2 条) |
| §2 各臂准确率 90.4% / 89.5% / 89.5% | `scored`,逐臂 | 103/114、102/114、102/114 |
| §2 平均置信度 0.867 / 0.869 / 0.867 | `scored`,逐臂 | 0.867 / 0.869 / 0.867 |
| §2 配对检验 1 / 0 / 11(A vs B 与 A vs C) | `scored`,逐题配对 | 两者都是 1 / 0 / 11 |

## 6. 这些文件仍然支撑不了什么

1. **语料无法重生成。** 它取自的会话日志已经不存在;`docs/MEASUREMENTS.md` 现在这么写着,也应该继续这么写。能做的是上表这件事 —— 拿一个说法去对记录。
2. **单条记录翻带不算结论。** 两次运行判的是同样 563 条命令;451 条 `p` 完全相同,112 条有差异,平均 |Δp| = 0.0036,最大 0.150 —— 而 §14 自己测的噪声底(同一 state 问三次)是 0.015。只有比它更大的位移、或整份语料的计数,才带信息。
3. **费用是推出来的,不是测出来的。** 记录里没有 token 数;§3 的 ≈$0.011 是 563 次调用 × §1 实测的单次成本。
4. **两次运行不是受控对比。** 它们同时差两件事(`threshold` 0.5 与 0.6、以及是否补齐脚本正文),所以「补齐正文改变了什么」只在真的被补齐的那 18 条上是干净的。
