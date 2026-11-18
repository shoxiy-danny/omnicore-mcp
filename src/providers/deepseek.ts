/**
 * DeepSeek 应用 API 封装（2026-11-13 开放的全家桶独立接口）
 *
 * 工具：
 * - deepseekOcr — 文字识别 POST /v1/tools/ocr（PDF/Word/PPT/图片，按页返回）
 * - deepseekAsr — 语音转文字 POST /v1/tools/asr（16-bit PCM WAV / Ogg Opus，单次 ≤120s）
 * - deepseekTts — 文字转语音 POST /v1/tools/tts（wav/pcm，≤10000 计费字符）
 *
 * 端点：https://api.deepseek.com（可用 DEEPSEEK_BASE_URL 覆盖）
 * Key：process.env.DEEPSEEK_API_KEY（.env 统一管理，与 browser-mcp 共用一把）
 *
 * 计费（2026-11-13 官方价，限时 5 折）：
 * - OCR $0.225 / 千页（按成功页数）
 * - ASR $0.116 / 小时（限时 $0.058）
 * - TTS $0.45 / 万字符（限时 $0.225，汉字算 2 字符）
 */

import { readFileSync, statSync, readdirSync, unlinkSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join, basename } from 'path'
import { safeResolvePath } from '../utils/security.js'
import { FFMPEG_BIN, FFPROBE_BIN } from '../utils/ffmpeg.js'

const DEFAULT_BASE = 'https://api.deepseek.com'

/** ASR 服务端硬上限：单次 120 秒。留 5 秒余量做切片边界 */
const ASR_MAX_SECONDS = 115

function getKey(): string {
  const k = process.env.DEEPSEEK_API_KEY ?? ''
  if (!k) throw new Error('未找到 DeepSeek API Key（请在 .env 配置 DEEPSEEK_API_KEY）')
  return k
}

function baseUrl(): string {
  return (process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '')
}

/** 从错误响应里挖出人类可读的原因 */
async function readError(resp: Response): Promise<string> {
  let body = ''
  try {
    body = await resp.text()
  } catch {}
  try {
    const j = JSON.parse(body.trim())
    const msg = j?.error?.message || j?.message
    if (msg) return `HTTP ${resp.status}: ${msg}`
  } catch {}
  return `HTTP ${resp.status}: ${body.slice(0, 300)}`
}

// ── OCR ────────────────────────────────────────────────────────────────────

export type OcrPurpose = 'text_recognition' | 'rich_layout_recognition'

export interface OcrPage {
  index: number
  text: string
  finish_reason?: string
}

interface OcrResult {
  id?: string
  pages: OcrPage[]
  usage?: Record<string, number>
}

