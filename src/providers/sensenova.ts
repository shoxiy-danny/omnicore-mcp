/**
 * SenseNova (商汤) U1 Fast 图像生成封装
 *
 * 端点：POST https://token.sensenova.cn/v1/images/generations
 *
 * U1 Fast 是专供信息图（Infographics）生成的非对话模型。
 * 返回临时 URL（有效期 1 小时），需立即下载。
 *
 * Key 来源：process.env.SENSENOVA_API_KEY（.env 统一管理）
 */

const SENSENOVA_HOST = 'https://token.sensenova.cn'
const MODEL = 'sensenova-u1-fast'

function getKey(): string {
  return process.env.SENSENOVA_API_KEY ?? ''
}

// U1 Fast 支持的尺寸（11 种 aspect ratio）
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
): Promise<string> {
  const key = getKey()
  if (!key) throw new Error('未找到 SenseNova API Key（请在 .env 配置 SENSENOVA_API_KEY）')

  const size = resolveSize(aspectRatio)

  const resp = await fetch(`${SENSENOVA_HOST}/v1/images/generations`, {
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
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    throw new Error(`SenseNova U1 Fast 生图失败: ${resp.status} ${errText.slice(0, 300)}`)
  }

  const data = await resp.json() as any
  const imageUrl = data?.data?.[0]?.url
  if (!imageUrl) throw new Error('SenseNova U1 Fast 未返回图片 URL')

  return imageUrl
}
