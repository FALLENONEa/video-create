import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { getProjectModelConfig } from '@/lib/config-service'
import { executeAiTextStep } from '@/lib/ai-runtime'
import { buildPrompt } from '@/lib/prompt-i18n'
import { PROMPT_IDS } from '@/lib/prompt-i18n/prompt-ids'
import { safeParseJsonArray } from '@/lib/json-repair'

/**
 * POST /api/novel-promotion/[projectId]/refine-video-prompts
 * 对一集的所有镜头视频提示词做「跨镜头连贯性修缮」：
 * 把整集时间轴（含生成模式、首尾帧配对关系）喂给 LLM，
 * 分别输出修缮后的 videoPrompt 与 firstLastFramePrompt，保证拼接处行为一致。
 * 同步调用模型网关，返回 { panelId, videoPrompt, firstLastFramePrompt }[] 供前端逐条落库。
 */
export const POST = apiHandler(async (
  request: NextRequest,
  context: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await context.params

  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  const body = await request.json().catch(() => ({}))
  const episodeId = typeof body?.episodeId === 'string' ? body.episodeId.trim() : ''
  const localeRaw = typeof body?.locale === 'string' ? body.locale.trim() : ''
  if (!episodeId) {
    throw new ApiError('INVALID_PARAMS')
  }

  // 查库拿该 episode 全部 panel（按 storyboard + panelIndex 排序），不信任前端传值
  const storyboards = await prisma.novelPromotionStoryboard.findMany({
    where: { episodeId },
    select: {
      id: true,
      panels: {
        orderBy: { panelIndex: 'asc' },
        select: {
          id: true,
          storyboardId: true,
          panelIndex: true,
          description: true,
          videoPrompt: true,
          firstLastFramePrompt: true,
          videoGenerationMode: true,
          linkedToNextPanel: true,
        },
      },
    },
  })

  const panels = storyboards
    .flatMap((sb) => sb.panels)
    .filter((p) => p.id)

  if (panels.length === 0) {
    throw new ApiError('INVALID_PARAMS')
  }

  const locale: 'zh' | 'en' = localeRaw === 'en' ? 'en' : 'zh'

  // 组装 LLM 输入：仅传必要字段，不含用户敏感信息
  const panelsInput = panels.map((p) => ({
    panelId: p.id,
    description: p.description || '',
    videoPrompt: p.videoPrompt || '',
    firstLastFramePrompt: p.firstLastFramePrompt || '',
    mode: p.videoGenerationMode || 'normal',
    linkedToNext: !!p.linkedToNextPanel,
  }))

  const prompt = buildPrompt({
    promptId: PROMPT_IDS.NP_VIDEO_PROMPT_REFINE,
    locale,
    variables: {
      panels_json: JSON.stringify(panelsInput, null, 2),
    },
  })

  const { analysisModel } = await getProjectModelConfig(projectId, session.user.id)
  if (!analysisModel) {
    throw new ApiError('MISSING_CONFIG')
  }

  const completion = await executeAiTextStep({
    userId: session.user.id,
    model: analysisModel,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    projectId,
    action: 'refine_video_prompts',
    meta: {
      stepId: 'refine_video_prompts',
      stepTitle: '修缮视频提示词',
      stepIndex: 1,
      stepTotal: 1,
    },
  })

  // 解析 LLM 返回的 JSON 数组，容错修复
  const refined = safeParseJsonArray(completion.text || '') as Array<Record<string, unknown>>
  if (!Array.isArray(refined) || refined.length === 0) {
    throw new ApiError('INVALID_PARAMS')
  }

  // 用 panelId 索引，防 LLM 顺序/数量异常；只回写能匹配到 panelId 的项
  // 同时带回 storyboardId + panelIndex，供前端逐条 PATCH 落库（无需额外映射）
  const panelLocationMap = new Map(panels.map((p) => [p.id, {
    storyboardId: p.storyboardId,
    panelIndex: p.panelIndex,
  }]))
  const result = refined
    .filter((item) => {
      const id = item?.panelId
      return typeof id === 'string' && panelLocationMap.has(id)
    })
    .map((item) => {
      const panelId = item.panelId as string
      const loc = panelLocationMap.get(panelId)!
      return {
        panelId,
        storyboardId: loc.storyboardId,
        panelIndex: loc.panelIndex,
        videoPrompt: typeof item.videoPrompt === 'string' ? item.videoPrompt : '',
        firstLastFramePrompt:
          typeof item.firstLastFramePrompt === 'string' && item.firstLastFramePrompt.length > 0
            ? item.firstLastFramePrompt
            : null,
      }
    })

  if (result.length === 0) {
    throw new ApiError('INVALID_PARAMS')
  }

  return NextResponse.json({ success: true, refined: result })
})
