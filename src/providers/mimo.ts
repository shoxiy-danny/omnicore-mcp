/**
 * MiMo TTS 封装
 *
 * 端点：MIMO_API_HOST/v1/chat/completions
 * 模型：mimo-v2.5-tts（预置音色）、mimo-v2.5-tts-voicedesign（自定义音色）
 */

const MIMO_API_KEY = process.env.MIMO_API_KEY ?? ''
const MIMO_API_HOST = process.env.MIMO_API_HOST ?? 'https://token-plan-cn.xiaomimimo.com'

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
