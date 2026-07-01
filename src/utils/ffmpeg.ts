import { execSync } from 'child_process'
import { unlinkSync } from 'fs'
import { shellQuote, safeResolvePath } from './security.js'

/**
 * 用 ffmpeg 将音频文件转为指定格式
 */
export function convertAudio(inputPath: string, outputPath: string, opts: { ar?: string; ac?: string; codec?: string; bitrate?: string } = {}): void {
  const { ar = '16000', ac = '1', codec = 'libopus', bitrate = '32k' } = opts
  // 路径校验 + shellQuote 防命令注入
  const safeInput = shellQuote(safeResolvePath(inputPath))
  const safeOutput = shellQuote(outputPath)
  execSync(`ffmpeg -y -i ${safeInput} -c:a ${codec} -b:a ${bitrate} -ar ${ar} -ac ${ac} ${safeOutput} 2>/dev/null`, { timeout: 30000 })
}

/**
 * 临时文件清理
 */
export function cleanupFiles(...paths: string[]): void {
  for (const p of paths) {
    try { unlinkSync(p) } catch {}
  }
}
