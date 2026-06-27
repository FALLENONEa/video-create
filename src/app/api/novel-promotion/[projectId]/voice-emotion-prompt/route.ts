import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { getProjectModelConfig } from '@/lib/config-service'
import { executeAiTextStep } from '@/lib/ai-runtime'

/**
 * POST /api/novel-promotion/[projectId]/voice-emotion-prompt
 * 结合台词内容与发言人，让 AI 生成一段简短的情绪提示词，供配音情绪参考。
 * 同步调用模型网关（executeAiTextStep 内部走 chatCompletion，计费自动结算）。
 */
export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params

  // 🔐 统一权限验证
  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const body = await request.json().catch(() => ({}))
  const lineId = typeof body?.lineId === 'string' ? body.lineId.trim() : ''
  if (!lineId) {
    throw new ApiError('INVALID_PARAMS')
  }

  // 按 lineId 查库拿台词内容与发言人，避免信任前端传值
  const line = await prisma.novelPromotionVoiceLine.findUnique({
    where: { id: lineId },
    select: { id: true, content: true, speaker: true },
  })
  if (!line) {
    throw new ApiError('NOT_FOUND')
  }

  const content = (line.content || '').trim()
  if (!content) {
    throw new ApiError('INVALID_PARAMS')
  }
  const speaker = (line.speaker || '').trim()

  const { analysisModel } = await getProjectModelConfig(projectId, session.user.id)
  if (!analysisModel) {
    throw new ApiError('MISSING_CONFIG')
  }

  const prompt = [
    '你是一位专业配音导演。请根据下面这句台词和发言人，推断说这句话时的情绪语气，',
    '输出一段简短的中文情绪提示词，用于指导配音。',
    '要求：2-8 个字，可用顿号分隔多个词（如「不屑、讥讽」「悲伤、哽咽」「愤怒、质问」）；',
    '只输出情绪提示词本身，不要任何解释、引号或标点结尾。',
    `\n发言人：${speaker || '未知'}`,
    `台词：${content}`,
  ].join('\n')

  const completion = await executeAiTextStep({
    userId: session.user.id,
    model: analysisModel,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    projectId,
    action: 'generate_emotion_prompt',
    meta: {
      stepId: 'generate_emotion_prompt',
      stepTitle: '生成情绪提示词',
      stepIndex: 1,
      stepTotal: 1,
    },
  })

  // 清洗：去掉可能的引号/句末标点，限制长度，保持单行
  const emotionPrompt = (completion.text || '')
    .trim()
    .replace(/^["'「『]+|["'」』。.!！?？]+$/g, '')
    .replace(/[\r\n]+/g, '、')
    .slice(0, 30)
    .trim()

  if (!emotionPrompt) {
    throw new ApiError('INVALID_PARAMS')
  }

  return NextResponse.json({ success: true, emotionPrompt })
})
