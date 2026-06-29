import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { uploadObject, generateUniqueKey } from '@/lib/storage'
import { requireUserAuth, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { getProviderConfig } from '@/lib/api-config'
import { attachMediaFieldsToGlobalVoice } from '@/lib/media/attach'
import { bailianEnrollVoice } from '@/lib/providers/bailian/voice-clone'

/**
 * POST /api/asset-hub/voice-clone
 * 百炼声音复刻：上传参考音频 → 注册得到 voiceId → 存进音色库（GlobalVoice）。
 *
 * 与「AI 设计音色」并行：设计靠提示词产出 voiceId，复刻靠参考音频产出 voiceId，
 * 两者都以 GlobalVoice 形式进音色库，跨项目可从「选库」复用。
 *
 * 注册（enroll）是一次性 HTTP 调用，故走同步路由，不必像设计那样走异步任务。
 * 注册失败则不落库、不上传存储，避免脏数据。
 */
export const POST = apiHandler(async (request: NextRequest) => {
    const authResult = await requireUserAuth()
    if (isErrorResponse(authResult)) return authResult
    const { session } = authResult

    const formData = await request.formData()
    const file = formData.get('file') as File
    const name = formData.get('name') as string
    const folderId = formData.get('folderId') as string | null
    const description = formData.get('description') as string | null
    const preferredName = (formData.get('preferredName') as string | null) || ''

    if (!file) {
        throw new ApiError('INVALID_PARAMS')
    }
    if (!name || !name.trim()) {
        throw new ApiError('INVALID_PARAMS')
    }

    // 声音复刻仅支持 qwen3-tts-vc 注册接受的格式：WAV(16bit) / MP3 / M4A
    const isCloneAudio =
        ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/m4a', 'audio/x-m4a'].includes(file.type) ||
        /\.(mp3|wav|m4a)$/i.test(file.name)
    if (!isCloneAudio) {
        throw new ApiError('INVALID_PARAMS')
    }

    if (folderId) {
        const folder = await prisma.globalAssetFolder.findUnique({
            where: { id: folderId },
        })
        if (!folder || folder.userId !== session.user.id) {
            throw new ApiError('INVALID_PARAMS')
        }
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    if (buffer.length === 0) {
        throw new ApiError('INVALID_PARAMS')
    }

    // 注册音色（先注册，成功后再落库，避免脏数据）
    const { apiKey, baseUrl } = await getProviderConfig(session.user.id, 'bailian')
    const enrollMimeType = resolveEnrollMimeType(file)
    const enrolled = await bailianEnrollVoice({
        audioBuffer: buffer,
        mimeType: enrollMimeType,
        preferredName: preferredName.trim() || undefined,
        apiKey,
        baseUrl,
    })
    if (!enrolled.success || !enrolled.voiceId) {
        throw new ApiError('EXTERNAL_ERROR', { message: enrolled.error || '声音复刻注册失败' })
    }

    // 参考音频存对象存储（供音色库预览）
    const audioExt = file.name.split('.').pop()?.toLowerCase() || 'mp3'
    const key = generateUniqueKey(`voices/${session.user.id}/${Date.now()}`, audioExt)
    const cosUrl = await uploadObject(buffer, key)

    const voice = await prisma.globalVoice.create({
        data: {
            userId: session.user.id,
            folderId: folderId || null,
            name: name.trim(),
            description: description?.trim() || null,
            voiceId: enrolled.voiceId,
            voiceType: 'qwen-cloned',
            customVoiceUrl: cosUrl,
            voicePrompt: null,
            gender: null,
            language: 'zh',
        },
    })

    const withMedia = await attachMediaFieldsToGlobalVoice(voice)
    return NextResponse.json({ success: true, voice: withMedia })
})

/** 把上传文件类型映射到 qwen-voice-enrollment 接受的 MIME（mp3/wav/m4a）。 */
function resolveEnrollMimeType(file: File): string {
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (file.type === 'audio/wav' || ext === 'wav') return 'audio/wav'
    if (file.type === 'audio/m4a' || file.type === 'audio/x-m4a' || ext === 'm4a') return 'audio/m4a'
    return 'audio/mpeg'
}
