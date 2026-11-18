/**
 * Agnes AI API 封装
 *
 * 端点：https://apihub.agnes-ai.com
 *
 * 工具：
 * - image_describe（主路径）：POST /v1/chat/completions（agnes-2.5-flash，多模态识图）
 * - image_gen（主路径）：POST /v1/images/generations（agnes-image-2.5-flash）
 * - video_gen（主路径）：POST /v1/videos → GET /v1/videos/{id}（agnes-video-2.5-flash）
 *   2.5 契约：mode=text|reference，size=720P|960P|2K（免费 key 仅 720P），seconds，seed；
 *   不支持 width/height/num_frames/frame_rate/negative_prompt；首尾帧模式不支持。
 */

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { safeResolvePath, safeCheckFileSize, isSafeUrl } from '../utils/security.js'

const API_HOST = 'https://apihub.agnes-ai.com'
const CHAT_MODEL = 'agnes-2.5-flash'
const IMAGE_MODEL = 'agnes-image-2.5-flash'

/** 懒加载 env：server.ts 的 .env 加载在 ES Module import 之后才执行，必须运行时再读 */
function getApiKey(): string {
  return process.env.AGNES_API_KEY ?? ''
}

function getApiKeys(): string[] {
  const keys: string[] = []
  const primary = process.env.AGNES_API_KEY
  const fallback = process.env.AGNES_API_KEY_FALLBACK
  if (primary) keys.push(primary)
  if (fallback && fallback !== primary) keys.push(fallback)
  return keys
}

/** 用所有 key 依次尝试，成功即返回 */
async function tryWithKeys<T>(fn: (key: string) => Promise<T>): Promise<T> {
  const keys = getApiKeys()
  if (keys.length === 0) throw new Error('未配置 AGNES_API_KEY')
  let lastErr: Error | null = null
  for (let i = 0; i < keys.length; i++) {
    try {
      const result = await fn(keys[i])
      if (i > 0) process.stderr.write(`[omnicore] Agnes fallback key succeeded\n`)
      return result
    } catch (e: any) {
      lastErr = e
      if (i < keys.length - 1) {
        process.stderr.write(`[omnicore] Agnes primary key failed (${e.message.slice(0, 80)}), trying fallback...\n`)
      }
    }
  }
  throw lastErr!
}

/** 检测 prompt 是否包含非 ASCII 字符（粗判非英文） */
function needsEnglishTranslation(prompt: string): boolean {
  for (let i = 0; i < prompt.length; i++) {
    if (prompt.charCodeAt(i) > 127) return true
  }
  return false
}

/** 把非英文 prompt 翻译成英文。失败时回退原 prompt，不抛出。 */
async function translatePromptToEnglish(prompt: string, key: string): Promise<string> {
  const resp = await fetch(`${API_HOST}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', connection: 'close' },
    body: JSON.stringify({
      model: CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            "Translate the user's image/video generation prompt into fluent English. " +
            'Preserve all concrete visual details, style words, camera motion, lighting, ' +
            'composition constraints, and negative instructions. Return only the English prompt.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: 800,
    }),
  })
  if (!resp.ok) {
    process.stderr.write(`[omnicore] prompt translation HTTP ${resp.status}，回退原 prompt\n`)
    return prompt
  }
  const data = (await resp.json()) as any
  const translated: string | undefined = data?.choices?.[0]?.message?.content?.trim()
  if (!translated) {
    process.stderr.write(`[omnicore] prompt translation returned empty，回退原 prompt\n`)
    return prompt
  }
  return translated
}

/** 带翻译的入口包装：非英文 prompt 走翻译，英文或 opt-out 直通 */
async function maybeTranslate(opts: { prompt: string; no_translate?: boolean }, key: string): Promise<string> {
  if (opts.no_translate || !needsEnglishTranslation(opts.prompt)) {
    return opts.prompt
  }
  const translated = await translatePromptToEnglish(opts.prompt, key)
  if (translated !== opts.prompt) {
    process.stderr.write(`[omnicore] prompt 自动翻译:\n  原: ${opts.prompt}\n  新: ${translated}\n`)
  }
  return translated
}

// ── 尺寸映射 ──────────────────────────────────────────────────────────────

const ASPECT_MAP: Record<string, string> = {
  '1:1':  '1024x1024',
  '3:4':  '768x1024',
  '4:3':  '1024x768',
  '16:9': '1280x720',
  '9:16': '720x1280',
}

function resolveSize(aspectRatio: string): string {
  return ASPECT_MAP[aspectRatio] || '1024x1024'
}

// ── 图片识别（image_describe 主路径）────────────────────────────────────

export async function agnesDescribeImage(prompt: string, imageSource: string): Promise<string> {
  return tryWithKeys(async (key) => {
    const url = imageSource.startsWith('http://') || imageSource.startsWith('https://')
      ? imageSource
      : resolveImageSource(imageSource)
    const resp = await fetch(`${API_HOST}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', connection: 'close' },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url } },
          ],
        }],
        max_tokens: 2048,
      }),
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`Agnes 识图失败: ${resp.status} ${errText.slice(0, 300)}`)
    }
    const data = await resp.json() as any
    const content = data.choices?.[0]?.message?.content || ''
    if (!content) throw new Error('Agnes 识图未返回内容')
    return content as string
  })
}

