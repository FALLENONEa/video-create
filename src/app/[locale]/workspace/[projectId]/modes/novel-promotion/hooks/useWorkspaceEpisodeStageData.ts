'use client'

import { useEpisodeData } from '@/lib/query/hooks'
import { useMatchedVoiceLines } from '@/lib/query/hooks/useVoiceLines'
import type { NovelPromotionClip, NovelPromotionStoryboard } from '@/types/project'
import { useWorkspaceProvider } from '../WorkspaceProvider'

interface EpisodeStagePayload {
  name?: string
  novelText?: string | null
  clips?: NovelPromotionClip[]
  storyboards?: NovelPromotionStoryboard[]
}

export function useWorkspaceEpisodeStageData() {
  const { projectId, episodeId } = useWorkspaceProvider()
  const { data: episodeData, isLoading } = useEpisodeData(projectId, episodeId || null)
  const { data: matchedVoiceData, isLoading: voiceLinesLoading } = useMatchedVoiceLines(projectId, episodeId || null)
  const payload = episodeData as EpisodeStagePayload | null

  return {
    episodeName: payload?.name,
    novelText: payload?.novelText || '',
    clips: payload?.clips || [],
    storyboards: payload?.storyboards || [],
    voiceLines: matchedVoiceData?.voiceLines || [],
    isLoading: isLoading || voiceLinesLoading,
  }
}
