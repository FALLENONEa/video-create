import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireProjectAuth, requireProjectAuthLight, isErrorResponse } from '@/lib/api-auth'
import { apiHandler, ApiError } from '@/lib/api-errors'
import { submitTask } from '@/lib/task/submitter'
import { resolveRequiredTaskLocale } from '@/lib/task/resolve-locale'
import { TASK_TYPE } from '@/lib/task/types'
import { toSignedUrlIfCos } from '@/lib/workers/utils'

/**
 * POST /api/novel-promotion/[projectId]/editor/render
 * 提交剪辑工程渲染任务（异步）。body: { episodeId }
 */
export const POST = apiHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await params
  const body = await request.json().catch(() => ({}))
  const episodeId = typeof body?.episodeId === 'string' ? body.episodeId.trim() : ''

  if (!episodeId) {
    throw new ApiError('INVALID_PARAMS')
  }

  const authResult = await requireProjectAuth(projectId)
  if (isErrorResponse(authResult)) return authResult
  const { session } = authResult

  // 🔐 校验该剧集确属当前项目，防止用他人 episodeId 越权触发渲染
  const episode = await prisma.novelPromotionEpisode.findFirst({
    where: { id: episodeId, novelPromotionProject: { projectId } },
    select: { id: true },
  })
  if (!episode) {
    throw new ApiError('NOT_FOUND')
  }

  const editorProject = await prisma.videoEditorProject.findUnique({ where: { episodeId } })
  if (!editorProject) {
    throw new ApiError('NOT_FOUND')
  }

  const locale = resolveRequiredTaskLocale(request, body)

  const result = await submitTask({
    userId: session.user.id,
    locale,
    projectId,
    episodeId,
    type: TASK_TYPE.VIDEO_RENDER,
    targetType: 'VideoEditorProject',
    targetId: editorProject.id,
    payload: { editorProjectId: editorProject.id },
    dedupeKey: `video_render:${editorProject.id}`,
  })

  // 记录任务 id 便于状态追踪（handler 内也会写，这里先占位防丢单）
  await prisma.videoEditorProject.update({
    where: { id: editorProject.id },
    data: { renderStatus: 'pending', renderTaskId: result.taskId },
  })

  return NextResponse.json(result)
})

/**
 * GET /api/novel-promotion/[projectId]/editor/render?episodeId=...
 * 查询渲染状态。outputUrl 转为可播放的 presigned URL。
 */
export const GET = apiHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> },
) => {
  const { projectId } = await params

  const authResult = await requireProjectAuthLight(projectId)
  if (isErrorResponse(authResult)) return authResult

  const episodeId = request.nextUrl.searchParams.get('episodeId')
  if (!episodeId) {
    throw new ApiError('INVALID_PARAMS')
  }

  // 🔐 校验该剧集确属当前项目，防止用他人 episodeId 越权查询渲染状态
  const episode = await prisma.novelPromotionEpisode.findFirst({
    where: { id: episodeId, novelPromotionProject: { projectId } },
    select: { id: true },
  })
  if (!episode) {
    throw new ApiError('NOT_FOUND')
  }

  const editorProject = await prisma.videoEditorProject.findUnique({ where: { episodeId } })
  if (!editorProject) {
    throw new ApiError('NOT_FOUND')
  }

  const outputUrl = editorProject.outputUrl ? toSignedUrlIfCos(editorProject.outputUrl, 3600) : null

  return NextResponse.json({
    renderStatus: editorProject.renderStatus,
    outputUrl,
    renderTaskId: editorProject.renderTaskId,
    updatedAt: editorProject.updatedAt,
  })
})
