/**
 * MiniMax API 封装
 *
 * 工具：
 * - image_describe（主路径）：/v1/coding_plan/vlm（MiniMax 识图）
 * - image_gen：/v1/image_generation（MiniMax image-01 生图）
 * - voice_gen（fallback）：/v1/t2a_v2（MiniMax speech-01-hd TTS）
 * - video_gen：/v1/video_generation + /v1/query/video_generation + /v1/files/retrieve（海螺视频生成）
 *
 * 视频生成 API 文档：https://platform.minimaxi.com/docs/api-reference/video-generation-t2v
 * 鉴权：Token Plan 订阅 Key（sk-cp- 开头），与现有 MINIMAX_API_KEY 共用
 */

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/** 运行时读取 MINIMAX_API_KEY（规避 ES module 的 import hoisting） */
const getApiKey = () => process.env.MINIMAX_API_KEY ?? ''
const API_HOST = 'https://api.minimaxi.com'

// ── 海螺视频生成常量 ──────────────────────────────────────────────────────

/** T2V/I2V 默认模型：Hailuo 2.3 — 最新、支持 [指令] 运镜控制 */
const DEFAULT_VIDEO_MODEL = 'MiniMax-Hailuo-2.3'

/** 异步轮询默认参数 */
const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_TIMEOUT_MS = 5 * 60_000

/** 任务状态枚举 */
type VideoTaskStatus = 'Preparing' | 'Queueing' | 'Processing' | 'Success' | 'Fail'

// ── 图片处理 ──────────────────────────────────────────────────────────────

export async function resolveImageSource(source: string): Promise<string> {
  if (source.startsWith('data:')) return source
  let buf: Buffer
  let ext: string
  if (source.startsWith('http://') || source.startsWith('https://')) {
    // 下载 URL → base64
    const resp = await fetch(source)
    if (!resp.ok) throw new Error(`无法下载图片: ${resp.status}`)
    const contentType = resp.headers.get('content-type') || 'image/png'
    const typeMap: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
    ext = typeMap[contentType] || 'png'
    buf = Buffer.from(await resp.arrayBuffer())
  } else {
    // 本地文件
    buf = readFileSync(source)
    ext = source.split('.').pop()?.toLowerCase() || 'png'
  }
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
  return `data:${mime[ext] || 'image/png'};base64,${buf.toString('base64')}`
}

// ── 识图（image_describe 主路径）────────────────────────────────────────

export async function miniMaxDescribeImage(prompt: string, imageSource: string): Promise<string> {
  const imageUrl = await resolveImageSource(imageSource)
  const resp = await fetch(`${API_HOST}/v1/coding_plan/vlm`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, image_url: imageUrl }),
  })
  if (!resp.ok) throw new Error(`MiniMax VLM 失败: ${resp.status}`)
  const data = await resp.json() as any
  return data.content || ''
}

// ── 图片生成（image_gen）───────────────────────────────────────────────

