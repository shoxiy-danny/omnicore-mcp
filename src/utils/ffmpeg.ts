import { execSync } from 'child_process'
import { unlinkSync, renameSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { shellQuote, safeResolvePath } from './security.js'

/**
 * ffmpeg 绝对路径。
 * 注意：bun 的 execSync 使用进程启动时的环境快照，运行时改 process.env.PATH 不生效，
 * 必须用绝对路径才能保证找到 ~/.local/bin/ffmpeg。
 */
export const FFMPEG_BIN = join(homedir(), '.local', 'bin', 'ffmpeg')

/** ffprobe 与 ffmpeg 同目录，同样必须是绝对路径 */
export const FFPROBE_BIN = join(homedir(), '.local', 'bin', 'ffprobe')

/**
 * 用 ffmpeg 将音频文件转为指定格式
 */
export function convertAudio(inputPath: string, outputPath: string, opts: { ar?: string; ac?: string; codec?: string; bitrate?: string } = {}): void {
  const { ar = '16000', ac = '1', codec = 'libopus', bitrate = '32k' } = opts
  // 路径校验 + shellQuote 防命令注入
  const safeInput = shellQuote(safeResolvePath(inputPath))
  const safeOutput = shellQuote(outputPath)
  execSync(`${FFMPEG_BIN} -y -i ${safeInput} -c:a ${codec} -b:a ${bitrate} -ar ${ar} -ac ${ac} ${safeOutput} 2>/dev/null`, { timeout: 30000 })
}

/**
 * 将视频转成飞书/移动端更友好的 MP4：
 * H.264 baseline + yuv420p + AAC + faststart。
 * 成功则原地覆盖 inputPath；失败抛错（调用方可忽略）。
 */
export function remuxVideoForFeishu(inputPath: string): void {
  const safeInputPath = safeResolvePath(inputPath)
  const tmpPath = `${safeInputPath}.feishu.tmp.mp4`
  const safeInput = shellQuote(safeInputPath)
  const safeTmp = shellQuote(tmpPath)
  // -map 0:v:0 只要第一路视频；无音轨时用 anullsrc 补静音 AAC
  // baseline + level 3.1 兼容飞书/微信内嵌播放
  const cmd = [
    FFMPEG_BIN,
    '-y',
    `-i ${safeInput}`,
    '-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100',
    '-filter_complex "[0:v:0]format=yuv420p[v]"',
    '-map "[v]" -map 1:a:0',
    '-c:v libx264 -profile:v baseline -level 3.1 -pix_fmt yuv420p',
    '-c:a aac -b:a 128k -shortest',
    '-movflags +faststart',
    safeTmp,
    '2>/dev/null',
  ].join(' ')
  execSync(cmd, { timeout: 120_000 })
  if (!existsSync(tmpPath)) throw new Error('ffmpeg 未产出临时文件')
  renameSync(tmpPath, safeInputPath)
}

/**
 * 临时文件清理
 */
export function cleanupFiles(...paths: string[]): void {
  for (const p of paths) {
    try { unlinkSync(p) } catch {}
  }
}