async function ocrRequest(buf: Buffer, filename: string, purpose: OcrPurpose): Promise<OcrResult> {
  const form = new FormData()
  form.append('purpose', purpose)
  form.append('file', new Blob([new Uint8Array(buf)]), filename)

  const resp = await fetch(`${baseUrl()}/v1/tools/ocr`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getKey()}` },
    body: form,
    signal: AbortSignal.timeout(210_000),
  })

  // 识别已经开始（200）后失败，错误对象会包在 body 里而不是 HTTP 状态
  const raw = (await resp.text()).trim()
  if (!resp.ok) {
    let msg = ''
    try { msg = JSON.parse(raw)?.error?.message || '' } catch {}
    throw new Error(`DeepSeek OCR 失败，HTTP ${resp.status}: ${msg || raw.slice(0, 300)}`)
  }

  let json: any
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`DeepSeek OCR 返回无法解析: ${raw.slice(0, 300)}`)
  }
  if (json?.error) throw new Error(`DeepSeek OCR 失败: ${json.error.message || JSON.stringify(json.error)}`)
  if (!Array.isArray(json?.pages)) throw new Error(`DeepSeek OCR 返回缺少 pages: ${raw.slice(0, 300)}`)

  return { id: json.id, pages: json.pages, usage: json.usage }
}

/** 自动重试补页的页数上限：大文档重试整份等于双倍页数费用，不干 */
const PATCH_MAX_PAGES = 30

function totalChars(r: OcrResult): number {
  return r.pages.reduce((n, p) => n + (p.text?.trim().length ?? 0), 0)
}

function emptyPageIndexes(r: OcrResult): number[] {
  return r.pages.filter(p => !p.text?.trim()).map(p => p.index)
}

/** 两次识别按页合并，每页取有内容的/更长的那个 */
function mergePages(a: OcrResult, b: OcrResult): OcrResult {
  const len = Math.max(a.pages.length, b.pages.length)
  const pages: OcrPage[] = []
  for (let i = 0; i < len; i++) {
    const pa = a.pages[i]
    const pb = b.pages[i]
    const ta = pa?.text?.trim() ?? ''
    const tb = pb?.text?.trim() ?? ''
    const pick = tb.length > ta.length ? pb : pa
    if (pick) pages.push(pick)
  }
  return { id: a.id, pages, usage: a.usage }
}

/**
 * 文字识别。按页返回，purpose=rich_layout_recognition 时页内带
 * <｜ref｜>…<｜/ref｜><｜box｜>[[x1,y1,x2,y2]]<｜/box｜> 坐标（0-1000 归一化）。
 *
 * 限制：单文件 ≤100MiB、≤1000 页、总时长 180s；账号最多 15 个识别并发。
 *
 * 实测两个静默失败（HTTP 200、无 error、finish_reason=stop，只能靠看正文发现）：
 * 1. 偶发整份返回空正文；
 * 2. 偶发丢单页（2 页 PDF 实测四次里中过一次）。
 * 处理：整份空 → 重试一次；有丢页且页数 ≤PATCH_MAX_PAGES → 重试一次并按页合并。
 * 大文档丢页不重试，交给调用方看「（本页未识别出文字）」标记自己决定。
 */
export async function deepseekOcr(
  filePath: string,
  purpose: OcrPurpose = 'text_recognition',
): Promise<OcrResult & { retried: number }> {
  if (purpose !== 'text_recognition' && purpose !== 'rich_layout_recognition') {
    throw new Error(`未知 purpose: ${purpose}（可选 text_recognition / rich_layout_recognition）`)
  }
  const safePath = safeResolvePath(filePath)
  const size = statSync(safePath).size
  if (size > 100 * 1024 * 1024) {
    throw new Error(`文件 ${(size / 1024 / 1024).toFixed(1)}MB 超过 OCR 100MiB 上限`)
  }

  const buf = readFileSync(safePath)
  const filename = basename(safePath)

  let best = await ocrRequest(buf, filename, purpose)
  let retried = 0

  // 1) 整份空：一定重试一次。不重试就等于白付一趟钱。
  if (totalChars(best) === 0) {
    retried++
    process.stderr.write('[omnicore] DeepSeek OCR 返回空正文，重试\n')
    const next = await ocrRequest(buf, filename, purpose).catch(() => undefined)
    if (next && totalChars(next) > 0) best = next
  }

  // 2) 有丢页：小文档补页，最多再补 2 次（实测会连续丢同一页，补一次不够）
  if (totalChars(best) > 0 && best.pages.length <= PATCH_MAX_PAGES) {
    while (emptyPageIndexes(best).length > 0 && retried < 3) {
      retried++
      const missing = emptyPageIndexes(best).map(i => i + 1).join('/')
      process.stderr.write(`[omnicore] DeepSeek OCR 第 ${missing} 页为空，补页重试 ${retried}\n`)
      const next = await ocrRequest(buf, filename, purpose).catch((e: any) => {
        process.stderr.write(`[omnicore] OCR 补页失败: ${e.message}\n`)
        return undefined
      })
      if (!next) break
      best = mergePages(best, next)
    }
  }

  // 仍整份空：报错，绝不把空字符串当结果返回
  if (totalChars(best) === 0) {
    throw new Error(
      `DeepSeek OCR 连续 ${retried + 1} 次返回空正文（page_count=${best.pages.length}）：`
      + '可能是服务端偶发异常，也可能是文件里确实没有可识别的文字。稍后重试一次；图片可改用 image_describe 看一眼。',
    )
  }

  return { ...best, retried }
}

/** 去掉 <｜ref｜>类型<｜/ref｜><｜box｜>[[…]]<｜/box｜>，只留正文 */
export function stripOcrGeometry(text: string): string {
  return text
    .replace(/<\uFF5Cref\uFF5C>[\s\S]*?<\uFF5C\/ref\uFF5C>/g, '')
    // box 后面常跟一个空格，一起吃掉，否则每行开头留个空
    .replace(/<\uFF5Cbox\uFF5C>[\s\S]*?<\uFF5C\/box\uFF5C>[ \t]?/g, '')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

// ── ASR ────────────────────────────────────────────────────────────────────

/** 读音频时长（秒）；读不到返回 0 */
function probeDuration(path: string): number {
  try {
    const out = execFileSync(FFPROBE_BIN, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      path,
    ], { timeout: 30_000 }).toString().trim()
    const d = Number(out)
    return Number.isFinite(d) && d > 0 ? d : 0
  } catch {
    return 0
  }
}

/**
 * 把任意音频转成 DeepSeek ASR 要求的 16-bit PCM WAV（16kHz 单声道）。
 */
function toPcmWav(src: string, dst: string): void {
  execFileSync(FFMPEG_BIN, [
    '-y', '-i', src,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    dst,
  ], { timeout: 180_000, stdio: 'ignore' })
}

async function asrOnce(wavPath: string): Promise<{ text: string; duration_ms?: number }> {
  const buf = readFileSync(wavPath)
  if (buf.length > 8 * 1024 * 1024) {
    throw new Error(`音频 ${(buf.length / 1024 / 1024).toFixed(1)}MB 超过 ASR 8MiB 上限`)
  }
  const form = new FormData()
  form.append('file', new Blob([buf]), basename(wavPath))

  const resp = await fetch(`${baseUrl()}/v1/tools/asr`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getKey()}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  })
  if (!resp.ok) throw new Error(`DeepSeek ASR 失败，${await readError(resp)}`)
  const json = await resp.json() as any
  if (json?.error) throw new Error(`DeepSeek ASR 失败: ${json.error.message || JSON.stringify(json.error)}`)
  return { text: String(json.text ?? ''), duration_ms: json.duration_ms }
}

/**
 * 语音转文字。
 *
 * 服务端只收 16-bit PCM WAV / Ogg Opus，单次时长 ≤120s，所以这里统一先转
 * 16kHz 单声道 PCM WAV，超过 115 秒就切片逐段识别再拼接。
 */
export async function deepseekAsr(
  filePath: string,
): Promise<{ text: string; duration_ms?: number; segments: number }> {
  getKey() // 缺 key 直接失败，别等 ffmpeg 转完才炸
  const safePath = safeResolvePath(filePath)

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const wavPath = join(tmpdir(), `ds_asr_${stamp}.wav`)
  const cleanup: string[] = [wavPath]

  try {
    toPcmWav(safePath, wavPath)
    const total = probeDuration(wavPath)

    if (total <= ASR_MAX_SECONDS) {
      const r = await asrOnce(wavPath)
      return { ...r, segments: 1 }
    }

    // 超过 120s：切片。segment muxer 对 PCM 可以 -c copy
    const segPattern = join(tmpdir(), `ds_asr_${stamp}_%03d.wav`)
    execFileSync(FFMPEG_BIN, [
      '-y', '-i', wavPath,
      '-f', 'segment', '-segment_time', String(ASR_MAX_SECONDS), '-c', 'copy',
      segPattern,
    ], { timeout: 180_000, stdio: 'ignore' })

    const prefix = `ds_asr_${stamp}_`
    const segs = readdirSync(tmpdir())
      .filter(f => f.startsWith(prefix) && f.endsWith('.wav'))
      .sort()
    if (!segs.length) throw new Error('音频切片失败，未产出分段文件')

    const parts: string[] = []
    let ms = 0
    for (const seg of segs) {
      const p = join(tmpdir(), seg)
      cleanup.push(p)
      const r = await asrOnce(p)
      if (r.text) parts.push(r.text)
      ms += r.duration_ms ?? 0
    }
    return { text: parts.join('\n'), duration_ms: ms || Math.round(total * 1000), segments: segs.length }
  } finally {
    for (const p of cleanup) {
      try { unlinkSync(p) } catch {}
    }
  }
}

// ── TTS ────────────────────────────────────────────────────────────────────

export type DsTtsFormat = 'wav' | 'pcm'

/** 音色只有两个：stella（女声，默认）/ tide（男声） */
export const DS_TTS_VOICES = ['stella', 'tide'] as const

/** 把 OmniCore 现有音色名映射到 DeepSeek 的两个嗓子 */
export function mapDsVoice(voice: string): string {
  const v = (voice || '').trim()
  if (!v || v === 'mimo_default' || v === 'default') return 'stella'
  if ((DS_TTS_VOICES as readonly string[]).includes(v)) return v
  const male = ['苏打', '白桦', 'Milo', 'Dean', 'tide']
  return male.includes(v) ? 'tide' : 'stella'
}

/**
 * 文字转语音。返回原始音频字节（wav 默认 / pcm 为 24kHz 16bit 单声道裸流）。
 * 限制：文本 ≤10000 计费字符（汉字算 2）、body ≤64KiB、单次 ≤30 分钟音频。
 */
export async function deepseekTts(
  text: string,
  voiceId = 'stella',
  format: DsTtsFormat = 'wav',
): Promise<ArrayBuffer> {
  if (!text?.trim()) throw new Error('text 为空')
  if (format !== 'wav' && format !== 'pcm') throw new Error(`未知 format: ${format}（可选 wav / pcm）`)

  const body = JSON.stringify({
    text,
    voice_id: mapDsVoice(voiceId),
    format,
    filter_markdown: true,
  })
  if (body.length > 64 * 1024) {
    throw new Error(`请求体 ${body.length} 字节超过 TTS 64KiB 上限，请缩短文本`)
  }

  const resp = await fetch(`${baseUrl()}/v1/tools/tts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getKey()}`,
      'Content-Type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(180_000),
  })
  if (!resp.ok) throw new Error(`DeepSeek TTS 失败，${await readError(resp)}`)

  const buf = await resp.arrayBuffer()
  // 失败时也可能回 200 + JSON 错误体，靠 content-type 区分
  const ct = resp.headers.get('content-type') || ''
  if (ct.includes('json')) {
    let msg = ''
    try { msg = JSON.parse(Buffer.from(buf).toString('utf8'))?.error?.message || '' } catch {}
    throw new Error(`DeepSeek TTS 失败: ${msg || '返回 JSON 而非音频'}`)
  }
  if (buf.byteLength === 0) throw new Error('DeepSeek TTS 返回空音频')
  return buf
}
