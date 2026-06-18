import { logInfo as _ulogInfo } from '@/lib/logging/core'
/**
 * 智谱 AI（Zhipu / BigModel）生成器
 *
 * 视频模型（CogVideoX 系列，异步任务）：
 * - cogvideox-3：支持首尾帧、音频、最高 4K、5s/10s
 * - cogvideox-flash：免费版
 *
 * 设计参照 generators/ark.ts：
 * - 参数全部从 options 动态取（有才加入请求体），零硬编码
 * - 模型规格表 + options 白名单 + 值校验
 * - 首尾帧 vs 单图按 image_url 结构动态构建（智谱靠数组元素数量区分）
 * - 图片转 base64 在适配器内部完成（与 ark/视频链路统一出站）
 */

import {
    BaseImageGenerator,
    BaseVideoGenerator,
    type GenerateResult,
    type ImageGenerateParams,
    type VideoGenerateParams,
} from './base'
import { getProviderConfig } from '@/lib/api-config'
import { zhipuCreateVideoTask, zhipuCreateImage, type ZhipuVideoGenerationRequest } from '@/lib/zhipu-api'
import { normalizeToBase64ForGeneration } from '@/lib/media/outbound-image'

interface ZhipuVideoOptions {
    modelId?: string
    modelKey?: string
    provider?: string
    quality?: 'quality' | 'speed'
    generateAudio?: boolean
    watermark?: boolean
    size?: string
    fps?: number
    aspectRatio?: string
    lastFrameImageUrl?: string
    generationMode?: 'normal' | 'firstlastframe'
    duration?: number
    resolution?: string
}

interface ZhipuVideoModelSpec {
    supportsFirstLastFrame: boolean
    supportsAudio: boolean
    defaultSize: string
}

const ZHIPU_VIDEO_MODEL_SPECS: Record<string, ZhipuVideoModelSpec> = {
    'cogvideox-3': {
        supportsFirstLastFrame: true,
        supportsAudio: true,
        defaultSize: '1920x1080',
    },
    'cogvideox-flash': {
        supportsFirstLastFrame: false,
        supportsAudio: true,
        defaultSize: '1920x1080',
    },
}

// CogVideoX 官方 size 枚举：1280x720、720x1280、1024x1024、1920x1080、1080x1920、2048x1080、3840x2160（默认短边1080，长边按比例）。官方无 4:3/3:4 尺寸，故不映射，避免传非法 size。
const ZHIPU_VIDEO_SIZE_MAP: Record<string, string> = {
    '16:9': '1920x1080',
    '9:16': '1080x1920',
    '1:1': '1024x1024',
    '21:9': '2048x1080',
}

const ZHIPU_VIDEO_ALLOWED_RATIOS = new Set(Object.keys(ZHIPU_VIDEO_SIZE_MAP))

// options 白名单：duration/quality/watermark/resolution 是官方入参；fps/with_audio/size 是官方入参。
const ZHIPU_VIDEO_ALLOWED_OPTIONS = new Set([
    'provider', 'modelId', 'modelKey',
    'quality', 'generateAudio', 'watermark', 'size', 'fps', 'aspectRatio',
    'lastFrameImageUrl', 'generationMode',
    'duration', 'resolution',
])

function resolveVideoModelSpec(modelId: string): ZhipuVideoModelSpec {
    return ZHIPU_VIDEO_MODEL_SPECS[modelId.toLowerCase()] || ZHIPU_VIDEO_MODEL_SPECS['cogvideox-3']
}

