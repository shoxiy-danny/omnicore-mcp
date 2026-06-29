/**
 * MiMo API 封装
 *
 * 端点：MIMO_API_HOST/v1/chat/completions
 * 鉴权：api-key header
 *
 * 工具：
 * - TTS：mimo-v2.5-tts
 * - 图片理解（fallback）：mimo-v2-omni（多模态）
 * - 搜索：mimo-v2.5-pro（需 webSearchEnabled=true）
 */

import { readFileSync } from 'fs'

const MIMO_API_KEY = process.env.MIMO_API_KEY ?? ''
const MIMO_API_HOST = process.env.MIMO_API_HOST ?? 'https://token-plan-cn.xiaomimimo.com'

// ── TTS ──────────────────────────────────────────────────────────────────────

export async function mimoTts(text: string, voice: string, format: string): Promise<ArrayBuffer> {
  const resp = await fetch(`${MIMO_API_HOST}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': MIMO_API_KEY },
    body: JSON.stringify({
      model: 'mimo-v2.5-tts',
      messages: [{ role: 'assistant', content: text }],
      audio: { voice, format },
    }),
  })
  if (!resp.ok) throw new Error(`MiMo TTS 失败: ${resp.status}`)
  const data = await resp.json() as any
  const audioData = data.choices?.[0]?.message?.audio?.data
  if (!audioData) throw new Error('MiMo TTS 未返回音频数据')
  return Buffer.from(audioData, 'base64')
}

// ── 图片理解（image_describe fallback）─────────────────────────────────────

/** 将本地图片转为 base64 data URI */
function resolveImageSource(source: string): string {
  if (source.startsWith('data:')) return source
  if (source.startsWith('http://') || source.startsWith('https://')) return source
  const buf = readFileSync(source)
  const ext = source.split('.').pop()?.toLowerCase() || 'png'
  const mime: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
  return `data:${mime[ext] || 'image/png'};base64,${buf.toString('base64')}`
}

export async function mimoDescribeImage(prompt: string, imageSource: string): Promise<string> {
  const url = imageSource.startsWith('http://') || imageSource.startsWith('https://')
    ? imageSource
    : resolveImageSource(imageSource)

  const resp = await fetch(`${MIMO_API_HOST}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': MIMO_API_KEY },
    body: JSON.stringify({
      model: 'mimo-v2-omni',
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
    throw new Error(`MiMo 识图失败: ${resp.status} ${errText.slice(0, 300)}`)
  }
  const data = await resp.json() as any
  const content = data.choices?.[0]?.message?.content || ''
  if (!content) throw new Error('MiMo 识图未返回内容')
  return content as string
}

// ── 搜索（web_search）─────────────────────────────────────────────────────────

export async function mimoWebSearch(query: string): Promise<string> {
  const resp = await fetch(`${MIMO_API_HOST}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': MIMO_API_KEY },
    body: JSON.stringify({
      model: 'mimo-v2.5-pro',
      messages: [{
        role: 'user',
        content: query,
      }],
      max_tokens: 4096,
      webSearchEnabled: true,
    }),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`MiMo 搜索失败: ${resp.status} ${errText.slice(0, 300)}`)
  }
  const data = await resp.json() as any
  const content = data.choices?.[0]?.message?.content || ''
  if (!content) throw new Error('MiMo 搜索未返回内容')
  return content as string
}
