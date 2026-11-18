# OmniCore MCP

统一多模态入口 MCP Server —— 把多家 AI 模型（识图 / 生图 / 视频 / 语音）聚合成一个 MCP 接口。image_gen / video_gen 默认走 Agnes。Doubao/Seedream/MiniMax 2026-10-15 停用放到队尾（`DOUBAO_ENABLED` / `MINIMAX_ENABLED`）。失败不自动降级（需显式指定 provider 切换）。

## 特性

- **11 个工具**：文字识别、图片描述、视觉定位、视频分析、TTS、音频生成、语音转写、图片生成、视频生成、文件取回
- **多 provider 兜底链**：主路径失败自动切备用，不中断调用方
- **统一接口**：所有能力通过 MCP 协议暴露，支持 Claude Desktop / Claude Code / 任何 MCP 客户端

## 工具列表

| 工具 | 主路径 | 降级方式 |
|------|--------|----------|
| `ocr_recognize` | DeepSeek OCR | —（唯一通道）。PDF/Word/PPT/图片按页返回；`purpose=rich_layout_recognition` 带 0-1000 归一化坐标 |
| `image_describe` | Doubao Seed-2.0-mini | Seed-2.1-lite → StepFun → Agnes（MiMo/MiniMax 停用） |
| `image_locate` | Doubao Seed-2.1-lite | Seed-2.0-mini（精度优先） |
| `video_analyze` | Doubao Seed-2.0-mini | Seed-2.1-lite |
| `voice_gen` | MiMo | DeepSeek TTS（wav→mp3→opus，音色映射 stella/tide）；MiniMax 停用 |
| `audio_gen` | StepFun StepAudio 3 Gen | —（人声+音效+BGM 一条指令编排） |
| `transcribe_audio` | StepFun ASR | Doubao Seed-2.1-lite → Seed-2.0-mini → DeepSeek ASR（自动转码 + 120s 切片） |
| `image_gen` | Agnes | 显式 `provider` 切 stepfun/sensenova/grok。seedream/minimax 停用。sensenova 默认 `u1.5-lite` 无水印；grok 默认 `grok-imagine-image-2.0` |
| `video_gen` | Agnes | 默认模型 `agnes-video-2.5-flash`：`size=720P/960P/2K`（免费 key 仅 720P），带音频；不支持 negative_prompt / 首尾帧。显式指定 `provider` 切换 grok（minimax 停用） |
| `share_get` | 读 `share/` | 只一层文件名。要 `OMNICORE_SHARE_TOKEN` 或连接头里的密钥 |
| `output_get` | 读当次 `output/` | 要 `file_id` + `file_token`，只回 HTTPS 下载地址 |

**`ocr_recognize` 与 `image_describe` 的分工**：前者是「抄」（原文、按页、带坐标、吃 PDF），后者是「懂」（内容、风格、界面问题）。要逐字抄录别指望 `image_describe` 的默认输出——它默认给摘要，需在 prompt 里写死「逐字抄录、不要概括」。

## 依赖

- [Bun](https://bun.sh/) — 运行时（`package.json` 用 `bun run`）
- [ffmpeg](https://ffmpeg.org/) — 语音转写音频转码（opus→wav / 16k PCM）、TTS 产物转 mp3，需在系统 PATH 中

```bash
# 安装 Bun
curl -fsSL https://bun.sh/install | bash

# 安装 ffmpeg（Ubuntu/Debian）
sudo apt install ffmpeg
# macOS
brew install ffmpeg
```

## 安装

```bash
git clone https://github.com/shoxiy-danny/omnicore-mcp.git
cd omnicore-mcp
bun install
```
## 配置

复制 `.env.example` 为 `.env`，填入你的 API key：

```bash
cp .env.example .env
```

各 provider 申请入口：

| Provider | 用途 | 申请入口 |
|----------|------|----------|
| Agnes (Sapiens AI) | 生图 / 视频 / 识图（免费额度） | https://agnes-ai.com/ |
| Doubao (火山引擎) | 识图/视频 Seed-2.0-mini、bbox/ASR Seed-2.1-lite、生图 Seedream-5.0-pro | https://www.volcengine.com/product/doubao |
| MiMo (小米) | TTS / 识图 | https://www.xiaomimimo.com/ |
| MiniMax | 全功能兜底（付费） | https://platform.minimaxi.com/ |
| StepFun | 生图 fallback（免费额度） | https://www.stepfun.com/ |
| DeepSeek | OCR（唯一通道）/ ASR/TTS（队尾兜底） | https://platform.deepseek.com/api_keys |
| Grok (xAI) | 生图 / 视频（经 aiproxy，套餐 API 用量） | 需 AIPROXY_BASE_URL + AIPROXY_API_KEY |

**最低配置**：只配 `AGNES_API_KEY` + `DOUBAO_API_KEY` 即可使用大部分工具。Grok 需额外配置 `AIPROXY_BASE_URL` + `AIPROXY_API_KEY`。其他 key 按需配置，缺失的 provider 会在兜底链中自动跳过。

## 接入 MCP 客户端

### Claude Desktop

编辑配置文件（macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "omnicore": {
      "command": "bun",
      "args": ["/absolute/path/to/omnicore-mcp/src/server.ts"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add omnicore -- bun /absolute/path/to/omnicore-mcp/src/server.ts
```

### 其他 MCP 客户端

按对应客户端文档添加 stdio 类型的 MCP server，command 为 `bun`，args 指向 `src/server.ts` 绝对路径。

## 使用示例

配置完成后，客户端会自动发现 7 个工具。调用示例：

```
帮我描述这张图片：/path/to/image.png
帮我把这段话转成语音：你好世界
帮我生成一张 16:9 的日落图
分析这个视频的内容：/path/to/video.mp4
用 Grok 生一张图（provider=grok）
用 Grok 生一段视频（provider=grok, duration=6）
```

## 项目结构

```
src/
├── server.ts              # MCP server 入口 + 工具定义
├── providers/
│   ├── agnes.ts           # Agnes AI（生图 / 视频 / 识图）
│   ├── doubao.ts          # Doubao Seed-2.0-mini / 2.1-lite（识图·视频 mini 主，bbox·ASR lite 主）
│   ├── deepseek.ts        # DeepSeek（OCR / ASR / TTS）
│   ├── seedream.ts        # Doubao-Seedream-5.0-pro（生图）
│   ├── grok.ts            # Grok xAI Imagine（经 aiproxy，生图 / 视频）
│   ├── mimo.ts            # MiMo（TTS / 识图）
│   ├── minimax.ts         # MiniMax（全功能兜底）
│   ├── sensenova.ts       # SenseNova U1.5 Lite（信息图生图，默认无水印）
│   └── stepfun.ts         # StepFun（生图 / 识图 / ASR fallback）
└── utils/
    ├── ffmpeg.ts          # 音频转码 + 视频 remux（飞书兼容）
    └── security.ts        # 路径校验 / SSRF 防护 / 命令注入防护
```

## 安全

所有用户输入的文件路径和 URL 都经过 `src/utils/security.ts` 校验：

- **路径穿越防护**：拒绝 `/etc /dev /proc /sys /root /var/log` 及 `.ssh .env id_rsa providers.json .aws .gnupg` 等敏感路径
- **SSRF 防护**：拒绝 localhost / 内网 IP（10.x / 172.16-31.x / 192.168.x / 169.254.x）/ `.local .internal` 域名
- **命令注入防护**：ffmpeg 命令拼接用 `shellQuote` 单引号转义
- **文件大小上限**：图片 50MB / 视频 100MB / 音频 50MB，防撑爆内存

## License

MIT
