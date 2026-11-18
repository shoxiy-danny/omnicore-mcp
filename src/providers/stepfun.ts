/**
 * StepFun Step Plan 封装
 *
 * 端点：https://api.stepfun.com/step_plan/v1/...
 *
 * 工具：
 * - stepfunGenerateImage — 文生图 + 图生图（step-image-edit-2）
 * - stepfunDescribeImage — 识图（step-3.7-flash，Doubao 备选）
 * - stepfunTranscribeAudio — ASR（stepaudio-2.5-asr SSE，Doubao 备选）
 * - stepfunGenerateAudio — 音频生成（stepaudio-3-gen-preview，普通 API 通道，限免至 2026-11-17 11:59:59）
 *
 * 注意：音频生成只在 /v1 普通 API 通道，/step_plan 订阅通道没有该路由（404）。
 * 限免结束后收费 95 元／百万计费字符，需普通通道余额。
 *
 * Key 来源：process.env.STEPFUN_API_KEY（.env 统一管理）
 */

import { readFileSync } from 'fs'
import { execSync } from 'child_process'
import { unlinkSync } from 'fs'
import { safeResolvePath, safeCheckFileSize, isSafeUrl, shellQuote } from '../utils/security.js'
import { FFMPEG_BIN } from '../utils/ffmpeg.js'

const STEPFUN_HOST = 'https://api.stepfun.com'
const STEPFUN_PLAN_PREFIX = '/step_plan/v1'
const MODEL = 'step-image-edit-2'
const CHAT_MODEL = 'step-3.7-flash'
const ASR_MODEL = 'stepaudio-2.5-asr'

// ── Key 读取 ────────────────────────────────────────────────────────────────

function getStepFunKey(): string {
  return process.env.STEPFUN_API_KEY ?? ''
}

// ── 尺寸映射 ────────────────────────────────────────────────────────────────

const ASPECT_MAP: Record<string, string> = {
  '1:1':  '1024x1024',
  '3:4':  '896x1184',
  '4:3':  '1184x896',
  '16:9': '1360x768',
  '9:16': '768x1360',
}

function resolveSize(aspectRatio: string): string {
  return ASPECT_MAP[aspectRatio] || '1024x1024'
}

// ── 本地文件 → base64 data URI ──────────────────────────────────────────────

function resolveImageSource(source: string): string {
  if (source.startsWith('data:')) return source
  if (source.startsWith('http://') || source.startsWith('https://')) return source
  const safePath = safeResolvePath(source)
  safeCheckFileSize(safePath)
  const buf = readFileSync(safePath)
  const ext = safePath.split('.').pop()?.toLowerCase() || 'png'
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
  return `data:${mime[ext] || 'image/png'};base64,${buf.toString('base64')}`
}

// ── 核心：文生图 ─────────────────────────────────────────────────────────────

export async function stepfunGenerateImage(
  prompt: string,
  aspectRatio: string,
  subjectReference?: string,
): Promise<string> {
  const key = getStepFunKey()
  if (!key) throw new Error('未找到 StepFun API Key（请在 .env 配置 STEPFUN_API_KEY）')

  const size = resolveSize(aspectRatio)

  // 有参考图 → 图生图（edits 接口，multipart form）
  if (subjectReference) {
    const form = new FormData()
    form.append('image', readFileSync(safeResolvePath(subjectReference)), 'input.png')
    form.append('model', MODEL)
    form.append('prompt', prompt)
    form.append('size', size)
    form.append('n', '1')
    form.append('response_format', 'b64_json')

    const resp = await fetch(`${STEPFUN_HOST}${STEPFUN_PLAN_PREFIX}/images/edits`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form as any,
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`StepFun 图生图失败: ${resp.status} ${errText.slice(0, 300)}`)
    }
    const data = await resp.json() as any
    const b64 = data?.data?.[0]?.b64_json
    if (!b64) throw new Error('StepFun 图生图未返回图片数据')
    return `data:image/png;base64,${b64}`
  }

  // 纯文生图（generations 接口，JSON body）
  const resp = await fetch(`${STEPFUN_HOST}${STEPFUN_PLAN_PREFIX}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      size,
      n: 1,
      response_format: 'b64_json',
    }),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`StepFun 文生图失败: ${resp.status} ${errText.slice(0, 300)}`)
  }
  const data = await resp.json() as any
  const b64 = data?.data?.[0]?.b64_json
  if (!b64) throw new Error('StepFun 文生图未返回图片数据')
  return `data:image/png;base64,${b64}`
}

// ── 识图（image_describe fallback）────────────────────────────────────────

export async function stepfunDescribeImage(imageSource: string, prompt?: string): Promise<string> {
  const key = getStepFunKey()
  if (!key) throw new Error('未找到 StepFun API Key（请在 .env 配置 STEPFUN_API_KEY）')

  let url: string
  if (imageSource.startsWith('data:')) {
    url = imageSource
  } else if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
    if (!isSafeUrl(imageSource)) throw new Error(`URL 被安全策略拒绝: ${imageSource}`)
    url = imageSource
  } else {
    url = resolveImageSource(imageSource)
  }

  const p = prompt || '请详细描述这张图片的内容，包括颜色、物体、布局、文字等所有细节。'
  const resp = await fetch(`${STEPFUN_HOST}${STEPFUN_PLAN_PREFIX}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: p },
          { type: 'image_url', image_url: { url } },
        ],
      }],
      max_tokens: 2048,
      stream: false,
    }),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`StepFun 识图失败: ${resp.status} ${errText.slice(0, 300)}`)
  }
  const data = await resp.json() as any
  const content = (data.choices?.[0]?.message?.content || '').trim()
  if (!content) throw new Error('StepFun 识图未返回内容')
  return content as string
}

