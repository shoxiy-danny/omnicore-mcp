/**
 * Doubao Seed 封装（识图 / 视频 / ASR）
 *
 * 端点：https://ark.cn-beijing.volces.com/api/v3/responses
 * 模型：识图/视频 mini 主 → lite 兜底；bbox/ASR lite 主 → mini 兜底
 *
 * 工具：
 * - image_locate：视觉定位（bbox）
 * - video_analyze：视频分析
 * - image_describe：图片内容描述
 * - transcribe_audio：语音转写
 *
 * 生图不走这里，见 seedream.ts（Doubao-Seedream-5.0-pro）
 */

import { readFileSync, unlinkSync } from 'fs'
import { safeResolvePath, safeCheckFileSize, shellQuote } from '../utils/security.js'
import { FFMPEG_BIN } from '../utils/ffmpeg.js'

const API_KEY = process.env.DOUBAO_API_KEY ?? ''
const API_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses'
// 识图 / 视频：mini 主用（便宜、够快），失败退 lite
const MODELS = ['doubao-seed-2-0-mini-260428', 'doubao-seed-2-1-lite-260915']
// bbox / ASR：精度优先，lite 主用，失败退 mini
const MODELS_ACCURATE = ['doubao-seed-2-1-lite-260915', 'doubao-seed-2-0-mini-260428']

interface ContentBlock {
  type: 'input_text' | 'input_image' | 'input_video'
  text?: string
  image_url?: string
  video_url?: string
  file_id?: string
}

interface OutputItem {
  type: string
  content?: { type: string; text?: string }[]
  text?: string
}

async function callDoubaoModel(model: string, content: ContentBlock[], extra: Record<string, unknown>): Promise<string> {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content }],
      ...extra,
    }),
  })
  if (!resp.ok) {
    const err = await resp.text().catch(() => '')
    throw new Error(`Doubao API ${resp.status}: ${err.slice(0, 200)}`)
  }
  const data = await resp.json() as any
  if (data.error) throw new Error(`Doubao 错误: ${data.error.message}`)
  // 找到 message 类型的 output
  for (const item of data.output || []) {
    if (item.type === 'message' && item.content?.[0]?.text) {
      return item.content[0].text
    }
  }
  return data.output?.[1]?.content?.[0]?.text ?? ''
}

async function callDoubao(content: ContentBlock[], extra: Record<string, unknown> = {}, models: string[] = MODELS): Promise<string> {
  let lastErr: unknown = null
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    try {
      const text = await callDoubaoModel(model, content, extra)
      // 上游偶发 HTTP 200 但正文为空，这种也算失败，继续往下试
      if (!text.trim()) throw new Error('返回空内容')
      return text
    } catch (e: any) {
      lastErr = e
      const next = models[i + 1]
      process.stderr.write(`[omnicore] Doubao ${model} 失败${next ? `，切 ${next}` : ''}: ${e.message}\n`)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Doubao 无可用模型')
}

function fileToBase64(path: string): string {
  const safePath = safeResolvePath(path)
  safeCheckFileSize(safePath, 100 * 1024 * 1024) // 视频/图片 100MB 上限
  const buf = readFileSync(safePath)
  const ext = safePath.split('.').pop()?.toLowerCase() || 'bin'
  const mime: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    mp4: 'video/mp4', mov: 'video/quicktime', qt: 'video/quicktime',
    avi: 'video/x-msvideo',
  }
  return `data:${mime[ext] || 'application/octet-stream'};base64,${buf.toString('base64')}`
}

// ── 图片定位（image_locate）──────────────────────────────────────────────

export async function doubaoLocateImage(imagePath: string, prompt?: string): Promise<string> {
  const p = prompt || '你是UI自动化专家。请找出图中所有可操作的按钮/交互元素，以及日期/数字等关键信息的位置。每个区域用 <bbox>x1,y1,x2,y2</bbox> 标注坐标（归一化0-1000），并说明是什么元素。'
  return await callDoubao([
    { type: 'input_image', image_url: fileToBase64(imagePath) },
    { type: 'input_text', text: p },
  ], {}, MODELS_ACCURATE)
}

// ── 视频分析（video_analyze）─────────────────────────────────────────────

export async function doubaoAnalyzeVideo(videoPath: string, prompt?: string): Promise<string> {
  const p = prompt || '请详细描述这个视频的内容，包括每一帧画面变化、出现的文字、人物、动作等所有细节。'
  return await callDoubao([
    { type: 'input_video', video_url: fileToBase64(videoPath) },
    { type: 'input_text', text: p },
  ])
}

// ── 图片描述 fallback（image_describe fallback）───────────────────────────

export async function doubaoDescribeImage(imagePath: string, prompt?: string): Promise<string> {
  const p = prompt || '请详细描述这张图片的内容，包括颜色、物体、布局、文字等所有细节。'
  return await callDoubao([
    { type: 'input_image', image_url: fileToBase64(imagePath) },
    { type: 'input_text', text: p },
  ])
}

// ── 语音转文字（transcribe_audio）─────────────────────────────────────────

export async function doubaoTranscribeAudio(filePath: string): Promise<string> {
  const { execSync } = await import('child_process')
  const safePath = safeResolvePath(filePath)
  safeCheckFileSize(safePath, 50 * 1024 * 1024) // 音频 50MB 上限
  const ext = safePath.split('.').pop()?.toLowerCase() || ''
  const wavPath = safePath.replace(/\.[^.]+$/, '') + '_tmp.wav'

  // 转成 wav（16kHz 单声道）— shellQuote 防命令注入
  try {
    execSync(`${shellQuote(FFMPEG_BIN)} -y -i ${shellQuote(safePath)} -ar 16000 -ac 1 ${shellQuote(wavPath)} 2>/dev/null`, { timeout: 30000 })
  } catch (e: any) {
    throw new Error(`ffmpeg 转换失败: ${e.message}`)
  }

  try {
    const audioBuf = readFileSync(wavPath)
    const b64 = audioBuf.toString('base64')

    let lastErr: unknown = null
    for (let i = 0; i < MODELS_ACCURATE.length; i++) {
      const model = MODELS_ACCURATE[i]
      try {
        const resp = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            input: [{
              role: 'user',
              content: [
                { type: 'input_audio', audio_url: `data:audio/wav;base64,${b64}` },
                { type: 'input_text', text: '请将这段语音内容完整转写为文字，保留原话，用中文输出。' },
              ],
            }],
          }),
        })

        const data = await resp.json() as any
        if (data.error) throw new Error(`Doubao API 错误: ${data.error.message}`)

        const text = data.output?.[1]?.content?.[0]?.text ?? ''
        if (!text.trim()) throw new Error('返回空内容')
        return text
      } catch (e: any) {
        lastErr = e
        const next = MODELS_ACCURATE[i + 1]
        process.stderr.write(`[omnicore] Doubao ASR ${model} 失败${next ? `，切 ${next}` : ''}: ${e.message}\n`)
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Doubao ASR 无可用模型')
  } finally {
    try { unlinkSync(wavPath) } catch {}
  }
}
