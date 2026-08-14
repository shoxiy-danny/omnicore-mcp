/**
 * Grok / xAI Imagine — 经 aiproxy 代理
 *
 * 客户端（Kuma / Haha 等）不直连 api.x.ai，不持有 OAuth token。
 * 一律：
 *   POST {AIPROXY}/v1/images/generations
 *   POST {AIPROXY}/v1/videos/generations
 *   GET  {AIPROXY}/v1/videos/{id}?inline=1
 *   GET  {AIPROXY}/v1/media?url=...&as=json   （必要时）
 *
 * 鉴权：aiproxy 用户 token（与 CC providers.json aiproxy.authToken 同源）
 * 默认生图模型：grok-imagine-image-pro（首选）；cheap/quality 可选。
 */

import { writeFileSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { remuxVideoForFeishu } from '../utils/ffmpeg.js'

const DEFAULT_IMAGE_MODEL = 'grok-imagine-image-pro'
const CHEAP_IMAGE_MODEL = 'grok-imagine-image'
const QUALITY_IMAGE_MODEL = 'grok-imagine-image-quality'
const DEFAULT_VIDEO_MODEL = 'grok-imagine-video-1.5'

const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_TIMEOUT_MS = 10 * 60_000

// ── aiproxy 配置 ────────────────────────────────────────────────────────────

function getAiproxyBase(): string {
  const base = (process.env.AIPROXY_BASE_URL || process.env.AIPROXY_URL || 'http://127.0.0.1:8443').trim()
  return base.replace(/\/+$/, '')
}

function getAiproxyToken(): string {
  const t = (
    process.env.AIPROXY_API_KEY
    || process.env.AIPROXY_TOKEN
    || process.env.AIPROXY_AUTH_TOKEN
    || ''
  ).trim()
  if (!t) {
    throw new Error(
      '未配置 AIPROXY_API_KEY：请在 omnicore-mcp/.env 填入 aiproxy 用户 token（与 CC providers.json aiproxy.authToken 相同）',
    )
  }
  return t
}

async function aiproxyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getAiproxyToken()
  const headers = new Headers(init.headers || {})
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('x-api-key', token)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  const url = `${getAiproxyBase()}${path.startsWith('/') ? path : `/${path}`}`
  return fetch(url, { ...init, headers })
}

// ── 模型解析 ────────────────────────────────────────────────────────────────

function resolveImageModel(model?: string): string {
  if (!model) return DEFAULT_IMAGE_MODEL
  const m = model.toLowerCase().trim()
  if (m === 'pro' || m === 'grok-imagine-image-pro' || m === 'image-pro' || m === 'default') {
    return DEFAULT_IMAGE_MODEL
  }
  if (m === 'quality' || m === 'grok-imagine-image-quality' || m === 'image-quality') {
    return QUALITY_IMAGE_MODEL
  }
  if (m === 'cheap' || m === 'grok-imagine-image' || m === 'image') {
    return CHEAP_IMAGE_MODEL
  }
  if (m.startsWith('grok-imagine-image')) return model
  return DEFAULT_IMAGE_MODEL
}

function resolveVideoModel(model?: string): string {
  if (!model) return DEFAULT_VIDEO_MODEL
  const m = model.toLowerCase().trim()
  if (m === 'grok-imagine-video' || m === 'video') return 'grok-imagine-video'
  if (m === 'grok-imagine-video-1.5' || m === '1.5' || m === 'video-1.5') return DEFAULT_VIDEO_MODEL
  if (m.startsWith('grok-imagine-video')) return model
  return DEFAULT_VIDEO_MODEL
}

/** OmniCore/Agnes/MiniMax 分辨率 → Grok 合法值 480p|720p|1080p；未知则省略让上游默认 */
function mapGrokResolution(resolution?: string): string | undefined {
  if (!resolution) return undefined
  const r = resolution.trim().toLowerCase()
  if (r === '480p' || r === '480') return '480p'
  if (r === '720p' || r === '720') return '720p'
  if (r === '1080p' || r === '1080') return '1080p'
  // Agnes/MiniMax 风格
  if (r === '768p' || r === '768') return '720p'
  if (r.includes('1080')) return '1080p'
  if (r.includes('720') || r.includes('768')) return '720p'
  if (r.includes('480')) return '480p'
  return undefined
}

