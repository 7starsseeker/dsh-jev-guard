/**
 * 机器本地状态放在哪 —— 一个地方决定,别的模块只许调这里。
 *
 * 为什么要有这个模块(0.5.8):`config.json` / `secrets.json` 原先是**从包根读**的。
 * 用 `npm i` / `dsh plugin update` 装的包,更新是**整包替换** —— 按文档放进
 * `node_modules/jev-guard/config.json` 的那份设置,会在下一次更新时连同包一起消失。
 * 这两个文件又都不在 `files` 白名单里(发布物不该夹带本机状态),所以"装完再手工造一份"
 * 本来就是唯一姿势,更新一次就得重来一次。
 *
 * 现在默认落在 `JEV_GUARD_HOME`(默认 `~/.jev-guard`),与 `guard.log` / `allow.txt` /
 * `degraded.json` 同目录:那几样早就是包外的,只有配置文件当时没跟着走。
 *
 * 解析顺序(读与写**共用同一个函数**,不允许各写一份 —— 分叉的后果是"写得进去却读不出来"):
 *   1. 显式指定:环境变量 `JEV_GUARD_CONFIG` / `JEV_GUARD_SECRETS`,或配置里的 `apiKeyFile`
 *   2. 用户目录里**已存在**的那份(从旧版升级上来的机器,第一次跑就命中)
 *   3. 包根的旧位置(向后兼容:开发仓、`link:` 安装、以及尚未迁移的机器)
 *   4. 都没有 → 返回用户目录路径(写入落在这里,下次更新不会丢)
 *
 * @module jev-guard/paths
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** 本地状态目录;`JEV_GUARD_HOME` 可覆盖(测试/多实例用)。 */
export const HOME_DIR = process.env.JEV_GUARD_HOME ?? join(homedir(), '.jev-guard')

/** 用户目录里的配置文件名。 */
export const CONFIG_NAME = 'config.json'

/** 用户目录里的密钥文件名。 */
export const SECRETS_NAME = 'secrets.json'

/**
 * 环境变量里显式给的路径;空串视同未设置(否则 `JEV_GUARD_CONFIG=` 会把所有配置读空)。
 *
 * @param name - variable name.
 * @returns an absolute path, or undefined.
 */
function explicitPath(name) {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() !== '' ? resolve(value.trim()) : undefined
}

/**
 * 两份候选按"用户目录优先、包根兜底"选择:**存在者优先**,都不存在时给用户目录。
 *
 * @param userPath - the package-external path.
 * @param legacyPath - the old in-package path.
 * @returns which file to use.
 */
function preferExisting(userPath, legacyPath) {
  if (existsSync(userPath)) return userPath
  if (existsSync(legacyPath)) return legacyPath
  return userPath
}

/**
 * `config.json` 的实际路径。
 *
 * @param pkgRoot - package root (used only for the legacy fallback).
 * @returns absolute path to read from and to write to.
 */
export function configFilePath(pkgRoot) {
  return explicitPath('JEV_GUARD_CONFIG')
    ?? preferExisting(join(HOME_DIR, CONFIG_NAME), join(pkgRoot, CONFIG_NAME))
}

/**
 * 密钥文件的实际路径 —— **读取与写入共用这一个函数**(CLI 与 DSH 适配器都调它)。
 *
 * `apiKeyFile` 给相对路径时,语义仍是"按**包根**解析,与 cwd 无关":那是已有文档与既有
 * 安装的行为,改掉会让"在包目录外调用"重新变成读不到密钥的老问题。只有**缺省**时
 * 才走包外目录。
 *
 * @param cfg - effective config (may carry `apiKeyFile`).
 * @param pkgRoot - package root.
 * @returns absolute path to the secrets file.
 */
export function keyFilePath(cfg, pkgRoot) {
  const configured = typeof cfg?.apiKeyFile === 'string' && cfg.apiKeyFile.trim() !== ''
    ? cfg.apiKeyFile.trim()
    : undefined
  if (configured !== undefined) return isAbsolute(configured) ? configured : join(pkgRoot, configured)
  return explicitPath('JEV_GUARD_SECRETS')
    ?? preferExisting(join(HOME_DIR, SECRETS_NAME), join(pkgRoot, SECRETS_NAME))
}
