#!/usr/bin/env bun
/**
 * OmniCore MCP — 统一多模态入口
 *
 * 工具：
 *   image_describe  — 图片内容描述（Agnes → MiMo → Doubao → MiniMax 兜底）
 *   image_locate    — 图片视觉定位（Doubao bbox）
 *   video_analyze   — 视频分析（Doubao）
 *   voice_gen       — 文字转语音（MiniMax TTS，SAM 旁白同款音色）
 *   transcribe_audio — 语音转文字（Doubao ASR）
 *   image_gen       — 图片生成（Agnes → MiniMax 兜底）
 *   video_gen       — 海螺视频生成（Agnes → MiniMax Hailuo 兜底）
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// ── 环境加载 ───────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const ENV_FILE = join(ROOT, '.env')
const OUTPUT_DIR = join(ROOT, 'output')

try {
  const envContent = readFileSync(ENV_FILE, 'utf8')
  for (const line of envContent.split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) process.env[m[1]] = m[2]
  }
} catch {}

// 扩展 PATH：确保 ~/.local/bin（ffmpeg 等用户级工具）在子进程可见
const LOCAL_BIN = join(ROOT, '..', '..', '.local', 'bin')
if (!process.env.PATH?.includes(LOCAL_BIN)) {
  process.env.PATH = `${LOCAL_BIN}:${process.env.PATH}`
}

mkdirSync(OUTPUT_DIR, { recursive: true })

// ── Provider 导入 ──────────────────────────────────────────────────────────

import { miniMaxDescribeImage, miniMaxGenerateImage, miniMaxTts, miniMaxVideoGen } from './providers/minimax.js'
import { doubaoLocateImage, doubaoAnalyzeVideo, doubaoDescribeImage, doubaoTranscribeAudio } from './providers/doubao.js'
import { mimoTts, mimoDescribeImage } from './providers/mimo.js'
import { agnesGenerateImage, agnesVideoGen, agnesDescribeImage } from './providers/agnes.js'
import { stepfunGenerateImage } from './providers/stepfun.js'
import { sensenovaGenerateImage } from './providers/sensenova.js'
import { grokGenerateImage, grokVideoGen } from './providers/grok.js'
import { convertAudio, cleanupFiles } from './utils/ffmpeg.js'

// ── 默认 Provider 配置（可调整）─────────────────────────────────────────────
// 修改这两个常量即可切换 image_gen / video_gen 的默认 provider
// 注意：grok 为付费套餐 API 用量，不设为默认；需显式 provider=grok
const DEFAULT_IMAGE_PROVIDER = 'agnes'  // 可选: agnes / stepfun / minimax / sensenova / grok
const DEFAULT_VIDEO_PROVIDER = 'agnes'  // 可选: agnes / minimax / grok

// ── 工具定义 ───────────────────────────────────────────────────────────────

const tools = [
  {
    name: 'image_describe',
    description: '详细描述/分析图片内容。支持 URL 和本地文件，默认走 Doubao（最快）→ MiMo → Agnes → MiniMax（兜底）。支持 provider 参数指定模型。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '对图片的提问或指令，如"这张图片里有什么？"', default: '请描述这张图片' },
        image_source: { type: 'string', description: '图片来源：HTTP(S) URL 或本地文件绝对路径' },
        provider: { type: 'string', description: '指定模型：agnes/mimo/doubao/minimax，不指定则按默认顺序兜底', default: '' },
      },
      required: ['image_source'],
    },
  },
  {
    name: 'image_locate',
    description: '图片视觉定位分析。AI 识别图片中可操作的按钮、交互元素、日期等关键信息，返回它们的 bbox 归一化坐标（0-1000）。适合 UI 自动化分析。',
    inputSchema: {
      type: 'object',
      properties: {
        image_path: { type: 'string', description: '本地图片文件绝对路径' },
        prompt: { type: 'string', description: '自定义定位指令（可选），默认自动检测所有可操作元素' },
      },
      required: ['image_path'],
    },
  },
  {
    name: 'video_analyze',
    description: '分析视频内容。支持 mp4/mov/qt/avi 等常见格式，AI 描述视频每一帧的内容。',
    inputSchema: {
      type: 'object',
      properties: {
        video_path: { type: 'string', description: '本地视频文件绝对路径' },
        prompt: { type: 'string', description: '自定义分析指令（可选）' },
      },
      required: ['video_path'],
    },
  },
  {
    name: 'voice_gen',
    description: '文字转语音。输入文字，生成语音音频文件（mp3），返回本地路径。默认走 MiMo（按量付费免费档），MiMo 失败自动降级 MiniMax。可通过 provider 强制指定 minimax/mimo。MiMo 支持 tts（预置音色）和 voicedesign（自然语言描述音色）两种模型。注意：只生成音频文件，不发送到飞书。如需发飞书语音消息，配合 feishu-link 的 send_file(voice=true) 使用。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要转为语音的文字内容' },
        voice: { type: 'string', description: '音色：tts 模式传预置音色名（mimo_default/冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean），voicedesign 模式传自然语言音色描述', default: 'mimo_default' },
        provider: { type: 'string', description: '指定 provider：minimax/mimo。不指定则默认 mimo（mimo 失败自动降级 minimax）', default: '' },
        model: { type: 'string', description: '仅 MiMo 生效：tts（默认，预置音色）/ voicedesign（自然语言描述音色）', default: 'tts' },
      },
      required: ['text'],
    },
  },
  {
    name: 'transcribe_audio',
    description: '语音转文字（Doubao ASR）。接收任意本地音频文件路径（opus/mp3/wav/m4s/m4a等），自动转格式后调用 Doubao 转写为文字。返回转写文本。',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: '本地音频文件路径（绝对路径）' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'image_gen',
    description: '根据自然语言描述生成图片。默认走 Agnes（免费），Agnes 失败不自动降级，需询问用户是否切换其他 provider。可通过 provider 参数显式指定：agnes/stepfun/minimax/sensenova/grok。grok 经 aiproxy 调 xAI Imagine（套餐 API 用量，非默认）。model：minimax 用 image-01/image-01-live；grok 用 grok-imagine-image-pro/pro（默认首选）或 grok-imagine-image/cheap 或 grok-imagine-image-quality/quality。sensenova 专供信息图。prompt 含"信息图/手帐/架构图/带文字/海报"等关键词时自动走 sensenova。返回本地路径。【提示】非英文 prompt 会被自动翻译为英文（Agnes 路径），可设 no_translate=true 关闭。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片描述（自然语言）。非英文会自动翻译为英文（仅 Agnes 路径生效）' },
        aspect_ratio: { type: 'string', description: '图片比例（1:1, 3:4, 4:3, 16:9, 9:16）', default: '1:1' },
        subject_reference: { type: 'string', description: 'i2i 人物主体参考：本地图片绝对路径（jpg/png，<10MB，单人正面照效果最佳）。不传则走纯文生图。Grok 路径暂不支持 i2i' },
        provider: { type: 'string', description: '指定 provider：agnes/stepfun/minimax/sensenova/grok。不指定则走默认（当前 agnes）。grok 需显式指定', default: '' },
        model: { type: 'string', description: 'provider=minimax：image-01（写实）或 image-01-live。provider=grok：grok-imagine-image-pro/pro（默认首选）或 grok-imagine-image/cheap 或 grok-imagine-image-quality/quality' },
        style_type: { type: 'string', description: '艺术风格类型（仅 image-01-live）：漫画/元气/中世纪/水彩' },
        style_weight: { type: 'number', description: '风格强度（0-1]，默认 0.8', default: 0.8 },
        no_translate: { type: 'boolean', description: '关闭非英文 prompt 自动翻译（仅 Agnes 路径）。调用方已自行翻译时设 true 避免重复调用', default: false },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'video_gen',
    description: '视频生成。默认走 Agnes（免费），Agnes 失败不自动降级，需询问用户是否切换其他 provider。可通过 provider 参数显式指定：agnes/minimax/grok。grok 经 aiproxy 调 xAI Imagine 视频（套餐 API 用量，非默认；T2V/I2V，时长 1~15s）。支持文生视频（T2V）、单图图生视频（I2V）；Agnes 另支持首尾帧。下载到本地 output 目录。【提示】非英文 prompt 会被自动翻译为英文（Agnes 路径），可设 no_translate=true 关闭。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频文本描述，最大 2000 字符。非英文会自动翻译为英文（仅 Agnes 路径生效）。【风格控制】在 prompt 中加入风格关键词：cinematic/写实/电影级/realistic/动漫/anime 等。【运镜控制】在 prompt 中描述镜头运动，如 "camera slowly pushes in"、"镜头缓缓左移" 或使用 [左移]/[右移] 等指令。' },
        first_frame_image: { type: 'string', description: '图生视频首帧图片。本地文件绝对路径、HTTP(S) URL，或 data:image/...;base64,... Data URL。设置 last_frame_image 时进入关键帧模式（Agnes）' },
        last_frame_image: { type: 'string', description: '关键帧模式尾帧图片（Agnes）。本地文件绝对路径、HTTP(S) URL，或 Data URL。需配合 first_frame_image' },
        provider: { type: 'string', description: '指定 provider：agnes/minimax/grok。不指定则走默认（当前 agnes）。grok 需显式指定', default: '' },
        model: { type: 'string', description: 'provider=minimax：MiniMax-Hailuo-2.3 等。provider=grok：grok-imagine-video-1.5（默认）或 grok-imagine-video' },
        duration: { type: 'number', description: '视频时长（秒），默认 6。Agnes 3~18；MiniMax 6 或 10；Grok 1~15', default: 6 },
        resolution: { type: 'string', description: '分辨率。Agnes 720P/768P/1080P，默认 768P。MiniMax Hailuo 2.3 768P/1080P', default: '768P' },
        aigc_watermark: { type: 'boolean', description: '是否在视频上加 AIGC 水印，默认 false', default: false },
        negative_prompt: { type: 'string', description: 'Agnes 专用：负向提示词' },
        seed: { type: 'number', description: 'Agnes 专用：随机种子' },
        no_translate: { type: 'boolean', description: '关闭非英文 prompt 自动翻译（仅 Agnes 路径）', default: false },
      },
      required: ['prompt'],
    },
  },
]

// ── MCP Server ─────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'omnicore-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  process.stderr.write(`[omnicore] ${req.params.name}\n`)

  try {
    switch (req.params.name) {
      // ── image_describe ──
      case 'image_describe': {
        const prompt = (args.prompt as string) || '请描述这张图片'
        const imageSource = args.image_source as string
        const provider = (args.provider as string) || ''
        if (!imageSource) return { content: [{ type: 'text', text: 'image_source 必填' }], isError: true }

        // 指定 provider 模式
        if (provider) {
          const t0 = performance.now()
          let text: string
          switch (provider) {
            case 'agnes':
              text = await agnesDescribeImage(prompt, imageSource)
              break
            case 'mimo':
              text = await mimoDescribeImage(prompt, imageSource)
              break
            case 'doubao':
              text = await doubaoDescribeImage(imageSource, prompt)
              break
            case 'minimax':
              text = await miniMaxDescribeImage(prompt, imageSource)
              break
            default:
              return { content: [{ type: 'text', text: `未知 provider: ${provider}，可选: agnes/mimo/doubao/minimax` }], isError: true }
          }
          const elapsed = (performance.now() - t0).toFixed(0)
          return { content: [{ type: 'text', text: `[${provider} ${elapsed}ms]\n${text}` }] }
        }

        // 默认兜底链：Doubao（最快）→ MiMo → Agnes → MiniMax
        // 主路径：Doubao
        try {
          const text = await doubaoDescribeImage(imageSource, prompt)
          return { content: [{ type: 'text', text }] }
        } catch (e1: any) {
          process.stderr.write(`[omnicore] Doubao image_describe 失败，切 MiMo: ${e1.message}\n`)
        }

        // fallback 1: MiMo
        try {
          const text = await mimoDescribeImage(prompt, imageSource)
          return { content: [{ type: 'text', text }] }
        } catch (e2: any) {
          process.stderr.write(`[omnicore] MiMo image_describe 失败，切 Agnes: ${e2.message}\n`)
        }

        // fallback 2: Agnes
        try {
          const text = await agnesDescribeImage(prompt, imageSource)
          return { content: [{ type: 'text', text }] }
        } catch (e3: any) {
          process.stderr.write(`[omnicore] Agnes image_describe 失败，切 MiniMax 兜底: ${e3.message}\n`)
        }

        // fallback 3: MiniMax（兜底）
        try {
          const text = await miniMaxDescribeImage(prompt, imageSource)
          return { content: [{ type: 'text', text }] }
        } catch (e4: any) {
          return { content: [{ type: 'text', text: `Doubao/MiMo/Agnes/MiniMax 均失败: ${e4.message}` }], isError: true }
        }
      }

      // ── image_locate ──
      case 'image_locate': {
        const imagePath = args.image_path as string
        const prompt = args.prompt as string | undefined
        if (!imagePath) return { content: [{ type: 'text', text: 'image_path 必填' }], isError: true }
        const text = await doubaoLocateImage(imagePath, prompt)
        return { content: [{ type: 'text', text }] }
      }

      // ── video_analyze ──
      case 'video_analyze': {
        const videoPath = args.video_path as string
        const prompt = args.prompt as string | undefined
        if (!videoPath) return { content: [{ type: 'text', text: 'video_path 必填' }], isError: true }
        const text = await doubaoAnalyzeVideo(videoPath, prompt)
        return { content: [{ type: 'text', text }] }
      }

      // ── voice_gen ──
      case 'voice_gen': {
        const text = args.text as string
        const voice = (args.voice as string) || 'mimo_default'
        // 默认走 MiMo（按量付费免费档）；MiMo 失败 → 自动降级 MiniMax
        const requestedProvider = (args.provider as string) || 'mimo'
        const mimoModel = ((args.model as string) || 'tts') as 'tts' | 'voicedesign'
        if (!text) return { content: [{ type: 'text', text: 'text 必填' }], isError: true }
        if (!['minimax', 'mimo', ''].includes(requestedProvider)) {
          return { content: [{ type: 'text', text: `未知 provider: ${requestedProvider}，可选: minimax/mimo` }], isError: true }
        }

        const ts = Date.now()
        const mp3Path = join(OUTPUT_DIR, `voice_${ts}.mp3`)
        const opusPath = join(OUTPUT_DIR, `voice_${ts}.opus`)

        const VOICE_MAP: Record<string, string> = {
          'mimo_default': 'female-shaonv',
          '冰糖':         'female-tianmei',
          '茉莉':         'female-yujie',
          '苏打':         'male-qn-qingse',
          '白桦':         'male-qn-jingying',
          'Mia':          'female-chengshu',
          'Chloe':        'female-shaonv',
          'Milo':         'male-qn-daxuesheng',
          'Dean':         'male-qn-badao',
        }

        // 尝试链：先按 requestedProvider，失败再降级
        type Attempt = { provider: 'mimo' | 'minimax'; model?: 'tts' | 'voicedesign' }
        const attempts: Attempt[] = requestedProvider === 'minimax'
          ? [{ provider: 'minimax' }]
          : [{ provider: 'mimo', model: mimoModel }, { provider: 'minimax' }]

        const tried: { provider: string; error: string }[] = []
        for (const a of attempts) {
          try {
            let audioBuf: ArrayBuffer
            if (a.provider === 'mimo') {
              audioBuf = await mimoTts(text, voice, 'mp3', a.model)
            } else {
              const voiceId = VOICE_MAP[voice] || VOICE_MAP['mimo_default']
              audioBuf = await miniMaxTts(text, voiceId)
            }
            writeFileSync(mp3Path, Buffer.from(audioBuf))
            try { convertAudio(mp3Path, opusPath, { codec: 'libopus', bitrate: '32k' }) } catch {}

            const providerLabel = a.provider === 'mimo'
              ? `MiMo${a.model && a.model !== 'tts' ? ` (${a.model})` : ''}`
              : 'MiniMax'
            const lines = [`语音生成成功 (${providerLabel})`, `音色: ${voice}`, `文件: ${mp3Path}`]
            if (exists(opusPath)) lines.push(`opus: ${opusPath}`)
            if (tried.length) lines.push(`降级路径: ${tried.map(t => `${t.provider}(${t.error})`).join(' → ')} → ${a.provider}`)
            return { content: [{ type: 'text', text: lines.join('\n') }] }
          } catch (e: any) {
            tried.push({ provider: a.provider + (a.provider === 'mimo' && a.model ? `/${a.model}` : ''), error: e.message })
            // 继续尝试下一个
          }
        }
        return { content: [{ type: 'text', text: `TTS 生成失败（已尝试 ${tried.length} 次）: ${tried.map(t => `${t.provider}: ${t.error}`).join(' | ')}` }], isError: true }
      }

      // ── transcribe_audio ──
      case 'transcribe_audio': {
        const filePath = args.file_path as string
        if (!filePath) return { content: [{ type: 'text', text: 'file_path 必填' }], isError: true }
        const text = await doubaoTranscribeAudio(filePath)
        return { content: [{ type: 'text', text }] }
      }

      // ── image_gen ──
      case 'image_gen': {
        const prompt = args.prompt as string
        const aspectRatio = (args.aspect_ratio as string) || '1:1'
        const subjectRef = args.subject_reference as string | undefined
        const explicitProvider = args.provider as string | undefined

        // 信息图关键词检测：prompt 含信息图/手帐/带文字等 → 自动走 SenseNova U1 Fast
        const INFOGRAPHIC_KEYWORDS = [
          '信息图', 'infographic', '手帐', '手账', '架构图', '报告图',
          '带文字', '文字内容', '图表', '流程图', '信息图表',
          '信息面板', '数据图', '海报', 'poster', 'banner', '信息可视化',
        ]
        const isInfographic = INFOGRAPHIC_KEYWORDS.some(kw => prompt.toLowerCase().includes(kw))
        const provider = explicitProvider || (isInfographic ? 'sensenova' : DEFAULT_IMAGE_PROVIDER)

        const model = (args.model as string) || 'image-01'
        const styleType = args.style_type as string | undefined
        const styleWeight = args.style_weight as number | undefined
        const style = styleType ? { style_type: styleType, style_weight: styleWeight ?? 0.8 } : undefined
        if (!prompt) return { content: [{ type: 'text', text: 'prompt 必填' }], isError: true }

        let imageUrl: string
        const t0 = performance.now()

        switch (provider) {
          case 'agnes':
            try {
              imageUrl = await agnesGenerateImage(prompt, aspectRatio, subjectRef, args.no_translate === true)
            } catch (e: any) {
              return { content: [{ type: 'text', text: `Agnes 生图失败: ${e.message}\n\n可询问用户是否降级到 stepfun 或 minimax。` }], isError: true }
            }
            break
          case 'stepfun':
            try {
              imageUrl = await stepfunGenerateImage(prompt, aspectRatio, subjectRef)
            } catch (e: any) {
              return { content: [{ type: 'text', text: `StepFun 生图失败: ${e.message}\n\n可询问用户是否降级到 minimax。` }], isError: true }
            }
            break
          case 'minimax':
            try {
              imageUrl = await miniMaxGenerateImage(prompt, aspectRatio, subjectRef, model, style)
            } catch (e: any) {
              return { content: [{ type: 'text', text: `MiniMax 生图失败: ${e.message}` }], isError: true }
            }
            break
          case 'sensenova':
            try {
              imageUrl = await sensenovaGenerateImage(prompt, aspectRatio, subjectRef)
            } catch (e: any) {
              return { content: [{ type: 'text', text: `SenseNova U1 Fast 生图失败: ${e.message}\n\n可询问用户是否降级到 agnes。` }], isError: true }
            }
            break
          case 'grok':
            try {
              if (subjectRef) {
                return { content: [{ type: 'text', text: 'Grok 路径暂不支持 subject_reference（i2i），请去掉参考图或换 agnes/stepfun/minimax。' }], isError: true }
              }
              // model: cheap 默认 / quality；也接受官方全名
              imageUrl = await grokGenerateImage(prompt, aspectRatio, model)
            } catch (e: any) {
              return { content: [{ type: 'text', text: `Grok 生图失败: ${e.message}\n\n可询问用户是否改用 agnes/stepfun/minimax。` }], isError: true }
            }
            break
          default:
            return { content: [{ type: 'text', text: `未知 provider: ${provider}，可选: agnes/stepfun/minimax/sensenova/grok` }], isError: true }
        }

        const elapsed = (performance.now() - t0).toFixed(0)
        // 落盘：支持 http(s) URL 与 data: URL（grok/stepfun b64）
        let buf: Buffer
        let ext = 'png'
        if (imageUrl.startsWith('data:')) {
          const m = imageUrl.match(/^data:([^;]+);base64,(.+)$/s)
          if (!m) throw new Error('无效的 data URL')
          const mime = m[1]
          buf = Buffer.from(m[2], 'base64')
          if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg'
          else if (mime.includes('webp')) ext = 'webp'
          else ext = 'png'
        } else {
          const resp = await fetch(imageUrl)
          if (!resp.ok) throw new Error(`下载图片失败: ${resp.status}`)
          buf = Buffer.from(await resp.arrayBuffer())
          const ct = resp.headers.get('content-type') || ''
          if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpg'
        }
        const filename = `img_${Date.now()}.${ext}`
        const filepath = join(OUTPUT_DIR, filename)
        writeFileSync(filepath, buf)

        return { content: [{ type: 'text', text: `图片生成成功 (${provider} ${elapsed}ms)\n本地路径: ${filepath}` }] }
      }

      // ── video_gen ──
      case 'video_gen': {
        const prompt = args.prompt as string
        const firstFrameImage = args.first_frame_image as string | undefined
        const lastFrameImage = args.last_frame_image as string | undefined
        const provider = (args.provider as string) || DEFAULT_VIDEO_PROVIDER
        const model = args.model as string | undefined
        const duration = typeof args.duration === 'number' ? args.duration : 6
        const resolution = (args.resolution as string) || '768P'
        const aigcWatermark = args.aigc_watermark === true
        const negativePrompt = args.negative_prompt as string | undefined
        const seed = typeof args.seed === 'number' ? args.seed : undefined
        if (!prompt) return { content: [{ type: 'text', text: 'prompt 必填' }], isError: true }

        let result: any
        let usedProvider: string

        switch (provider) {
          case 'agnes':
            try {
              result = await agnesVideoGen({
                prompt,
                first_frame_image: firstFrameImage,
                last_frame_image: lastFrameImage,
                duration,
                resolution,
                negative_prompt: negativePrompt,
                seed,
                output_dir: OUTPUT_DIR,
                no_translate: args.no_translate === true,
              })
              usedProvider = 'agnes'
            } catch (e: any) {
              return { content: [{ type: 'text', text: `Agnes 视频生成失败: ${e.message}\n\n可询问用户是否降级到 minimax。` }], isError: true }
            }
            break
          case 'minimax':
            try {
              result = await miniMaxVideoGen({
                prompt,
                first_frame_image: firstFrameImage,
                model: model || 'MiniMax-Hailuo-2.3',
                duration,
                resolution,
                aigc_watermark: aigcWatermark,
                output_dir: OUTPUT_DIR,
              })
              usedProvider = 'minimax'
            } catch (e: any) {
              return { content: [{ type: 'text', text: `MiniMax 视频生成失败: ${e.message}` }], isError: true }
            }
            break
          case 'grok':
            try {
              if (lastFrameImage) {
                return { content: [{ type: 'text', text: 'Grok 视频暂不支持 last_frame_image（首尾帧），请只用 first_frame_image 或换 agnes。' }], isError: true }
              }
              result = await grokVideoGen({
                prompt,
                first_frame_image: firstFrameImage,
                model: model || 'grok-imagine-video-1.5',
                duration,
                resolution,
                output_dir: OUTPUT_DIR,
              })
              usedProvider = 'grok'
            } catch (e: any) {
              return { content: [{ type: 'text', text: `Grok 视频生成失败: ${e.message}\n\n可询问用户是否改用 agnes/minimax。` }], isError: true }
            }
            break
          default:
            return { content: [{ type: 'text', text: `未知 provider: ${provider}，可选: agnes/minimax/grok` }], isError: true }
        }

        const mode = lastFrameImage ? '关键帧 (keyframes)' : firstFrameImage ? '图生视频 (I2V)' : '文生视频 (T2V)'
        const elapsedSec = (result.elapsed_ms / 1000).toFixed(1)
        const lines = [
          `视频生成成功 (${usedProvider}, ${mode})`,
          `模型: ${result.model}`,
          `时长: ${result.duration}s | 分辨率: ${result.resolution} (${result.video_width}x${result.video_height})`,
          `task_id: ${result.task_id}`,
          `耗时: ${elapsedSec}s`,
          `文件大小: ${(result.file_bytes / 1024 / 1024).toFixed(2)} MB`,
          `本地路径: ${result.file_path}`,
        ]
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      default:
        return { content: [{ type: 'text', text: `未知工具: ${req.params.name}` }], isError: true }
    }
  } catch (err: any) {
    return { content: [{ type: 'text', text: `错误: ${err.message}` }], isError: true }
  }
})

// ── 辅助函数 ───────────────────────────────────────────────────────────────

function exists(p: string): boolean {
  try { return readFileSync(p).length > 0 } catch { return false }
}

// ── 启动 ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await mcp.connect(transport)
  process.stderr.write('[omnicore-mcp] started\n')
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`)
  process.exit(1)
})
