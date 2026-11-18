/**
 * SenseNova (商汤) 图像生成封装
 *
 * 端点：POST https://token.sensenova.cn/v1/images/generations
 *
 * 默认 U1.5 Lite（2026-09-06），watermark:false 无水印。
 * U1 Fast 仍可用 model=u1-fast。仅文生图（不支持 i2i）。
 * 返回临时 URL（1h）或 b64_json（转 data URL）。
 *
 * Key 来源：process.env.SENSENOVA_API_KEY（.env 统一管理）
 */

const SENSENOVA_HOST = 'https://token.sensenova.cn'
const DEFAULT_MODEL = 'sensenova-u1.5-lite'
const FAST_MODEL = 'sensenova-u1-fast'

function getKey(): string {
  return process.env.SENSENOVA_API_KEY ?? ''
}

function resolveModel(model?: string): string {
  if (!model) return DEFAULT_MODEL
  const m = model.toLowerCase().trim()
  if (m === 'fast' || m === 'u1' || m === 'u1-fast' || m === 'sensenova-u1-fast') return FAST_MODEL
  if (m === 'lite' || m === 'u1.5' || m === 'u1.5-lite' || m === 'sensenova-u1.5-lite' || m === 'default') {
    return DEFAULT_MODEL
  }
  if (m.startsWith('sensenova-')) return model
  return DEFAULT_MODEL
}

// U1 系列支持的尺寸（11 种 aspect ratio）
const SIZE_MAP: Record<string, string> = {
  '1:1':  '2048x2048',
  '2:3':  '1664x2496',
  '3:2':  '2496x1664',
  '3:4':  '1760x2368',
  '4:3':  '2368x1760',
  '4:5':  '1824x2272',
  '5:4':  '2272x1824',
  '16:9': '2752x1536',
  '9:16': '1536x2752',
  '21:9': '3072x1376',
  '9:21': '1344x3136',
}

function resolveSize(aspectRatio: string): string {
  return SIZE_MAP[aspectRatio] || '2752x1536'
}

export async function sensenovaGenerateImage(
  prompt: string,
  aspectRatio: string,
  _subjectReference?: string,
  model?: string,
): Promise<string> {
  const key = getKey()
  if (!key) throw new Error('未找到 SenseNova API Key（请在 .env 配置 SENSENOVA_API_KEY）')

  const size = resolveSize(aspectRatio)
  const modelId = resolveModel(model)

  const resp = await fetch(`${SENSENOVA_HOST}/v1/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      prompt,
      size,
      n: 1,
      watermark: false,
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`SenseNova 生图失败 (${modelId}): ${resp.status} ${errText.slice(0, 300)}`)
  }

  const data = await resp.json() as any
  const item = data?.data?.[0]
  if (item?.b64_json) {
    const fmt = String(data?.output_format || 'png').toLowerCase()
    const mime = (fmt === 'jpeg' || fmt === 'jpg') ? 'image/jpeg' : 'image/png'
    return `data:${mime};base64,${item.b64_json}`
  }
  const imageUrl = item?.url
  if (!imageUrl) throw new Error(`SenseNova 未返回图片 (${modelId})`)
  return imageUrl
}
