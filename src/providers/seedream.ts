/**
 * Doubao Seedream 5.0 pro 生图
 *
 * 端点：POST https://ark.cn-beijing.volces.com/api/v3/images/generations
 * 模型：doubao-seedream-5-0-pro-260628
 * Key：DOUBAO_API_KEY（与识图同一把）
 *
 * 文生图 + 单参考图 i2i。watermark:false。日额度约 20 张，不自动降级。
 */

import { readFileSync } from 'fs'
import { safeResolvePath, safeCheckFileSize, isSafeUrl } from '../utils/security.js'

const API_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'
const MODEL = 'doubao-seedream-5-0-pro-260628'

function getKey(): string {
  return process.env.DOUBAO_API_KEY ?? ''
}

// 2K 档 WIDTHxHEIGHT。未知比例回 1:1
const SIZE_MAP: Record<string, string> = {
  '1:1':  '2048x2048',
  '3:4':  '1728x2304',
  '4:3':  '2304x1728',
  '16:9': '2560x1440',
  '9:16': '1440x2560',
  '2:3':  '1664x2496',
  '3:2':  '2496x1664',
}

function resolveSize(aspectRatio: string): string {
  const a = (aspectRatio || '1:1').trim()
  if (/^\d+x\d+$/i.test(a) || /^[124]K$/i.test(a)) return a
  return SIZE_MAP[a] || '2048x2048'
}

function resolveImageSource(source: string): string {
  if (source.startsWith('data:')) return source
  if (source.startsWith('http://') || source.startsWith('https://')) {
    if (!isSafeUrl(source)) throw new Error(`参考图 URL 被安全策略拒绝: ${source}`)
    return source
  }
  const safePath = safeResolvePath(source)
  safeCheckFileSize(safePath, 10 * 1024 * 1024)
  const buf = readFileSync(safePath)
  const ext = safePath.split('.').pop()?.toLowerCase() || 'png'
  const mime: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  }
  return `data:${mime[ext] || 'image/png'};base64,${buf.toString('base64')}`
}

export async function seedreamGenerateImage(
  prompt: string,
  aspectRatio: string,
  subjectReference?: string,
): Promise<string> {
  const key = getKey()
  if (!key) throw new Error('未配置 DOUBAO_API_KEY')

  const body: Record<string, unknown> = {
    model: MODEL,
    prompt,
    size: resolveSize(aspectRatio),
    watermark: false,
    response_format: 'url',
  }
  if (subjectReference) {
    body.image = resolveImageSource(subjectReference)
  }

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`Seedream 生图失败: ${resp.status} ${errText.slice(0, 300)}`)
  }
  const data = await resp.json() as any
  if (data.error) throw new Error(`Seedream 错误: ${data.error.message || JSON.stringify(data.error)}`)
  const imageUrl = data?.data?.[0]?.url
  if (!imageUrl) throw new Error('Seedream 未返回图片 URL')
  return imageUrl
}
