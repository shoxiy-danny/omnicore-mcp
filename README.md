# OmniCore MCP

统一多模态入口 MCP Server —— 把多家 AI 模型（识图 / 生图 / 视频 / 语音）聚合成一个 MCP 接口，带自动兜底链。

## 特性

- **7 个工具**：图片描述、视觉定位、视频分析、TTS、语音转写、图片生成、视频生成
- **多 provider 兜底链**：主路径失败自动切备用，不中断调用方
- **统一接口**：所有能力通过 MCP 协议暴露，支持 Claude Desktop / Claude Code / 任何 MCP 客户端

## 工具列表

| 工具 | 主路径 | 兜底链 |
|------|--------|--------|
| `image_describe` | Doubao | MiMo → Agnes → MiniMax |
| `image_locate` | Doubao | — |
| `video_analyze` | Doubao | — |
| `voice_gen` | MiMo | MiniMax |
| `transcribe_audio` | Doubao | — |
| `image_gen` | Agnes | StepFun → MiniMax |
| `video_gen` | Agnes | MiniMax Hailuo |

## 依赖

- [Bun](https://bun.sh/) — 运行时（`package.json` 用 `bun run`）
- [ffmpeg](https://ffmpeg.org/) — 语音转写和音频转码必需，需在系统 PATH 中

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
| Doubao (火山引擎) | 识图 / 视频分析 / 语音转写 | https://www.volcengine.com/product/doubao |
| MiMo (小米) | TTS / 识图 | https://www.xiaomimimo.com/ |
| MiniMax | 全功能兜底（付费） | https://platform.minimaxi.com/ |
| StepFun | 生图 fallback（免费额度） | https://www.stepfun.com/ |

**最低配置**：只配 `AGNES_API_KEY` + `DOUBAO_API_KEY` 即可使用大部分工具。其他 key 按需配置，缺失的 provider 会在兜底链中自动跳过。

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
```

## 项目结构

```
src/
├── server.ts              # MCP server 入口 + 工具定义
├── providers/
│   ├── agnes.ts           # Agnes AI（生图 / 视频 / 识图）
│   ├── doubao.ts          # Doubao（识图 / 视频 / 语音转写）
│   ├── mimo.ts            # MiMo（TTS / 识图）
│   ├── minimax.ts         # MiniMax（全功能兜底）
│   └── stepfun.ts         # StepFun（生图 fallback）
└── utils/
    └── ffmpeg.ts          # 音频转码工具
```

## License

MIT
