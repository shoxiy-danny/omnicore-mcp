/**
 * Doubao Seed-2.0-mini API 封装
 *
 * 端点：https://ark.cn-beijing.volces.com/api/v3/responses
 * 模型：doubao-seed-2-0-mini-260428
 *
 * 工具：
 * - image_locate：视觉定位（bbox）
 * - video_analyze：视频分析
 * - image_describe（fallback）：图片内容描述
 */

import { readFileSync } from 'fs'

const API_KEY = process.env.DOUBAO_API_KEY ?? ''
const API_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses'
const MODEL = 'doubao-seed-2-0-mini-260428'

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

async function callDoubao(content: ContentBlock[], extra: Record<string, unknown> = {}): Promise<string> {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
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

function fileToBase64(path: string): string {
  const buf = readFileSync(path)
  const ext = path.split('.').pop()?.toLowerCase() || 'bin'
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
  ])
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