// ── ASR（transcribe_audio fallback）───────────────────────────────────────

const ASR_FORMAT: Record<string, string> = {
  mp3: 'mp3', wav: 'wav', ogg: 'ogg', m4a: 'm4a', pcm: 'pcm',
}

export async function stepfunTranscribeAudio(filePath: string): Promise<string> {
  const key = getStepFunKey()
  if (!key) throw new Error('未找到 StepFun API Key（请在 .env 配置 STEPFUN_API_KEY）')

  const safePath = safeResolvePath(filePath)
  safeCheckFileSize(safePath, 50 * 1024 * 1024)
  const ext = (safePath.split('.').pop() || '').toLowerCase()
  let sendPath = safePath
  let formatType = ASR_FORMAT[ext]
  let tmpWav = ''

  if (!formatType) {
    tmpWav = safePath.replace(/\.[^.]+$/, '') + '_step_asr.wav'
    try {
      execSync(`${shellQuote(FFMPEG_BIN)} -y -i ${shellQuote(safePath)} -ar 16000 -ac 1 ${shellQuote(tmpWav)} 2>/dev/null`, { timeout: 30000 })
    } catch (e: any) {
      throw new Error(`ffmpeg 转换失败: ${e.message}`)
    }
    sendPath = tmpWav
    formatType = 'wav'
  }

  try {
    const b64 = readFileSync(sendPath).toString('base64')
    const resp = await fetch(`${STEPFUN_HOST}${STEPFUN_PLAN_PREFIX}/audio/asr/sse`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        audio: {
          data: b64,
          input: {
            transcription: {
              language: 'zh',
              model: ASR_MODEL,
              enable_itn: true,
              enable_timestamp: false,
            },
            format: { type: formatType },
          },
        },
      }),
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`StepFun ASR 失败: ${resp.status} ${errText.slice(0, 300)}`)
    }
    const raw = await resp.text()
    let text = ''
    let errMsg = ''
    for (const block of raw.split('\n\n')) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let ev: any
        try { ev = JSON.parse(payload) } catch { continue }
        if (ev.type === 'transcript.text.done' && ev.text) text = ev.text
        if (ev.type === 'error') errMsg = ev.message || 'ASR error'
      }
    }
    if (errMsg) throw new Error(`StepFun ASR 错误: ${errMsg}`)
    return text || '（未识别到语音内容）'
  } finally {
    if (tmpWav) {
      try { unlinkSync(tmpWav) } catch {}
    }
  }
}

// ── 音频生成（StepAudio 3 Gen）──────────────────────────────────────────────

const AUDIO_GEN_MODEL = 'stepaudio-3-gen-preview'
const AUDIO_GEN_URL = `${STEPFUN_HOST}/v1/audio/generate`

export type AudioFormat = 'mp3' | 'wav' | 'flac' | 'opus' | 'pcm'

export interface AudioGenRole {
  name: string
  description?: string
}

export interface AudioGenScript {
  speaker?: string
  text: string
}

export interface AudioGenOptions {
  instruction?: string   // 全局指导：环境、BGM、情绪基调，≤500 字符
  roles?: AudioGenRole[] // 角色音色设定，name+description 合计 ≤500 字符
  scripts?: AudioGenScript[] // 台词/音效，合计 ≤1000 字符
  responseFormat?: AudioFormat
  speed?: number
  volume?: number
}

/**
 * 一条指令生成人声、音效、环境音、背景音乐的综合音频。
 * scripts 里 `[方括号]` 是音效/环境音/BGM 描述，`（圆括号）` 是语气风格。
 * 返回音频字节，由调用方落盘。
 */
export async function stepfunGenerateAudio(
  opts: AudioGenOptions,
): Promise<{ buffer: Buffer; format: AudioFormat }> {
  const key = getStepFunKey()
  if (!key) throw new Error('未找到 StepFun API Key（请在 .env 配置 STEPFUN_API_KEY）')

  const hasScripts = Array.isArray(opts.scripts) && opts.scripts.length > 0
  if (!opts.instruction && !hasScripts) {
    throw new Error('instruction 和 scripts 至少填一个')
  }

  const body: Record<string, unknown> = {
    model: AUDIO_GEN_MODEL,
    task: 'text_to_audio',
    response_format: opts.responseFormat || 'mp3',
  }
  if (opts.instruction) body.instruction = opts.instruction
  if (opts.roles?.length) body.roles = opts.roles
  if (hasScripts) body.scripts = opts.scripts
  if (opts.speed) body.speed = opts.speed
  if (opts.volume) body.volume = opts.volume

  const resp = await fetch(AUDIO_GEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    const hint = resp.status === 402
      ? '（普通 API 通道余额不足。限免期内该模型计费为 0，报此错通常表示限免已到期，需充值走 stepaudio-3-gen）'
      : ''
    throw new Error(`StepFun 音频生成失败: ${resp.status} ${errText.slice(0, 300)}${hint}`)
  }

  const ctype = resp.headers.get('content-type') || ''
  if (ctype.includes('application/json')) {
    const j: any = await resp.json().catch(() => ({}))
    throw new Error(`StepFun 音频生成返回 JSON 而非音频: ${JSON.stringify(j).slice(0, 300)}`)
  }

  const ab = await resp.arrayBuffer()
  if (!ab.byteLength) throw new Error('StepFun 音频生成返回空音频')
  return { buffer: Buffer.from(ab), format: opts.responseFormat || 'mp3' }
}
