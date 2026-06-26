import { logInfo as _ulogInfo, logError as _ulogError } from '@/lib/logging/core'
/**
 * 智谱 AI（Zhipu / BigModel）API 统一调用工具
 *
 * 视频生成（CogVideoX 系列）走异步任务：
 * - POST /videos/generations  提交任务 → 返回 { id }
 * - GET  /async-result/{id}    轮询结果 → { task_status, video_result }
 *
 * 智谱整体为 OpenAI 兼容设计，鉴权统一 Bearer apiKey，
 * base 固定 https://open.bigmodel.cn/api/paas/v4。
 */

export const ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'

const DEFAULT_TIMEOUT_MS = 60_000

/** 视频生成请求体。image_url 单图为 URL/base64 字符串，首尾帧为 [首帧, 尾帧] 数组。 */
export interface ZhipuVideoGenerationRequest {
    model: string
    prompt: string
    image_url?: string | string[]
    quality?: 'quality' | 'speed'
    with_audio?: boolean
    watermark_enabled?: boolean
    size?: string // 像素格式，如 "1920x1080"，最高 4K "3840x2160"
    fps?: number // 30 | 60
    duration?: number // 视频持续时长，支持 5 | 10，默认 5
}

/** 异步任务结果（视频/图像通用查询接口的响应）。 */
export interface ZhipuAsyncResult {
    id?: string
    model?: string
    task_status?: string // SUCCESS | FAIL | processing
    video_result?: Array<{ url?: string; cover_image_url?: string }>
    image_result?: Array<{ url?: string }>
    request_id?: string
    error?: { code?: string; message?: string }
}

async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        return await fetch(url, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

function safeJson(text: string): unknown {
    const trimmed = text.trim()
    if (!trimmed) return null
    try {
        return JSON.parse(trimmed)
    } catch {
        return trimmed
    }
}

/** 智谱错误体优先取 $.error.message，兜底 $.message 或原始文本片段。 */
function extractZhipuError(payload: unknown, fallback: string): string {
    if (payload && typeof payload === 'object') {
        const err = (payload as { error?: { message?: unknown } }).error
        if (err && typeof err.message === 'string' && err.message.trim()) return err.message.trim()
        const msg = (payload as { message?: unknown }).message
        if (typeof msg === 'string' && msg.trim()) return msg.trim()
    }
    if (typeof payload === 'string' && payload.trim()) return payload.trim().slice(0, 300)
    return fallback
}

/**
 * 提交视频生成任务（异步），返回 { id, ...原始响应 }。
 */
export async function zhipuCreateVideoTask(
    request: ZhipuVideoGenerationRequest,
    options: { apiKey: string; logPrefix?: string },
): Promise<{ id: string } & Record<string, unknown>> {
    if (!options.apiKey) throw new Error('请配置智谱 API Key')
    const logPrefix = options.logPrefix || '[Zhipu Video]'
    const isFlFL = Array.isArray(request.image_url) && request.image_url.length >= 2
    _ulogInfo(`${logPrefix} 创建视频任务, 模型=${request.model}, 首尾帧=${isFlFL}, size=${request.size || '(默认)'}`)

    const response = await fetchWithTimeout(`${ZHIPU_BASE_URL}/videos/generations`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(request),
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) {
        const message = extractZhipuError(safeJson(text), `${logPrefix} 创建视频任务失败: ${response.status}`)
        _ulogError(`${logPrefix} 创建失败: ${response.status} ${message}`)
        throw new Error(`${logPrefix} 创建视频任务失败: ${message}`)
    }
    const data = safeJson(text) as { id?: string } & Record<string, unknown>
    const taskId = typeof data?.id === 'string' ? data.id.trim() : ''
    if (!taskId) {
        throw new Error(`${logPrefix} 响应缺少 task id`)
    }
    _ulogInfo(`${logPrefix} 视频任务创建成功, taskId=${taskId}`)
    return { id: taskId, ...(data as Record<string, unknown>) }
}

/**
 * 查询异步任务结果。
 * HTTP 失败（网络异常 / 非 2xx）时返回 null —— 调用方按 pending 处理，
 * 轮询循环会在下一轮天然重试，避免临时网络抖动直接判失败。
 */
export async function zhipuQueryAsyncResult(
    taskId: string,
    options: { apiKey: string; logPrefix?: string },
): Promise<ZhipuAsyncResult | null> {
    if (!options.apiKey) throw new Error('请配置智谱 API Key')
    const logPrefix = options.logPrefix || '[Zhipu Poll]'
    let response: Response
    try {
        response = await fetchWithTimeout(`${ZHIPU_BASE_URL}/async-result/${encodeURIComponent(taskId)}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${options.apiKey}` },
        })
    } catch (error: unknown) {
        _ulogError(`${logPrefix} 查询异常 taskId=${taskId}`, error)
        return null
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) {
        _ulogError(`${logPrefix} 查询失败 taskId=${taskId}: ${response.status} ${text.slice(0, 200)}`)
        return null
    }
    return (safeJson(text) as ZhipuAsyncResult) || null
}

/**
 * 图像生成请求体。size 为像素格式，如 "1024x1024"。
 */
export interface ZhipuImageGenerationRequest {
    model: string
    prompt: string
    size?: string
}

/** 图像生成响应（OpenAI 兼容）。 */
export interface ZhipuImageResult {
    data?: Array<{ url?: string; b64_json?: string }>
    model?: string
    error?: { code?: string; message?: string }
}