// ── 图片处理 ──────────────────────────────────────────────────────────────

function resolveImageSource(source: string): string {
  if (source.startsWith('data:')) return source
  if (source.startsWith('http://') || source.startsWith('https://')) {
    if (!isSafeUrl(source)) throw new Error(`URL 被安全策略拒绝: ${source}`)
    return source
  }
  // 本地文件 → 校验 + base64
  const safePath = safeResolvePath(source)
  safeCheckFileSize(safePath)
  const buf = readFileSync(safePath)
  const ext = safePath.split('.').pop()?.toLowerCase() || 'png'
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
  return `data:${mime[ext] || 'image/png'};base64,${buf.toString('base64')}`
}

// ── 图片生成 ──────────────────────────────────────────────────────────────

export async function agnesGenerateImage(
  prompt: string,
  aspectRatio: string,
  subjectReference?: string,
  noTranslate?: boolean,
): Promise<string> {
  const size = resolveSize(aspectRatio)

  return tryWithKeys(async (key) => {
    const finalPrompt = await maybeTranslate({ prompt, no_translate: noTranslate }, key)
    const body: Record<string, unknown> = {
      model: IMAGE_MODEL,
      prompt: finalPrompt,
      size,
      extra_body: { response_format: 'url' },
    }

    // i2i：在 extra_body.image 中传入参考图
    if (subjectReference) {
      body.extra_body = { ...(body.extra_body as Record<string, unknown>), image: [resolveImageSource(subjectReference)] }
    }

    const resp = await fetch(`${API_HOST}/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', connection: 'close' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`Agnes 生图失败: ${resp.status} ${errText.slice(0, 300)}`)
    }
    const data = await resp.json() as any
    const url = data.data?.[0]?.url || data.url
    if (!url) throw new Error('Agnes 生图未返回图片 URL')
    return url as string
  })
}

// ── 视频生成（agnes-video-2.5-flash）──────────────────────────────────────

/** 2.5 模型分辨率映射：720P / 960P / 2K。旧入参 768P 归到 720P，1080P 归到 960P */
function resolveVideoSize(resolution: string): string {
  const map: Record<string, string> = {
    '720P': '720P',
    '768P': '720P',
    '960P': '960P',
    '1080P': '960P',
    '2K': '2K',
  }
  return map[resolution] || '720P'
}

export interface AgnesVideoGenOptions {
  prompt: string
  /** 图生视频首帧图片（本地路径或 URL） */
  first_frame_image?: string
  /** 关键帧模式：尾帧图片。agnes-video-2.5-flash 不支持首尾帧，设置后会报错提示 */
  last_frame_image?: string
  /** 视频时长（秒），默认 5。2.5 模型以 seconds 字段传入 */
  duration?: number
  /** 分辨率：720P/768P→720P，960P/1080P→960P，2K。免费 key 仅支持 720P */
  resolution?: string
  /** 负向提示词：agnes-video-2.5-flash 不支持此字段，仅保留兼容会被忽略 */
  negative_prompt?: string
  /** 随机种子：固定值可复现相同结果 */
  seed?: number
  /** 轮询间隔（ms），默认 5000 */
  poll_interval_ms?: number
  /** 总超时（ms），默认 5 分钟 */
  timeout_ms?: number
  /** 输出目录 */
  output_dir?: string
  /** 关闭非英文 prompt 自动翻译（调用方已自行翻译时使用） */
  no_translate?: boolean
}

export interface AgnesVideoGenResult {
  task_id: string
  file_path: string
  file_bytes: number
  model: string
  duration: number
  resolution: string
  video_width: number
  video_height: number
  elapsed_ms: number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 1. 创建视频任务（2.5 契约：mode=text|reference + size/seconds/seed）。
 *  免费 key 只允许 720P，遇到 size 受限时自动降到 720P 重试一次。 */
async function createVideoTask(key: string, body: Record<string, unknown>): Promise<string> {
  const send = async (b: Record<string, unknown>): Promise<Response> =>
    fetch(`${API_HOST}/v1/videos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', connection: 'close' },
      body: JSON.stringify(b),
    })

  let resp = await send(body)
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    if (/size must be/i.test(errText) && body.size !== '720P') {
      process.stderr.write(`[omnicore] 当前 key 不支持 ${body.size}，自动降为 720P 重试\n`)
      resp = await send({ ...body, size: '720P' })
      if (!resp.ok) {
        const retryErr = await resp.text().catch(() => '')
        throw new Error(`Agnes 创建视频任务失败: ${resp.status} ${retryErr.slice(0, 300)}`)
      }
    } else {
      throw new Error(`Agnes 创建视频任务失败: ${resp.status} ${errText.slice(0, 300)}`)
    }
  }
  const data = await resp.json() as any
  const videoId = data.video_id || data.id
  if (!videoId) throw new Error('Agnes 视频创建未返回 video_id')
  return String(videoId)
}

