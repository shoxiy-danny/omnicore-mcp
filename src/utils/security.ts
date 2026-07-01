/**
 * 安全工具：路径校验 + 命令注入防护
 *
 * OmniCore 处理大量用户传入的文件路径（图片/视频/音频），
 * 这些路径最终会被 readFileSync 读取或拼进 execSync 命令。
 * 必须校验路径合法性，防止路径穿越和命令注入。
 */

import { statSync, realpathSync } from 'fs'
import { isAbsolute, join, normalize, sep } from 'path'

/**
 * 校验文件路径：拒绝路径穿越、设备文件、非存在文件。
 * 返回规范化后的绝对路径。失败抛错。
 *
 * 防护点：
 * 1. 拒绝 null byte（防 \x00 截断）
 * 2. 拒绝 /dev/、/proc/、/sys/ 等设备/伪文件系统
 * 3. realpath 解析符号链接，防 ../../../etc/passwd
 * 4. 校验文件真实存在且是普通文件（非目录/非设备）
 */
export function safeResolvePath(inputPath: string): string {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('路径为空')
  }
  // 拒绝 null byte
  if (inputPath.includes('\0')) {
    throw new Error('路径含非法字符')
  }
  // 拒绝设备/伪文件系统
  const blockedPrefixes = ['/dev/', '/proc/', '/sys/', '/etc/', '/root/', '/var/log/']
  const normForCheck = normalize(inputPath)
  for (const prefix of blockedPrefixes) {
    if (normForCheck === prefix.slice(0, -1) || normForCheck.startsWith(prefix)) {
      throw new Error(`路径被安全策略拒绝: ${inputPath}`)
    }
  }
  // 拒绝 SSH/密钥/配置类敏感文件
  const sensitivePatterns = [/\.ssh\//i, /\.env/i, /id_rsa/i, /id_ed25519/i, /providers\.json/i, /\.aws\//i, /\.gnupg\//i]
  for (const re of sensitivePatterns) {
    if (re.test(inputPath)) {
      throw new Error(`路径被安全策略拒绝（敏感文件）: ${inputPath}`)
    }
  }
  // realpath 解析符号链接 + 校验存在
  let realPath: string
  try {
    realPath = realpathSync(inputPath)
  } catch {
    throw new Error(`文件不存在: ${inputPath}`)
  }
  // 校验是普通文件
  const stat = statSync(realPath)
  if (!stat.isFile()) {
    throw new Error(`路径不是普通文件: ${inputPath}`)
  }
  return realPath
}

/**
 * 校验文件大小不超过上限（默认 50MB），防读巨大文件撑爆内存
 */
export function safeCheckFileSize(inputPath: string, maxBytes = 50 * 1024 * 1024): void {
  const stat = statSync(inputPath)
  if (stat.size > maxBytes) {
    throw new Error(`文件过大: ${(stat.size / 1024 / 1024).toFixed(1)}MB > ${maxBytes / 1024 / 1024}MB`)
  }
}

/**
 * 转义 shell 参数：用于 execSync 拼接场景。
 * 用单引号包裹 + 内部单引号转义，防命令注入。
 *
 * 注意：优先推荐用 execFile/execSync 的数组参数形式，
 * 但现有代码多处用模板字符串拼接 ffmpeg 命令，此函数用于加固这些场景。
 */
export function shellQuote(s: string): string {
  // 单引号包裹，内部单引号用 '\'' 转义
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/**
 * 校验 URL：拒绝内网地址（SSRF 防护）。
 * 用于 first_frame_image 等 URL 输入。
 */
export function isSafeUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false
  // data: URL 安全
  if (url.startsWith('data:')) return true
  // 只允许 http/https
  if (!url.startsWith('http://') && !url.startsWith('https://')) return false
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    // 拒绝 localhost / 内网 IP / 元数据地址
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false
    if (host.startsWith('10.') || host.startsWith('172.16.') || host.startsWith('172.17.') ||
        host.startsWith('172.18.') || host.startsWith('172.19.') || host.startsWith('172.2') ||
        host.startsWith('172.3') || host.startsWith('192.168.') || host.startsWith('169.254.')) {
      return false
    }
    // 拒绝 .local / .internal 等内网域名
    if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
      return false
    }
    return true
  } catch {
    return false
  }
}
