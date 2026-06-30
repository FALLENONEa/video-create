import { toFetchableUrl } from '@/lib/storage/utils'
import {
  getWavDurationFromBuffer,
  mergeWavBuffers,
  splitTextByLimit,
} from './tts'

/**
 * 百炼「声音复刻」（Voice Cloning）独立链路 —— 与 qwen3-tts（AI 设计音色）并行存在，互不干扰。
 *
 * 官方为「注册制」两步流程：
 * 1. 注册音色（一次性）：上传 10~20s 参考音频 → POST /services/audio/tts/customization
 *    （model: qwen-voice-enrollment）→ 返回持久化 voice_id
 * 2. 用 voice_id 合成：POST /services/aigc/multimodal-generation/generation
 *    （model: qwen3-tts-vc-*），payload: text + voice + language_type
 *
 * 约束：注册时的 target_model 必须与合成模型完全一致，音色不能跨模型复用。
 * 因此复刻产出的 voiceId 只能配 qwen3-tts-vc 系列模型使用。
 */

export const BAILIAN_VC_MODEL_ID = 'qwen3-tts-vc-2026-01-22'
const BAILIAN_VOICE_ENROLL_MODEL = 'qwen-voice-enrollment'
// Qwen-TTS 声音复刻必须走「工作空间作用域」host：{WorkspaceId}.cn-beijing.maas.aliyuncs.com。
// 通用域名 dashscope.aliyuncs.com 不认 customization 注册路径，会返回 InvalidParameter（400）。
// 工作空间 host 由调用方从用户百炼 provider 配置的 baseUrl 注入；缺省回退 dashscope 仅作兜底（注册会失败并透传百炼错误）。
const BAILIAN_DEFAULT_HOST = 'https://dashscope.aliyuncs.com'
const BAILIAN_VOICE_ENROLL_PATH = '/api/v1/services/audio/tts/customization'
const BAILIAN_VC_SYNTH_PATH = '/api/v1/services/aigc/multimodal-generation/generation'
const BAILIAN_VC_MAX_CHARS = 600

function resolveBailianHost(baseUrl?: string): string {
  let host = typeof baseUrl === 'string' ? baseUrl.trim() : ''
  // 去末尾斜杠；兼容用户误填 OpenAI 风格的 /api/v1 后缀（百炼工作空间 host 不带该后缀）
  host = host.replace(/\/+$/, '').replace(/\/api\/v\d+$/i, '')
  return host || BAILIAN_DEFAULT_HOST
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 百炼 preferred_name 规则：仅允许数字、英文字母、下划线，长度 ≤ 16。
 * 超出字符集或长度会被判 InvalidParameter，此处做兜底清洗（去非法字符 + 截断）。
 */
function sanitizePreferredName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 16)
}

// ============================================================
// 第一步：注册音色（上传参考音频 → 返回 voice_id）
// ============================================================

export interface BailianVoiceEnrollInput {
  /** 参考音频二进制（推荐 10~20s，≤10MB，WAV/MP3/M4A） */
  audioBuffer: Buffer
  /** 音频 MIME 类型，默认 audio/mpeg */
  mimeType?: string
  /** 音色名前缀，缺省用时间戳 */
  preferredName?: string
  /** 绑定的合成模型，必须与后续合成模型一致，默认 qwen3-tts-vc */
  targetModel?: string
  apiKey: string
  /** 百炼工作空间作用域 host（{WorkspaceId}.cn-beijing.maas.aliyuncs.com）；缺省回退 dashscope 通用域名 */
  baseUrl?: string
}

export interface BailianVoiceEnrollResult {
  success: boolean
  voiceId?: string
  error?: string
}

/**
 * 注册复刻音色。audio.data 用 base64 data URI 内联（最稳，不依赖阿里侧回拉我们的对象存储）。
 */
export async function bailianEnrollVoice(
  input: BailianVoiceEnrollInput,
): Promise<BailianVoiceEnrollResult> {
  const apiKey = readTrimmedString(input.apiKey)
  if (!apiKey) return { success: false, error: 'BAILIAN_API_KEY_REQUIRED' }
  const audioBuffer = input.audioBuffer
  if (!audioBuffer || audioBuffer.length === 0) {
    return { success: false, error: 'BAILIAN_VOICE_ENROLL_AUDIO_REQUIRED' }
  }

  const mimeType = readTrimmedString(input.mimeType) || 'audio/mpeg'
  const targetModel = readTrimmedString(input.targetModel) || BAILIAN_VC_MODEL_ID
  const preferredName = sanitizePreferredName(readTrimmedString(input.preferredName)) || `clone_${Date.now().toString(36)}`
  const dataUri = `data:${mimeType};base64,${audioBuffer.toString('base64')}`

  const enrollEndpoint = `${resolveBailianHost(input.baseUrl)}${BAILIAN_VOICE_ENROLL_PATH}`
  try {
    const response = await fetch(enrollEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: BAILIAN_VOICE_ENROLL_MODEL,
        input: {
          action: 'create',
          target_model: targetModel,
          preferred_name: preferredName,
          audio: { data: dataUri },
        },
      }),
    })
    const data = (await response.json().catch(() => null)) as {
      code?: string
      message?: string
      output?: { voice?: string }
    } | null

    if (!response.ok) {
      const code = readTrimmedString(data?.code)
      const message = readTrimmedString(data?.message)
      const detail = [code, message].filter(Boolean).join(' - ')
      return {
        success: false,
        error: `BAILIAN_VOICE_ENROLL_FAILED(${response.status}): ${detail || 'unknown error'}`,
      }
    }
    const voiceId = readTrimmedString(data?.output?.voice)
    if (!voiceId) {
      return { success: false, error: 'BAILIAN_VOICE_ENROLL_NO_VOICE_ID' }
    }
    return { success: true, voiceId }
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'BAILIAN_VOICE_ENROLL_UNKNOWN_ERROR',
    }
  }
}