/** 2. 查询视频状态（2.5 契约：GET /v1/videos/{id}，成片地址在 metadata.url） */
async function queryVideoTask(key: string, videoId: string): Promise<{
  status: string
  download_url?: string
}> {
  const resp = await fetch(`${API_HOST}/v1/videos/${encodeURIComponent(videoId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}`, connection: 'close' },
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Agnes 查询视频失败: ${resp.status} ${errText.slice(0, 300)}`)
  }
  const data = await resp.json() as any
  return {
    status: (data.status || 'unknown') as string,
    download_url: data.metadata?.url || data.download_url,
  }
}

/** 上传本地图片到 Agnes 图床（通过 i2i 生成获得托管 URL），用于 I2V 参考图。
 *  缓存 URL 到 .url 文件，避免重复上传。 */
async function uploadImageToHostedUrl(imagePath: string, key: string): Promise<string | null> {
  // 读取缓存
  const cacheFile = imagePath + '.url'
  try {
    const cached = readFileSync(cacheFile, 'utf8').trim()
    if (cached) {
      process.stderr.write(`[omnicore] Using cached image URL: ${cached.slice(0, 80)}...\n`)
      return cached
    }
  } catch {}

  const dataUri = resolveImageSource(imagePath)
  const payload = {
    model: IMAGE_MODEL,
    prompt: 'Keep the image exactly as it is',
    n: 1,
    size: '1024x1024',
    extra_body: { response_format: 'url', image: dataUri },
  }

  try {
    const resp = await fetch(`${API_HOST}/v1/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', connection: 'close' },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      process.stderr.write(`[omnicore] Image upload HTTP ${resp.status}, will use base64: ${errText.slice(0, 150)}\n`)
      return null
    }
    const result = await resp.json() as any
    const url = result.data?.[0]?.url
    if (url) {
      try { writeFileSync(cacheFile, url, 'utf8') } catch {}
      process.stderr.write(`[omnicore] Image uploaded → hosted URL: ${url.slice(0, 80)}...\n`)
      return url
    }
  } catch (e: any) {
    process.stderr.write(`[omnicore] Image upload error: ${e.message?.slice(0, 150)}\n`)
  }
  return null
}