export class ZhipuVideoGenerator extends BaseVideoGenerator {
    protected async doGenerate(params: VideoGenerateParams): Promise<GenerateResult> {
        const { userId, imageUrl, prompt = '', options = {} } = params
        const { apiKey } = await getProviderConfig(userId, 'zhipu')
        const opts = options as ZhipuVideoOptions
        const modelId = opts.modelId || 'cogvideox-3'
        const spec = resolveVideoModelSpec(modelId)

        // 白名单校验：拒绝未声明字段，避免误传导致智谱报错或静默忽略
        for (const [key, value] of Object.entries(options)) {
            if (value === undefined) continue
            if (!ZHIPU_VIDEO_ALLOWED_OPTIONS.has(key)) {
                throw new Error(`ZHIPU_VIDEO_OPTION_UNSUPPORTED: ${key}`)
            }
        }

        // 首尾帧判定（worker 仅在首尾帧模式传入 lastFrameImageUrl）
        const lastFrameRaw = typeof opts.lastFrameImageUrl === 'string' ? opts.lastFrameImageUrl.trim() : ''
        const isFirstLastFrame = lastFrameRaw.length > 0
        if (isFirstLastFrame && !spec.supportsFirstLastFrame) {
            throw new Error(`ZHIPU_VIDEO_OPTION_UNSUPPORTED: firstlastframe for ${modelId}`)
        }

        // quality：官方默认 speed（速度优先）。首尾帧与单图同支持 quality/speed。
        let quality: 'quality' | 'speed' = 'speed'
        if (opts.quality !== undefined) {
            if (opts.quality !== 'quality' && opts.quality !== 'speed') {
                throw new Error(`ZHIPU_VIDEO_OPTION_VALUE_UNSUPPORTED: quality=${opts.quality}`)
            }
            quality = opts.quality
        }

        // fps：30 | 60，默认 30
        let fps = 30
        if (opts.fps !== undefined) {
            if (opts.fps !== 30 && opts.fps !== 60) {
                throw new Error(`ZHIPU_VIDEO_OPTION_VALUE_UNSUPPORTED: fps=${opts.fps}`)
            }
            fps = opts.fps
        }

        // duration：5 | 10，默认 5
        let duration = 5
        if (opts.duration !== undefined) {
            if (opts.duration !== 5 && opts.duration !== 10) {
                throw new Error(`ZHIPU_VIDEO_OPTION_VALUE_UNSUPPORTED: duration=${opts.duration}`)
            }
            duration = opts.duration
        }

        // aspectRatio 合法性 + size 适配（直接像素 > 分辨率 resolution > 比例 > 默认，保证 size 不留空）
        if (opts.aspectRatio !== undefined && !ZHIPU_VIDEO_ALLOWED_RATIOS.has(opts.aspectRatio)) {
            throw new Error(`ZHIPU_VIDEO_OPTION_VALUE_UNSUPPORTED: aspectRatio=${opts.aspectRatio}`)
        }
        let size: string
        if (opts.size && opts.size.trim()) {
            size = opts.size.trim()
        } else if (opts.resolution && opts.resolution.trim()) {
            size = opts.resolution.trim()
        } else if (opts.aspectRatio) {
            size = ZHIPU_VIDEO_SIZE_MAP[opts.aspectRatio]
        } else {
            size = spec.defaultSize
        }

        // watermark：官方默认 true（开水印）。关闭需客户已签署免责声明。
        const watermarkEnabled = typeof opts.watermark === 'boolean' ? opts.watermark : true

        // with_audio：跟随 generateAudio，官方默认 false（不生成音效，需额外触发 CogSound）
        const withAudio = typeof opts.generateAudio === 'boolean' ? opts.generateAudio : false
        if (withAudio && !spec.supportsAudio) {
            throw new Error(`ZHIPU_VIDEO_OPTION_UNSUPPORTED: generateAudio for ${modelId}`)
        }

        // 图片转 base64；首尾帧构建双元素数组，单图为字符串
        const firstFrameBase64 = await normalizeToBase64ForGeneration(imageUrl)
        const image_url: string | string[] = isFirstLastFrame
            ? [firstFrameBase64, await normalizeToBase64ForGeneration(lastFrameRaw)]
            : firstFrameBase64

        const request: ZhipuVideoGenerationRequest = {
            model: modelId,
            prompt,
            image_url,
            quality,
            with_audio: withAudio,
            watermark_enabled: watermarkEnabled,
            size,
            fps,
            duration,
        }

        _ulogInfo(`[Zhipu Video] 模型=${modelId}, 首尾帧=${isFirstLastFrame}, frames=${Array.isArray(image_url) ? image_url.length : 1}, firstLen=${firstFrameBase64.length}${Array.isArray(image_url) ? `, lastLen=${image_url[1]?.length ?? 0}` : ''}, size=${size}, quality=${quality}, fps=${fps}, audio=${withAudio}, watermark=${watermarkEnabled}`)

        const taskData = await zhipuCreateVideoTask(request, { apiKey, logPrefix: '[Zhipu Video]' })
        const taskId = taskData.id

        return {
            success: true,
            async: true,
            requestId: taskId,
            externalId: `ZHIPU:VIDEO:${taskId}`,
        }
    }
}

// 向后兼容别名
export const ZhipuCogVideoXVideoGenerator = ZhipuVideoGenerator

// ============================================================
// 图像生成（CogView-4 / GLM-Image / CogView-3-Flash，同步 /images/generations）
// ============================================================

// GLM-Image 原生支持 1024×1024 ~ 2048×2048 任意比例。按宽高比适配到 1024 级别。
const ZHIPU_IMAGE_SIZE_MAP: Record<string, string> = {
    '1:1': '1024x1024',
    '16:9': '1024x576',
    '9:16': '576x1024',
    '4:3': '768x576',
    '3:4': '576x768',
}

export class ZhipuImageGenerator extends BaseImageGenerator {
    protected async doGenerate(params: ImageGenerateParams): Promise<GenerateResult> {
        const { userId, prompt, options = {} } = params
        const { apiKey } = await getProviderConfig(userId, 'zhipu')
        const opts = options as { modelId?: string; size?: string; aspectRatio?: string }
        const modelId = opts.modelId || 'glm-image'

        // size：直接像素 > 宽高比映射 > 默认 1024x1024
        let size: string
        if (opts.size && opts.size.trim()) {
            size = opts.size.trim()
        } else if (opts.aspectRatio && ZHIPU_IMAGE_SIZE_MAP[opts.aspectRatio]) {
            size = ZHIPU_IMAGE_SIZE_MAP[opts.aspectRatio]
        } else {
            size = '1024x1024'
        }

        _ulogInfo(`[Zhipu Image] 模型=${modelId}, size=${size}`)

        const result = await zhipuCreateImage(
            { model: modelId, prompt, size },
            { apiKey, logPrefix: '[Zhipu Image]' },
        )
        const imageUrl = result.data?.[0]?.url
        if (!imageUrl) {
            throw new Error('Zhipu 图像生成响应缺少图片 URL')
        }
        return { success: true, imageUrl }
    }
}
