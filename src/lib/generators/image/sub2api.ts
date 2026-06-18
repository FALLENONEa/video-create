/**
 * sub2api（中转站）图片生成器
 *
 * 中转站统一走 chat/completions 协议生图：
 * - POST {baseUrl}/chat/completions，messages=[{role:'user', content: prompt}]
 * - 图片 URL 常嵌在 message.content 中（Markdown ![](url) 或裸 URL / data URI）
 *
 * 与 OpenAICompatibleImageGenerator 的区别：后者走标准 /images/generations 端点，
 * 而中转站的文生图模型挂在 chat 接口上，必须走对话协议。
 */

import {
    BaseImageGenerator,
    type GenerateResult,
    type ImageGenerateParams,
} from '../base'
import { resolveOpenAICompatClientConfig } from '@/lib/model-gateway/openai-compat/common'
import { logInfo as _ulogInfo } from '@/lib/logging/core'

/**
 * 从可能包含 Markdown 图片语法的文本中提取图片地址（data URI / URL）。
 * 适配 chat-completions 协议生图：message.content 常为 "![alt](https://...)"
 * 或裸 URL；若文本本身已是合法图片地址则原样返回。
 */
function extractImageUrlsFromText(text: string): string[] {
    if (!text) return []
    const result: string[] = []
    // 1. Markdown 图片语法 ![alt](url)
    const mdImage = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
    let m: RegExpExecArray | null
    while ((m = mdImage.exec(text)) !== null) {
        const src = m[1].trim()
        if (src) result.push(src)
    }
    if (result.length > 0) return result
    // 2. 文本任意位置的图片 URL / data URI（兼容流式拼接内容、JSON 字段值等场景）
    const urlGlobal = /(https?:\/\/[^\s)"'\\]+|data:image\/[a-zA-Z0-9.+-]+;base64,[^\s)"'\\]+)/gi
    const urls: string[] = []
    while ((m = urlGlobal.exec(text)) !== null) {
        const src = m[1].replace(/[",]+$/, '').trim()
        if (src) urls.push(src)
    }
    return urls
}

/** 从 chat-completions 响应里读取 choices[0].message.content（string 或多模态数组）。 */
function readChatContent(payload: unknown): string {
    if (typeof payload !== 'object' || payload === null) return ''
    const choices = (payload as { choices?: unknown }).choices
    if (!Array.isArray(choices) || choices.length === 0) return ''
    const message = (choices[0] as { message?: { content?: unknown } } | undefined)?.message
    const content = message?.content
    if (typeof content === 'string') return content
    if (content === null || content === undefined) return ''
    try {
        return JSON.stringify(content)
    } catch {
        return ''
    }
}

/**
 * 从 chat-completions 响应原文读取完整 message 文本。
 * 中转站生图模型（如 grok-imagine）常以 SSE 流式返回：`data: {...}\ndata: {...}`，
 * 图片 URL 在后续 chunk 的 delta.content 中。此处检测流式并拼接所有 chunk 的 delta.content；
 * 非流式响应则按单条 JSON 解析 choices[0].message.content。
 */
function readChatContentFromResponse(raw: string): string {
    const trimmed = raw.trim()
    if (trimmed.startsWith('data:')) {
        const parts: string[] = []
        for (const line of trimmed.split('\n')) {
            const lineTrim = line.trim()
            if (!lineTrim.startsWith('data:')) continue
            const payloadStr = lineTrim.slice(5).trim()
            if (!payloadStr || payloadStr === '[DONE]') continue
            try {
                const obj = JSON.parse(payloadStr) as { choices?: Array<{ delta?: { content?: unknown } }> }
                const content = obj.choices?.[0]?.delta?.content
                if (typeof content === 'string' && content) parts.push(content)
            } catch {
                // 单个 chunk 解析失败跳过，不影响其余 chunk
            }
        }
        return parts.join('')
    }
    let payload: unknown = null
    try {
        payload = trimmed ? JSON.parse(trimmed) : null
    } catch {
        payload = null
    }
    return readChatContent(payload)
}

export class Sub2ApiImageGenerator extends BaseImageGenerator {
    private readonly modelId?: string
    private readonly providerId: string

    constructor(modelId?: string, providerId?: string) {
        super()
        this.modelId = modelId
        this.providerId = providerId || 'sub2api'
    }

    protected async doGenerate(params: ImageGenerateParams): Promise<GenerateResult> {
        const { userId, prompt, referenceImages = [], options = {} } = params
        const config = await resolveOpenAICompatClientConfig(userId, this.providerId)
        const opts = options as { modelId?: string }
        const modelId = (this.modelId || opts.modelId || '').trim() || 'gpt-4o'

        const baseUrl = config.baseUrl.replace(/\/+$/, '')
        _ulogInfo(`[Sub2Api Image] provider=${this.providerId}, model=${modelId}, refs=${referenceImages.length}`)

        // 有参考图时走多模态（image_url，标准 OpenAI 格式），否则纯文本 prompt
        const userContent =
            referenceImages.length > 0
                ? [
                    { type: 'text', text: prompt },
                    ...referenceImages.map((img) => ({ type: 'image_url', image_url: { url: img } })),
                ]
                : prompt

        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'user', content: userContent }],
            }),
        })

        const text = await response.text().catch(() => '')
        if (!response.ok) {
            throw new Error(`[Sub2Api Image] 生图失败: ${response.status} ${text.slice(0, 300)}`)
        }

        // 中转站可能流式(SSE)或非流式返回，统一解析出内容文本
        const content = readChatContentFromResponse(text)
        // 先从解析出的内容提取；若空（图片可能在非标准字段），再从原始响应兜底提取
        let urls = extractImageUrlsFromText(content)
        if (urls.length === 0) {
            urls = extractImageUrlsFromText(text)
        }
        if (urls.length === 0) {
            const diagText = (content || text).slice(0, 300).replace(/[\r\n]+/g, ' ')
            _ulogInfo(`[Sub2Api Image] 空响应诊断 baseUrl=${baseUrl} status=${response.status} content=${diagText}`)
            throw new Error(`SUB2API_IMAGE_EMPTY_RESPONSE: chat 响应未返回图片 URL [baseUrl=${baseUrl} status=${response.status} content=${diagText}]`)
        }

        return {
            success: true,
            imageUrl: urls[0],
            ...(urls.length > 1 ? { imageUrls: urls } : {}),
        }
    }
}