// ── 文生图 ──────────────────────────────────────────────────────────────────

/**
 * Grok 文生图（经 aiproxy）。
 * 返回 data:image/...;base64,... 供 server 落盘。
 *
 * model:
 *   - grok-imagine-image-pro / pro / default → 首选（默认）
 *   - grok-imagine-image / cheap → 便宜
 *   - grok-imagine-image-quality / quality → 高清
 */
export async function grokGenerateImage(
  prompt: string,
  aspectRatio: string,
  model?: string,
): Promise<string> {
  const resolvedModel = resolveImageModel(model)
  const body: Record<string, unknown> = {
    model: resolvedModel,
    prompt,
    n: 1,
    response_format: 'b64_json',
  }
  if (aspectRatio) body.aspect_ratio = aspectRatio

  const resp = await aiproxyFetch('/v1/images/generations', {
    method: 'POST',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Grok 生图失败(aiproxy): ${resp.status} ${errText.slice(0, 400)}`)
  }
  const data = await resp.json() as any
  const item = data?.data?.[0]
  if (item?.b64_json) {
    const mime = item.mime_type || 'image/jpeg'
    return `data:${mime};base64,${item.b64_json}`
  }
  if (item?.data_url) return String(item.data_url)
  if (item?.url) {
    // 经 aiproxy 代下
    return await fetchMediaAsDataUrl(String(item.url))
  }
  throw new Error(`Grok 生图未返回图片数据: ${JSON.stringify(data).slice(0, 300)}`)
}

async function fetchMediaAsDataUrl(mediaUrl: string): Promise<string> {
  const q = new URLSearchParams({ url: mediaUrl, as: 'json' })
  const resp = await aiproxyFetch(`/v1/media?${q.toString()}`, {
    method: 'GET',
    signal: AbortSignal.timeout(180_000),
  })
  if (!resp.ok) {
    const t = await resp.text().catch(() => '')
    throw new Error(`aiproxy 代下媒体失败: ${resp.status} ${t.slice(0, 300)}`)
  }
  const data = await resp.json() as any
  if (data.data_url) return String(data.data_url)
  throw new Error('aiproxy /v1/media 未返回 data_url')
}

// ── 视频 ────────────────────────────────────────────────────────────────────

export interface GrokVideoGenOptions {
  prompt: string
  first_frame_image?: string
  model?: string
  duration?: number
  aspect_ratio?: string
  resolution?: string
  poll_interval_ms?: number
  timeout_ms?: number
  output_dir?: string
}

export interface GrokVideoGenResult {
  task_id: string
  file_id: number
  file_path: string
  file_bytes: number
  filename: string
  video_width: number
  video_height: number
  model: string
  duration: number
  resolution: string
  elapsed_ms: number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 本地路径/URL → 可放进 Grok image.url 的引用（经 aiproxy 时优先 data URI） */
async function resolveImageRefForProxy(source: string): Promise<string> {
  if (source.startsWith('data:')) return source
  if (source.startsWith('http://') || source.startsWith('https://')) return source
  // 本地文件：读成 data URI（动态 import 避免顶层循环）
  const { readFileSync } = await import('fs')
  const { safeResolvePath, safeCheckFileSize } = await import('../utils/security.js')
  const safePath = safeResolvePath(source)
  safeCheckFileSize(safePath)
  const buf = readFileSync(safePath)
  const ext = safePath.split('.').pop()?.toLowerCase() || 'png'
  const mime: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  }
  return `data:${mime[ext] || 'image/png'};base64,${buf.toString('base64')}`
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/s)
  if (!m) throw new Error('invalid data url')
  return Buffer.from(m[1], 'base64')
}

export async function grokVideoGen(opts: GrokVideoGenOptions): Promise<GrokVideoGenResult> {
  const startedAt = Date.now()
  const model = resolveVideoModel(opts.model)
  const duration = opts.duration ?? 6
  const outputDir = opts.output_dir ?? './output'
  const pollIntervalMs = opts.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS

  if (duration < 1 || duration > 15) {
    throw new Error(`Grok 视频时长需在 1~15 秒，当前: ${duration}`)
  }

  const body: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    duration,
  }
  if (opts.aspect_ratio) body.aspect_ratio = opts.aspect_ratio
  // Grok 只认 480p/720p/1080p；OmniCore 默认 768P 来自 Agnes/MiniMax，需映射
  const grokRes = mapGrokResolution(opts.resolution)
  if (grokRes) body.resolution = grokRes
  if (opts.first_frame_image) {
    const ref = await resolveImageRefForProxy(opts.first_frame_image)
    body.image = { url: ref, type: 'image_url' }
  }

  const createResp = await aiproxyFetch('/v1/videos/generations', {
    method: 'POST',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  if (!createResp.ok) {
    const errText = await createResp.text().catch(() => '')
    throw new Error(`Grok 提交视频失败(aiproxy): ${createResp.status} ${errText.slice(0, 400)}`)
  }
  const created = await createResp.json() as any
  const requestId = created.request_id
  if (!requestId) throw new Error(`Grok 视频未返回 request_id: ${JSON.stringify(created).slice(0, 300)}`)
  process.stderr.write(`[omnicore:grok] video submitted via aiproxy: ${requestId}, model=${model}, duration=${duration}s\n`)

  const deadline = startedAt + timeoutMs
  let lastStatus = 'pending'
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs)
    // inline=1：done 时 aiproxy 代下视频并附 data_url
    const qResp = await aiproxyFetch(`/v1/videos/${encodeURIComponent(requestId)}?inline=1`, {
      method: 'GET',
      signal: AbortSignal.timeout(180_000),
    })
    if (!qResp.ok) {
      const errText = await qResp.text().catch(() => '')
      throw new Error(`Grok 查询视频失败(aiproxy): ${qResp.status} ${errText.slice(0, 300)}`)
    }
    const q = await qResp.json() as any
    lastStatus = q.status || 'unknown'
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
    process.stderr.write(`[omnicore:grok] video ${requestId} status=${lastStatus} (${elapsedSec}s)\n`)

    if (lastStatus === 'done') {
      let buf: Buffer | null = null
      if (q.video?.data_url) {
        buf = dataUrlToBuffer(String(q.video.data_url))
      } else if (q.video?.url) {
        const dataUrl = await fetchMediaAsDataUrl(String(q.video.url))
        buf = dataUrlToBuffer(dataUrl)
      }
      if (!buf) throw new Error('Grok 视频完成但无 video.url/data_url')

      mkdirSync(outputDir, { recursive: true })
      const filename = `grok_${requestId}_${Date.now()}.mp4`
      const filePath = join(outputDir, filename)
      writeFileSync(filePath, buf)
      // 飞书对 H.264 High / 无标准音轨 的 mp4 预览常失败 → baseline+AAC+faststart
      try {
        remuxVideoForFeishu(filePath)
        process.stderr.write(`[omnicore:grok] remuxed for feishu: ${filePath}\n`)
      } catch (e: any) {
        process.stderr.write(`[omnicore:grok] feishu remux skipped: ${e.message}\n`)
      }
      const finalBytes = statSync(filePath).size
      const finalDuration = typeof q.video?.duration === 'number' ? q.video.duration : duration
      return {
        task_id: String(requestId),
        file_id: 0,
        file_path: filePath,
        file_bytes: finalBytes,
        filename,
        video_width: 0,
        video_height: 0,
        model: q.model || model,
        duration: finalDuration,
        resolution: opts.resolution || '',
        elapsed_ms: Date.now() - startedAt,
      }
    }
    if (lastStatus === 'failed' || lastStatus === 'expired') {
      throw new Error(`Grok 视频生成${lastStatus}: ${JSON.stringify(q).slice(0, 400)}`)
    }
  }
  throw new Error(`Grok 视频超时（>${Math.round(timeoutMs / 1000)}s），最后状态: ${lastStatus}，request_id=${requestId}`)
}