export async function miniMaxGenerateImage(
  prompt: string,
  aspectRatio: string,
  subjectReference?: string,
  model?: string,
  style?: { style_type: string; style_weight?: number },
): Promise<string> {
  const m = model || 'image-01'
  const body: Record<string, unknown> = { model: m, prompt, aspect_ratio: aspectRatio, n: 1, response_format: 'url' }
  if (subjectReference) {
    const dataUrl = await resolveImageSource(subjectReference)
    body.subject_reference = [{ type: 'character', image_file: dataUrl }]
  }
  if (m === 'image-01-live' && style) {
    body.style = style
  }
  const resp = await fetch(`${API_HOST}/v1/image_generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`MiniMax 生图失败: ${resp.status}`)
  const data = await resp.json() as any
  const urls: string[] = data.data?.image_urls ?? []
  if (urls.length) return urls[0]
  const alt = data.data?.url ?? (Array.isArray(data.data) ? data.data[0]?.url : null)
  if (alt) return alt
  throw new Error('MiniMax 生图未返回图片 URL')
}

// ── TTS fallback（voice_gen fallback）──────────────────────────────────

export async function miniMaxTts(text: string, voice: string): Promise<ArrayBuffer> {
  const resp = await fetch(`${API_HOST}/v1/t2a_v2`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'speech-01-hd', text, voice, audio_sample_rate: 24000 }),
  })
  if (!resp.ok) throw new Error(`MiniMax TTS 失败: ${resp.status}`)
  const data = await resp.json() as any
  const audio = data.data?.audio
  if (!audio) throw new Error('MiniMax TTS 未返回音频')
  return Buffer.from(audio, 'base64')
}

// ── 视频生成（video_gen）────────────────────────────────────────────────

/** 视频生成入参 */
export interface VideoGenOptions {
  prompt: string
  /** 图生视频时必填：首帧图片本地路径、HTTP(S) URL、或 data URL */
  first_frame_image?: string
  /** 模型名，默认 MiniMax-Hailuo-2.3；可传 T2V-01-Director / I2V-01-Director / MiniMax-Hailuo-2.3-Fast 等 */
  model?: string
  /** 视频时长（秒），默认 6 */
  duration?: number
  /** 分辨率，默认 768P（Hailuo 2.3 可选 768P/1080P） */
  resolution?: string
  /** 是否添加 AIGC 水印，默认 false */
  aigc_watermark?: boolean
  /** 轮询间隔（ms），默认 5000 */
  poll_interval_ms?: number
  /** 总超时（ms），默认 5 分钟 */
  timeout_ms?: number
  /** 视频下载落盘目录，默认 ./output */
  output_dir?: string
}

/** 视频生成结果 */
export interface VideoGenResult {
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

/** 1. POST /v1/video_generation：提交任务（T2V 或 I2V 共用端点） */
async function createVideoTask(body: Record<string, unknown>): Promise<string> {
  const resp = await fetch(`${API_HOST}/v1/video_generation`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`提交视频任务失败: ${resp.status} ${errText}`)
  }
  const data = await resp.json() as any
  if (data.base_resp?.status_code !== 0) {
    throw new Error(`提交视频任务业务错误: ${data.base_resp?.status_msg ?? JSON.stringify(data)}`)
  }
  const taskId = data.task_id
  if (!taskId) throw new Error('视频任务提交未返回 task_id')
  return String(taskId)
}

/** 2. GET /v1/query/video_generation?task_id=xxx：查询状态 */
async function queryVideoTask(taskId: string): Promise<{
  status: VideoTaskStatus
  file_id?: number
  video_width?: number
  video_height?: number
  base_resp_msg?: string
}> {
  const resp = await fetch(`${API_HOST}/v1/query/video_generation?task_id=${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${getApiKey()}` },
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`查询视频任务失败: ${resp.status} ${errText}`)
  }
  const data = await resp.json() as any
  return {
    status: data.status as VideoTaskStatus,
    file_id: data.file_id,
    video_width: data.video_width,
    video_height: data.video_height,
    base_resp_msg: data.base_resp?.status_msg,
  }
}

/** 3. GET /v1/files/retrieve?file_id=xxx：取下载 URL */
async function retrieveFileMeta(fileId: number): Promise<{ download_url: string; filename: string; bytes: number }> {
  const resp = await fetch(`${API_HOST}/v1/files/retrieve?file_id=${fileId}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${getApiKey()}` },
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`取视频文件信息失败: ${resp.status} ${errText}`)
  }
  const data = await resp.json() as any
  if (data.base_resp?.status_code !== 0) {
    throw new Error(`取视频文件信息业务错误: ${data.base_resp?.status_msg ?? JSON.stringify(data)}`)
  }
  const file = data.file
  if (!file?.download_url) throw new Error('视频文件信息未返回 download_url')
  return { download_url: file.download_url, filename: file.filename ?? 'output.mp4', bytes: file.bytes ?? 0 }
}

/** sleep 工具 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** 主流程：提交 → 轮询 → 取 URL → 下载落盘 */
export async function miniMaxVideoGen(opts: VideoGenOptions): Promise<VideoGenResult> {
  const startedAt = Date.now()
  const model = opts.model ?? DEFAULT_VIDEO_MODEL
  const duration = opts.duration ?? 6
  const resolution = opts.resolution ?? '768P'
  const outputDir = opts.output_dir ?? './output'
  const pollIntervalMs = opts.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = opts.timeout_ms ?? DEFAULT_TIMEOUT_MS

  // 构造请求体
  const body: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    duration,
    resolution,
    aigc_watermark: opts.aigc_watermark ?? false,
  }
  if (opts.first_frame_image) {
    // 本地路径 / URL / data URL 都通过 resolveImageSource 归一化为 data URL
    body.first_frame_image = await resolveImageSource(opts.first_frame_image)
  }

  // 1. 提交任务
  const taskId = await createVideoTask(body)
  process.stderr.write(`[omnicore:video_gen] task submitted: ${taskId}, model=${model}, duration=${duration}s, resolution=${resolution}\n`)

  // 2. 轮询
  const deadline = startedAt + timeoutMs
  let lastStatus: VideoTaskStatus = 'Preparing'
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs)
    const q = await queryVideoTask(taskId)
    lastStatus = q.status
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
    process.stderr.write(`[omnicore:video_gen] task ${taskId} status=${q.status} (${elapsedSec}s)\n`)

    if (q.status === 'Success') {
      if (!q.file_id) throw new Error('视频任务成功但未返回 file_id')
      // 3. 取下载 URL
      const meta = await retrieveFileMeta(q.file_id)
      // 4. 下载到本地
      const dl = await fetch(meta.download_url)
      if (!dl.ok) throw new Error(`下载视频失败: ${dl.status}`)
      const buf = Buffer.from(await dl.arrayBuffer())
      // 文件名：taskId_时间戳.mp4，避免冲突
      const safeFilename = meta.filename?.replace(/[^\w.\-]/g, '_') ?? 'output.mp4'
      const filename = `${taskId}_${Date.now()}_${safeFilename}`
      const outDir = outputDir.endsWith('/') ? outputDir : `${outputDir}/`
      const filePath = `${outDir}${filename}`
      writeFileSync(filePath, buf)

      return {
        task_id: taskId,
        file_id: q.file_id,
        file_path: filePath,
        file_bytes: buf.byteLength,
        filename,
        video_width: q.video_width ?? 0,
        video_height: q.video_height ?? 0,
        model,
        duration,
        resolution,
        elapsed_ms: Date.now() - startedAt,
      }
    }

    if (q.status === 'Fail') {
      throw new Error(`视频生成失败: ${q.base_resp_msg ?? 'unknown'}`)
    }
  }

  throw new Error(`视频生成超时（>${Math.round(timeoutMs / 1000)}s），最后状态: ${lastStatus}，task_id=${taskId}`)
}