/**
 * 生成图像（同步）。POST /images/generations。
 * 返回 { data: [{ url }] } 结构。
 */
export async function zhipuCreateImage(
    request: ZhipuImageGenerationRequest,
    options: { apiKey: string; logPrefix?: string },
): Promise<ZhipuImageResult> {
    if (!options.apiKey) throw new Error('请配置智谱 API Key')
    const logPrefix = options.logPrefix || '[Zhipu Image]'
    const response = await fetchWithTimeout(`${ZHIPU_BASE_URL}/images/generations`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(request),
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) {
        const message = extractZhipuError(safeJson(text), `${logPrefix} 图像生成失败: ${response.status}`)
        _ulogError(`${logPrefix} 失败: ${response.status} ${message}`)
        throw new Error(`${logPrefix} 图像生成失败: ${message}`)
    }
    const result = (safeJson(text) as ZhipuImageResult) || null
    if (!result) {
        throw new Error(`${logPrefix} 图像生成响应为空`)
    }
    return result
}

/** 音色复刻请求体（POST /voice/clone）。 */
export interface ZhipuVoiceCloneRequest {
    model: 'glm-tts-clone'
    voice_name: string
    file_id: string
    input: string
    text?: string
    request_id?: string
}

/** 音色复刻响应。file_id 为试听音频文件 ID，需通过 zhipuDownloadFile 取回。 */
export interface ZhipuVoiceCloneResult {
    voice?: string
    file_id?: string
    file_purpose?: string
    request_id?: string
}

/**
 * 上传文件，返回 file_id。POST /files。
 * 用于音色复刻上传示例音频等场景。
 *
 * purpose 合法枚举：batch / code-interpreter / agent / voice-clone-input。
 * 音色复刻参考音频固定用 'voice-clone-input'（官方仅支持 mp3/wav，≤10M，建议 3-30 秒）。
 * multipart 表单字段名为 file / purpose。
 */
export async function zhipuUploadFile(
    buffer: Buffer,
    filename: string,
    purpose: string,
    options: { apiKey: string; logPrefix?: string },
): Promise<string> {
    if (!options.apiKey) throw new Error('请配置智谱 API Key')
    const logPrefix = options.logPrefix || '[Zhipu File]'
    const form = new FormData()
    form.append('file', new Blob([Uint8Array.from(buffer)]), filename)
    form.append('purpose', purpose)

    const response = await fetchWithTimeout(`${ZHIPU_BASE_URL}/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}` },
        body: form,
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) {
        const message = extractZhipuError(safeJson(text), `${logPrefix} 文件上传失败: ${response.status}`)
        _ulogError(`${logPrefix} 上传失败: ${response.status} ${message}`)
        throw new Error(`${logPrefix} 文件上传失败: ${message}`)
    }
    const data = safeJson(text) as { id?: string; file_id?: string } | null
    const fileId = (data?.id || data?.file_id || '').trim()
    if (!fileId) {
        throw new Error(`${logPrefix} 文件上传响应缺少 file_id`)
    }
    return fileId
}

/**
 * 音色复刻：基于示例音频生成指定音色的语音。POST /voice/clone。
 * 返回试听音频 file_id，需再调 zhipuDownloadFile 取回音频内容。
 */
export async function zhipuVoiceClone(
    request: ZhipuVoiceCloneRequest,
    options: { apiKey: string; logPrefix?: string },
): Promise<ZhipuVoiceCloneResult> {
    if (!options.apiKey) throw new Error('请配置智谱 API Key')
    const logPrefix = options.logPrefix || '[Zhipu Voice Clone]'
    _ulogInfo(`${logPrefix} voice_name=${request.voice_name}, input 长度=${request.input.length}`)

    const response = await fetchWithTimeout(`${ZHIPU_BASE_URL}/voice/clone`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(request),
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) {
        const message = extractZhipuError(safeJson(text), `${logPrefix} 音色复刻失败: ${response.status}`)
        _ulogError(`${logPrefix} 失败: ${response.status} ${message}`)
        throw new Error(`${logPrefix} 音色复刻失败: ${message}`)
    }
    const result = (safeJson(text) as ZhipuVoiceCloneResult) || null
    if (!result || !result.file_id) {
        throw new Error(`${logPrefix} 音色复刻响应缺少试听音频 file_id`)
    }
    return result
}

/**
 * 下载文件内容。GET /files/{file_id}/content。
 * 返回二进制 Buffer，用于取回音色复刻试听音频等。
 */
export async function zhipuDownloadFile(
    fileId: string,
    options: { apiKey: string; logPrefix?: string },
): Promise<Buffer> {
    if (!options.apiKey) throw new Error('请配置智谱 API Key')
    const logPrefix = options.logPrefix || '[Zhipu File]'
    const response = await fetchWithTimeout(
        `${ZHIPU_BASE_URL}/files/${encodeURIComponent(fileId)}/content`,
        {
            method: 'GET',
            headers: { Authorization: `Bearer ${options.apiKey}` },
        },
    )
    if (!response.ok) {
        const text = await response.text().catch(() => '')
        const message = extractZhipuError(safeJson(text), `${logPrefix} 文件下载失败: ${response.status}`)
        _ulogError(`${logPrefix} 下载失败: ${response.status} ${message}`)
        throw new Error(`${logPrefix} 文件下载失败: ${message}`)
    }
    return Buffer.from(await response.arrayBuffer())
}
