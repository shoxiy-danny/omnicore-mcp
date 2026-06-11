#!/usr/bin/env bun
/**
 * OmniCore MCP — 统一多模态入口
 *
 * 工具：
 *   image_describe  — 图片内容描述（MiniMax 主 → Doubao fallback）
 *   image_locate    — 图片视觉定位（Doubao bbox）
 *   video_analyze   — 视频分析（Doubao）
 *   voice_gen       — 文字转语音（MiMo 主 → MiniMax fallback）
 *   image_gen       — 图片生成（MiniMax image-01）
 *   video_gen       — 海螺视频生成（MiniMax Hailuo 2.3，T2V + I2V，带 [指令] 运镜支持）
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

mkdirSync(OUTPUT_DIR, { recursive: true })

// ── Provider 导入 ──────────────────────────────────────────────────────────

import { miniMaxDescribeImage, miniMaxGenerateImage, miniMaxTts, miniMaxVideoGen } from './providers/minimax.js'
import { doubaoLocateImage, doubaoAnalyzeVideo, doubaoDescribeImage } from './providers/doubao.js'
import { mimoTts } from './providers/mimo.js'
import { convertAudio, cleanupFiles } from './utils/ffmpeg.js'

// ── 工具定义 ───────────────────────────────────────────────────────────────

const tools = [
  {
    name: 'image_describe',
    description: '详细描述/分析图片内容。支持 URL 和本地文件，优先走 MiniMax（效果好），失败自动切 Doubao。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '对图片的提问或指令，如"这张图片里有什么？"', default: '请描述这张图片' },
        image_source: { type: 'string', description: '图片来源：HTTP(S) URL 或本地文件绝对路径' },
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
    description: '文字转语音。输入文字，生成语音音频文件（mp3），返回本地路径。注意：只生成音频文件，不发送到飞书。如需发飞书语音消息，配合 feishu-link 的 send_file(voice=true) 使用。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要转为语音的文字内容' },
        voice: { type: 'string', description: '音色：mimo_default/冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean', default: 'mimo_default' },
      },
      required: ['text'],
    },
  },
  {
    name: 'image_gen',
    description: '根据自然语言描述生成图片。支持 image-01（写实）和 image-01-live（艺术风格），返回本地路径。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片描述（自然语言）' },
        aspect_ratio: { type: 'string', description: '图片比例（1:1, 3:4, 4:3, 16:9, 9:16）', default: '1:1' },
        subject_reference: { type: 'string', description: 'i2i 人物主体参考：本地图片绝对路径（jpg/png，<10MB，单人正面照效果最佳）。不传则走纯文生图' },
        model: { type: 'string', description: '模型：image-01（写实）或 image-01-live（艺术风格）', default: 'image-01' },
        style_type: { type: 'string', description: '艺术风格类型（仅 image-01-live）：漫画/元气/中世纪/水彩' },
        style_weight: { type: 'number', description: '风格强度（0-1]，默认 0.8', default: 0.8 },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'video_gen',
    description: '海螺视频生成（MiniMax Hailuo）。支持文生视频（T2V）和图生视频（I2V），默认使用 MiniMax-Hailuo-2.3 模型（支持 [指令] 运镜控制）。异步任务，5 秒轮询一次，约 1-3 分钟返回，下载到本地 output 目录。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频文本描述，最大 2000 字符。支持运镜指令：[左移]/[右移]/[左摇]/[右摇]/[推进]/[拉远]/[上升]/[下降]/[上摇]/[下摇]/[变焦推近]/[变焦拉远]/[晃动]/[跟随]/[固定]，可组合如 [左摇,上升] 或顺序使用 [...[推进],然后...[拉远]]' },
        first_frame_image: { type: 'string', description: '图生视频必填：首帧图片。本地文件绝对路径、HTTP(S) URL，或 data:image/...;base64,... Data URL' },
        model: { type: 'string', description: '模型名。默认 MiniMax-Hailuo-2.3。可选：MiniMax-Hailuo-2.3 / MiniMax-Hailuo-2.3-Fast（I2V 快速版）/ MiniMax-Hailuo-02 / T2V-01-Director / T2V-01 / I2V-01-Director / I2V-01-live / I2V-01', default: 'MiniMax-Hailuo-2.3' },
        duration: { type: 'number', description: '视频时长（秒），默认 6。Hailuo 2.3 768P 可选 6 或 10，1080P 仅 6', default: 6 },
        resolution: { type: 'string', description: '分辨率。Hailuo 2.3 默认 768P，可选 1080P。其他模型 720P', default: '768P' },
        aigc_watermark: { type: 'boolean', description: '是否在视频上加 AIGC 水印，默认 false', default: false },
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
        if (!imageSource) return { content: [{ type: 'text', text: 'image_source 必填' }], isError: true }

        try {
          const text = await miniMaxDescribeImage(prompt, imageSource)
          return { content: [{ type: 'text', text }] }
        } catch (e1: any) {
          process.stderr.write(`[omnicore] MiniMax image_describe 失败，切 Doubao: ${e1.message}\n`)
          try {
            const text = await doubaoDescribeImage(imageSource, prompt)
            return { content: [{ type: 'text', text }] }
          } catch (e2: any) {
            return { content: [{ type: 'text', text: `Doubao 也失败: ${e2.message}` }], isError: true }
          }
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
        if (!text) return { content: [{ type: 'text', text: 'text 必填' }], isError: true }

        const ts = Date.now()
        const mp3Path = join(OUTPUT_DIR, `voice_${ts}.mp3`)
        const opusPath = join(OUTPUT_DIR, `voice_${ts}.opus`)

        try {
          // 主路径：MiMo TTS
          const audioBuf = await mimoTts(text, voice, 'mp3')
          writeFileSync(mp3Path, Buffer.from(audioBuf))

          // 顺便转一份 opus（方便飞书语音使用）
          try {
            convertAudio(mp3Path, opusPath, { codec: 'libopus', bitrate: '32k' })
          } catch {}

          const lines = [`语音生成成功`, `音色: ${voice}`, `文件: ${mp3Path}`]
          if (exists(opusPath)) lines.push(`opus: ${opusPath}`)
          return { content: [{ type: 'text', text: lines.join('\n') }] }
        } catch (e1: any) {
          process.stderr.write(`[omnicore] MiMo TTS 失败，切 MiniMax: ${e1.message}\n`)
          try {
            const audioBuf = await miniMaxTts(text, voice)
            writeFileSync(mp3Path, Buffer.from(audioBuf))
            return { content: [{ type: 'text', text: `语音生成成功 (MiniMax fallback)\n音色: ${voice}\n文件: ${mp3Path}` }] }
          } catch (e2: any) {
            return { content: [{ type: 'text', text: `TTS 生成失败 (MiMo + MiniMax 均失败): ${e2.message}` }], isError: true }
          }
        }
      }

      // ── image_gen ──
      case 'image_gen': {
        const prompt = args.prompt as string
        const aspectRatio = (args.aspect_ratio as string) || '1:1'
        const subjectRef = args.subject_reference as string | undefined
        const model = (args.model as string) || 'image-01'
        const styleType = args.style_type as string | undefined
        const styleWeight = args.style_weight as number | undefined
        const style = styleType ? { style_type: styleType, style_weight: styleWeight ?? 0.8 } : undefined
        if (!prompt) return { content: [{ type: 'text', text: 'prompt 必填' }], isError: true }

        // 提示词优化（仅 t2i；i2i 保持 prompt 干净避免干扰主体特征提取）
        const optimized = subjectRef
          ? prompt
          : (() => {
              const qualityPrefixes = ['highly detailed', '4k resolution', 'professional photography']
              const shuffled = qualityPrefixes.sort(() => Math.random() - 0.5)
              const qualities = shuffled.slice(0, 2).join(', ')
              return `${prompt}, ${qualities}, masterpiece, best quality`
            })()

        const imageUrl = await miniMaxGenerateImage(optimized, aspectRatio, subjectRef, model, style)

        // 下载到本地
        const resp = await fetch(imageUrl)
        if (!resp.ok) throw new Error(`下载图片失败: ${resp.status}`)
        const buf = await resp.arrayBuffer()
        const filename = `img_${Date.now()}.png`
        const filepath = join(OUTPUT_DIR, filename)
        writeFileSync(filepath, Buffer.from(buf))

        return { content: [{ type: 'text', text: `图片生成成功\n优化提示词: ${optimized}\n本地路径: ${filepath}` }] }
      }

      // ── video_gen ──
      case 'video_gen': {
        const prompt = args.prompt as string
        const firstFrameImage = args.first_frame_image as string | undefined
        const model = args.model as string | undefined
        const duration = typeof args.duration === 'number' ? args.duration : 6
        const resolution = (args.resolution as string) || '768P'
        const aigcWatermark = args.aigc_watermark === true
        if (!prompt) return { content: [{ type: 'text', text: 'prompt 必填' }], isError: true }

        const result = await miniMaxVideoGen({
          prompt,
          first_frame_image: firstFrameImage,
          model,
          duration,
          resolution,
          aigc_watermark: aigcWatermark,
          output_dir: OUTPUT_DIR,
        })

        const mode = firstFrameImage ? '图生视频 (I2V)' : '文生视频 (T2V)'
        const elapsedSec = (result.elapsed_ms / 1000).toFixed(1)
        const lines = [
          `视频生成成功 (${mode})`,
          `模型: ${result.model}`,
          `时长: ${result.duration}s | 分辨率: ${result.resolution} (${result.video_width}x${result.video_height})`,
          `task_id: ${result.task_id}`,
          `file_id: ${result.file_id}`,
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