// ============================================================
// 第二步：用复刻 voice_id 合成语音
// ============================================================

export interface BailianVCSynthInput {
  text: string
  voiceId: string
  modelId?: string
  /** 合成语种，建议与文本一致以保证发音/语调，默认 Chinese（与 qwen3-tts 对齐） */
  languageType?: string
  apiKey: string
  /** 百炼工作空间作用域 host；复刻合成同样建议走工作空间 host，与注册一致 */
  baseUrl?: string
}

export interface BailianVCSynthResult {
  success: boolean
  audioData?: Buffer
  audioDuration?: number
  audioUrl?: string
  requestId?: string
  error?: string
}

interface VCResponse {
  request_id?: string
  code?: string
  message?: string
  output?: { audio?: { data?: string; url?: string } }
  usage?: { characters?: number }
}

async function readVCAudioBuffer(
  audio: { data?: string; url?: string } | undefined,
): Promise<{ buffer: Buffer; url?: string }> {
  const dataB64 = readTrimmedString(audio?.data)
  const url = readTrimmedString(audio?.url)
  if (dataB64) {
    return { buffer: Buffer.from(dataB64, 'base64'), url: url || undefined }
  }
  if (!url) {
    throw new Error('BAILIAN_VC_AUDIO_MISSING')
  }
  const resp = await fetch(toFetchableUrl(url))
  if (!resp.ok) {
    throw new Error(`BAILIAN_VC_AUDIO_DOWNLOAD_FAILED(${resp.status})`)
  }
  return { buffer: Buffer.from(await resp.arrayBuffer()), url }
}

async function synthSegment(params: {
  text: string
  voiceId: string
  modelId: string
  languageType: string
  apiKey: string
  baseUrl?: string
}): Promise<{ buffer: Buffer; url?: string; requestId?: string }> {
  const synthEndpoint = `${resolveBailianHost(params.baseUrl)}${BAILIAN_VC_SYNTH_PATH}`
  const response = await fetch(synthEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      'Content-Type': 'application/json',
    },
    // VC 合成走非实时语音合成接口（multimodal-generation），payload: text + voice + language_type
    // （language_type 与官方 Qwen-TTS 示例及现网 qwen3-tts 一致，保证中文发音/语调正确）
    body: JSON.stringify({
      model: params.modelId,
      input: {
        text: params.text,
        voice: params.voiceId,
        language_type: params.languageType,
      },
    }),
  })
  const data = (await response.json().catch(() => null)) as VCResponse | null
  if (!response.ok) {
    const code = readTrimmedString(data?.code)
    const message = readTrimmedString(data?.message)
    const detail = [code, message].filter(Boolean).join(' - ')
    throw new Error(`BAILIAN_VC_FAILED(${response.status}): ${detail || 'unknown error'}`)
  }
  const audio = data?.output?.audio
  if (!audio) {
    throw new Error('BAILIAN_VC_OUTPUT_AUDIO_MISSING')
  }
  const result = await readVCAudioBuffer(audio)
  return {
    buffer: result.buffer,
    url: result.url,
    requestId: readTrimmedString(data?.request_id) || undefined,
  }
}

/**
 * 用复刻 voice_id 合成语音。长文本按 BAILIAN_VC_MAX_CHARS 分段，WAV 合并返回。
 */
export async function bailianSynthesizeClonedVoice(
  input: BailianVCSynthInput,
): Promise<BailianVCSynthResult> {
  const apiKey = readTrimmedString(input.apiKey)
  const text = readTrimmedString(input.text)
  const voiceId = readTrimmedString(input.voiceId)
  const modelId = readTrimmedString(input.modelId) || BAILIAN_VC_MODEL_ID
  const languageType = readTrimmedString(input.languageType) || 'Chinese'
  const baseUrl = readTrimmedString(input.baseUrl) || undefined

  if (!apiKey) return { success: false, error: 'BAILIAN_API_KEY_REQUIRED' }
  if (!text) return { success: false, error: 'BAILIAN_VC_TEXT_REQUIRED' }
  if (!voiceId) return { success: false, error: 'BAILIAN_VC_VOICE_ID_REQUIRED' }

  const segments = splitTextByLimit(text, BAILIAN_VC_MAX_CHARS)
  if (segments.length === 0) {
    return { success: false, error: 'BAILIAN_VC_TEXT_REQUIRED' }
  }

  try {
    const buffers: Buffer[] = []
    let firstUrl: string | undefined
    let lastRequestId: string | undefined
    for (const segment of segments) {
      const r = await synthSegment({ text: segment, voiceId, modelId, languageType, apiKey, baseUrl })
      buffers.push(r.buffer)
      if (!firstUrl && r.url) firstUrl = r.url
      if (r.requestId) lastRequestId = r.requestId
    }
    const merged = mergeWavBuffers(buffers)
    return {
      success: true,
      audioData: merged,
      audioDuration: getWavDurationFromBuffer(merged),
      audioUrl: segments.length === 1 ? firstUrl : undefined,
      requestId: lastRequestId,
    }
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'BAILIAN_VC_UNKNOWN_ERROR',
    }
  }
}