/** 主流程：创建 → 轮询 → 下载（Agnes 免费 → MiniMax 付费降级） */
export async function agnesVideoGen(opts: AgnesVideoGenOptions): Promise<AgnesVideoGenResult> {
  return tryWithKeys(async (key) => {
    const startedAt = Date.now()
    const duration = opts.duration ?? 5
    const resolution = opts.resolution ?? '720P'
    const outputDir = opts.output_dir ?? './output'
    const pollIntervalMs = opts.poll_interval_ms ?? 15_000
    const timeoutMs = opts.timeout_ms ?? 10 * 60_000

    const size = resolveVideoSize(resolution)

    if (opts.negative_prompt) {
      process.stderr.write('[omnicore] agnes-video-2.5-flash 不支持 negative_prompt，已忽略\n')
    }

    const finalPrompt = await maybeTranslate({ prompt: opts.prompt, no_translate: opts.no_translate }, key)

    const body: Record<string, unknown> = {
      model: 'agnes-video-2.5-flash',
      prompt: finalPrompt,
      mode: 'text',
      size,
      seconds: String(duration),
    }

    if (opts.first_frame_image) {
      // 2.5 契约：图生视频用 mode=reference + images:[URL]。本地文件先上传到 Agnes 图床。
      const imgPath = opts.first_frame_image
      const isLocal = !imgPath.startsWith('http://') && !imgPath.startsWith('https://') && !imgPath.startsWith('data:')
      const hostedUrl = isLocal ? await uploadImageToHostedUrl(imgPath, key) : null
      body.mode = 'reference'
      body.images = [hostedUrl || resolveImageSource(imgPath)]
    }
    if (opts.last_frame_image) {
      throw new Error('agnes-video-2.5-flash 暂不支持首尾帧（last_frame_image），请只用 first_frame_image 或换 provider=minimax')
    }
    if (opts.seed !== undefined) {
      body.seed = opts.seed
    }

    // 1. 创建任务
    const videoId = await createVideoTask(key, body)
    process.stderr.write(`[omnicore:video_gen] Agnes task created: video_id=${videoId}, model=agnes-video-2.5-flash, size=${size}, duration=${duration}s\n`)

  // 2. 轮询
  const deadline = startedAt + timeoutMs
  let lastStatus = 'queued'
  let downloadUrl: string | undefined

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs)
    const q = await queryVideoTask(key, videoId)
    lastStatus = q.status
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
    process.stderr.write(`[omnicore:video_gen] task ${videoId} status=${q.status} (${elapsedSec}s)\n`)

    if (q.status === 'completed') {
      downloadUrl = q.download_url
      break
    }

    if (q.status === 'failed') {
      throw new Error(`Agnes 视频生成失败，video_id=${videoId}`)
    }
  }

  if (!downloadUrl) {
    throw new Error(`Agnes 视频生成超时（>${Math.round(timeoutMs / 1000)}s），最后状态: ${lastStatus}，video_id=${videoId}`)
  }

  // 3. 下载
  const dl = await fetch(downloadUrl)
  if (!dl.ok) throw new Error(`下载 Agnes 视频失败: ${dl.status}`)
  const buf = Buffer.from(await dl.arrayBuffer())
  const filename = `agnes_video_${Date.now()}.mp4`
  const outDir = outputDir.endsWith('/') ? outputDir : `${outputDir}/`
  const filePath = `${outDir}${filename}`
  writeFileSync(filePath, buf)

  return {
    task_id: videoId,
    file_path: filePath,
    file_bytes: buf.byteLength,
    model: 'agnes-video-2.5-flash',
    duration,
    resolution: size,
    video_width: 0,
    video_height: 0,
    elapsed_ms: Date.now() - startedAt,
  }
  })
}
