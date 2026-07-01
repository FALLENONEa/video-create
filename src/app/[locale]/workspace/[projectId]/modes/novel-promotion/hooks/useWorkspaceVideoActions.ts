'use client'

import { logInfo as _ulogInfo, logError as _ulogError } from '@/lib/logging/core'
import { useLocale } from 'next-intl'
import { useGenerateVideo, useBatchGenerateVideos } from '@/lib/query/hooks/useStoryboards'
import {
  useRefineProjectVideoPrompts,
  useUpdateProjectPanelVideoPrompt,
  useUpdateProjectClip,
  useUpdateProjectConfig,
} from '@/lib/query/hooks'
import type { BatchVideoGenerationParams, VideoGenerationOptions } from '../components/video'

interface UseWorkspaceVideoActionsParams {
  projectId: string
  episodeId?: string
  t: (key: string) => string
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return err.name === 'AbortError' || err.message === 'Failed to fetch'
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function assertClipUpdateData(data: unknown): asserts data is Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('Clip update payload must be an object')
  }
}

export function useWorkspaceVideoActions({
  projectId,
  episodeId,
  t,
}: UseWorkspaceVideoActionsParams) {
  const generateVideoMutation = useGenerateVideo(projectId, episodeId || null)
  const batchGenerateVideosMutation = useBatchGenerateVideos(projectId, episodeId || null)
  const updateProjectPanelVideoPromptMutation = useUpdateProjectPanelVideoPrompt(projectId)
  const updateProjectClipMutation = useUpdateProjectClip(projectId)
  const updateProjectConfigMutation = useUpdateProjectConfig(projectId)
  const refineVideoPromptsMutation = useRefineProjectVideoPrompts(projectId)
  const locale = useLocale()

  const handleGenerateVideo = async (
    storyboardId: string,
    panelIndex: number,
    videoModel?: string,
    firstLastFrame?: {
      lastFrameStoryboardId: string
      lastFramePanelIndex: number
      flModel: string
      customPrompt?: string
    },
    generationOptions?: VideoGenerationOptions,
    panelId?: string,
  ) => {
    const normalizedVideoModel = typeof videoModel === 'string' ? videoModel.trim() : ''
    if (!normalizedVideoModel) {
      alert('Video model is required')
      return
    }
    try {
      await generateVideoMutation.mutateAsync({
        storyboardId,
        panelIndex,
        panelId,
        videoModel: normalizedVideoModel,
        firstLastFrame,
        generationOptions,
      })
    } catch (err: unknown) {
      if (isAbortError(err)) {
        _ulogInfo(t('execution.requestAborted'))
        return
      }
      alert(`${t('execution.generationFailed')}: ${getErrorMessage(err)}`)
      throw err
    }
  }

  const handleGenerateAllVideos = async (options?: BatchVideoGenerationParams) => {
    if (!episodeId) {
      alert(t('execution.selectEpisode'))
      return
    }
    const normalizedVideoModel = typeof options?.videoModel === 'string' ? options.videoModel.trim() : ''
    if (!normalizedVideoModel) {
      alert('Video model is required')
      return
    }

    try {
      await batchGenerateVideosMutation.mutateAsync({
        ...options,
        videoModel: normalizedVideoModel,
      })
    } catch (err: unknown) {
      if (isAbortError(err)) {
        _ulogInfo(t('execution.requestAborted'))
        return
      }
      alert(`${t('execution.batchVideoFailed')}: ${getErrorMessage(err)}`)
      throw err
    }
  }

  const handleUpdateVideoPrompt = async (
    storyboardId: string,
    panelIndex: number,
    value: string,
    field: 'videoPrompt' | 'firstLastFramePrompt' = 'videoPrompt',
  ) => {
    await updateProjectPanelVideoPromptMutation.mutateAsync({ storyboardId, panelIndex, value, field })
  }

  /**
   * 修缮整集视频提示词（跨镜头连贯性优化）：
   * 后端 LLM 修缮后，前端逐条 PATCH 落库 videoPrompt + firstLastFramePrompt。
   * 任一条落库失败不中断整体（已成功的不回滚），最终返回成功/失败计数。
   */
  const handleRefineVideoPrompts = async (): Promise<{ succeeded: number; failed: number }> => {
    if (!episodeId) {
      return { succeeded: 0, failed: 0 }
    }
    const result = await refineVideoPromptsMutation.mutateAsync({ episodeId, locale }) as { refined?: Array<{
      storyboardId: string
      panelIndex: number
      videoPrompt: string
      firstLastFramePrompt: string | null
    }> }
    const refined = result?.refined || []
    let succeeded = 0
    let failed = 0
    for (const item of refined) {
      try {
        if (item.videoPrompt) {
          await updateProjectPanelVideoPromptMutation.mutateAsync({
            storyboardId: item.storyboardId,
            panelIndex: item.panelIndex,
            value: item.videoPrompt,
            field: 'videoPrompt',
          })
        }
        if (item.firstLastFramePrompt) {
          await updateProjectPanelVideoPromptMutation.mutateAsync({
            storyboardId: item.storyboardId,
            panelIndex: item.panelIndex,
            value: item.firstLastFramePrompt,
            field: 'firstLastFramePrompt',
          })
        }
        succeeded += 1
      } catch (err) {
        _ulogError('[RefineVideoPrompts] 落库失败:', err)
        failed += 1
      }
    }
    _ulogInfo('[RefineVideoPrompts] 完成', { succeeded, failed, total: refined.length })
    return { succeeded, failed }
  }

  const handleUpdatePanelVideoModel = async (_storyboardId: string, _panelIndex: number, model: string) => {
    const normalizedModel = model.trim()
    if (!normalizedModel) return
    try {
      await updateProjectConfigMutation.mutateAsync({
        key: 'videoModel',
        value: normalizedModel,
      })
    } catch (err: unknown) {
      _ulogError(`${t('execution.updateFailed')}:`, err)
    }
  }

  const handleUpdateClip = async (clipId: string, data: unknown) => {
    if (!episodeId) {
      _ulogError('No episode selected for clip update')
      return
    }
    try {
      assertClipUpdateData(data)
      await updateProjectClipMutation.mutateAsync({ clipId, data, episodeId })
    } catch (err: unknown) {
      _ulogError(`${t('execution.updateFailed')}:`, err)
      alert(`${t('execution.saveFailed')}: ${getErrorMessage(err)}`)
    }
  }

  return {
    handleGenerateVideo,
    handleGenerateAllVideos,
    handleUpdateVideoPrompt,
    handleRefineVideoPrompts,
    refineVideoPromptsMutation,
    handleUpdatePanelVideoModel,
    handleUpdateClip,
  }
}
