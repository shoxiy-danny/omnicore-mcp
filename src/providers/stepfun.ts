/**
 * StepFun Step Plan 图像生成封装
 *
 * 端点：https://api.stepfun.com/step_plan/v1/...
 *
 * 工具：
 * - stepfunGenerateImage — 文生图 + 图生图（step-image-edit-2）
 *
 * Key 来源：~/.claude/providers.json（复用 CC 的 StepFun 配置）
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const STEPFUN_HOST = 'https://api.stepfun.com'
const STEPFUN_PLAN_PREFIX = '/step_plan/v1'
const MODEL = 'step-image-edit-2'

// ── Key 读取 ────────────────────────────────────────────────────────────────

function getStepFunKey(): string {
  // 优先从 CC 的 providers.json 读取
  const providersPath = join(process.env.HOME!, '.claude', 'providers.json')
  if (existsSync(providersPath)) {
    try {
      const data = JSON.parse(readFileSync(providersPath, 'utf8'))
      const stepfun = data?.stepfun?.authToken
      if (stepfun) return stepfun
    } catch {}
  }
  // fallback：环境变量
  return process.env.STEPFUN_API_KEY ?? ''
}

// ── 尺寸映射 ────────────────────────────────────────────────────────────────

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

// ── 本地文件 → base64 data URI ──────────────────────────────────────────────

function resolveImageSource(source: string): string {
  if (source.startsWith('data:')) return source
  if (source.startsWith('http://') || source.startsWith('https://')) return source
  const buf = readFileSync(source)
  const ext = source.split('.').pop()?.toLowerCase() || 'png'
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
  if (!key) throw new Error('未找到 StepFun API Key（~/.claude/providers.json 或 STEPFUN_API_KEY 环境变量）')

  const size = resolveSize(aspectRatio)

  // 有参考图 → 图生图（edits 接口，multipart form）
  if (subjectReference) {
    const form = new FormData()
    form.append('image', readFileSync(subjectReference), 'input.png')
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
