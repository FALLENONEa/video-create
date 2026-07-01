'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { VideoEditorStage, useEditorActions, createProjectFromPanels } from '@/features/video-editor'
import type { VideoEditorProject } from '@/features/video-editor/types/editor.types'
import { useWorkspaceProvider } from '../WorkspaceProvider'
import { useWorkspaceStageRuntime } from '../WorkspaceStageRuntimeContext'
import { useWorkspaceEpisodeStageData } from '../hooks/useWorkspaceEpisodeStageData'

const DEFAULT_CLIP_DURATION_SEC = 5
const SHORT_FALLBACK_DURATION_SEC = 3.1
const PROBE_TIMEOUT_MS = 10_000
const PROBE_ATTEMPTS = 3

interface EditorPanelDraft {
  id?: string
  panelIndex?: number
  storyboardId: string
  videoUrl: string
  usesLipSyncVideo: boolean
  description?: string
  duration?: number
}

function normalizeDurationSec(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function panelKey(panel: Pick<EditorPanelDraft, 'id' | 'storyboardId' | 'panelIndex'>): string {
  return panel.id || `${panel.storyboardId}-${panel.panelIndex ?? 'unknown'}`
}

/**
 * 探测视频可否访问并读取真实时长（秒）。失败/超时返回 null（与真实时长区分）。
 * 用于在 lipSyncVideoUrl / videoUrl 之间选出浏览器真正能加载的那个。
 */
function probeVideoDuration(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(null)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    // 离屏挂载到 DOM：部分浏览器对未插入文档的 <video preload="metadata"> 不会真正拉取
    // 元数据，onloadedmetadata 永不触发 → 探测全超时。挂载后探测完即移除。
    video.style.cssText =
      'position:fixed;left:-9999px;top:0;width:0;height:0;opacity:0;pointer-events:none'
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (v: number | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      video.onloadedmetadata = null
      video.onerror = null
      video.removeAttribute('src')
      try {
        video.load()
      } catch {
        /* noop */
      }
      if (video.parentNode) video.parentNode.removeChild(video)
      resolve(v)
    }
    video.onloadedmetadata = () =>
      done(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null)
    video.onerror = () => done(null)
    timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS)
    document.body.appendChild(video)
    video.src = src
    try {
      video.load()
    } catch {
      /* noop */
    }
  })
}

async function probeVideoDurationWithRetry(src: string): Promise<number | null> {
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    const duration = await probeVideoDuration(src)
    if (duration !== null) return duration
  }
  return null
}

function findSavedClipDuration(saved: VideoEditorProject | null, panel: EditorPanelDraft): number | undefined {
  if (!saved) return undefined
  const key = panelKey(panel)
  const clip = saved.timeline.find((item) => {
    const metadata = item.metadata
    const metadataKey = metadata?.panelId || `${metadata?.storyboardId ?? ''}-${panel.panelIndex ?? 'unknown'}`
    return metadataKey === key
  })
  return normalizeDurationSec(clip ? clip.durationInFrames / saved.config.fps : undefined)
}

function shouldRepairSavedDurations(saved: VideoEditorProject, panels: EditorPanelDraft[]): boolean {
  const panelsByKey = new Map(panels.map((panel) => [panelKey(panel), panel]))
  return saved.timeline.some((clip) => {
    const metadataKey = clip.metadata?.panelId || `${clip.metadata?.storyboardId ?? ''}-unknown`
    const panel = panelsByKey.get(metadataKey)
    const clipDuration = clip.durationInFrames / saved.config.fps
    const storedDuration = normalizeDurationSec(panel?.duration)
    if (storedDuration && Math.abs(clipDuration - storedDuration) > (1 / saved.config.fps)) return true
    return clipDuration <= SHORT_FALLBACK_DURATION_SEC
  })
}

async function resolvePanelDurations(
  panels: EditorPanelDraft[],
  saved: VideoEditorProject | null,
  probeMissing: boolean,
): Promise<Map<string, number>> {
  const entries = await Promise.all(panels.map(async (panel) => {
    // ⚠️ 口型同步视频(usesLipSyncVideo)的时长 ≠ 原视频时长：口型同步会按配音长度截断/删减。
    // panel.duration 和 saved 里存的都是「原视频时长」，对口型同步视频不可信，
    // 必须直接探测 panel.videoUrl（此时就是 lipSyncVideoUrl）拿真实时长。
    if (panel.usesLipSyncVideo) {
      const probed = await probeVideoDurationWithRetry(panel.videoUrl)
      if (probed && probed > SHORT_FALLBACK_DURATION_SEC) {
        return [panelKey(panel), probed] as const
      }
      // 探测失败才退回 stored/saved（有总比没有强）
    }

    const storedDuration = normalizeDurationSec(panel.duration)
    if (storedDuration && (!probeMissing || storedDuration > SHORT_FALLBACK_DURATION_SEC)) {
      return [panelKey(panel), storedDuration] as const
    }

    const savedDuration = findSavedClipDuration(saved, panel)
    if (savedDuration && (!probeMissing || savedDuration > SHORT_FALLBACK_DURATION_SEC)) {
      return [panelKey(panel), savedDuration] as const
    }

    if (probeMissing) {
      const probedDuration = await probeVideoDurationWithRetry(panel.videoUrl)
      if (probedDuration) return [panelKey(panel), probedDuration] as const
    }

    return [panelKey(panel), DEFAULT_CLIP_DURATION_SEC] as const
  }))

  return new Map(entries)
}

/**
 * 用当前最新的分镜面板刷新已保存工程的每个 clip：
 *  - src：面板视频可能在存工程后才更新（口型同步完成、视频重新生成），旧工程里的 src 会指向
 *    旧文件。这里按 panelKey 用 basePanels 的最新 videoUrl 覆盖，避免播放/导出到老视频。
 *  - 配音轨：若该面板现在用口型同步视频（自带配音），清掉独立配音 attachment.audio，防止双音轨。
 *    反之若仍是普通视频，保留原有配音（不新增，尊重用户在剪辑器里的编辑）。
 *  - durationInFrames：用探测/存储得到的最新时长覆盖。
 */
function refreshSavedProjectFromPanels(
  project: VideoEditorProject,
  panelsByKey: Map<string, EditorPanelDraft>,
  durations: Map<string, number>,
): VideoEditorProject {
  let changed = false
  const timeline = project.timeline.map((clip) => {
    const key = clip.metadata?.panelId || `${clip.metadata?.storyboardId ?? ''}-unknown`
    const panel = panelsByKey.get(key)
    let nextClip = clip

    // 1. 刷新 src 到最新视频
    if (panel && panel.videoUrl && panel.videoUrl !== clip.src) {
      nextClip = { ...nextClip, src: panel.videoUrl }
      changed = true
    }

    // 2. 口型同步视频自带配音 → 移除独立配音轨；普通视频 → 保留原配音（不新增，尊重用户编辑）
    if (panel?.usesLipSyncVideo && nextClip.attachment?.audio) {
      const { audio: _removed, ...restAttachment } = nextClip.attachment
      void _removed
      nextClip = {
        ...nextClip,
        attachment: Object.keys(restAttachment).length > 0 ? restAttachment : undefined,
      }
      changed = true
    }

    // 3. 刷新时长
    const duration = durations.get(key)
    if (duration) {
      const durationInFrames = Math.max(1, Math.round(duration * project.config.fps))
      if (durationInFrames !== nextClip.durationInFrames || nextClip.transition) {
        nextClip = { ...nextClip, durationInFrames, transition: undefined }
        changed = true
      }
    }

    return nextClip
  })

  return changed ? { ...project, timeline } : project
}

/**
 * AI 剪辑 stage：加载已保存工程；若无则从当前 episode 的分镜面板（含已生成视频）自动构造。
 */
export default function EditorStageRoute() {
  const { projectId, episodeId } = useWorkspaceProvider()
  const runtime = useWorkspaceStageRuntime()
  const { storyboards, voiceLines, isLoading: episodeLoading } = useWorkspaceEpisodeStageData()
  const { loadProject, saveProject } = useEditorActions({ projectId, episodeId: episodeId || '' })

  const [initialProject, setInitialProject] = useState<VideoEditorProject | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [syncVersion, setSyncVersion] = useState(0)

  // 有视频源的面板（lipSyncVideoUrl 优先，回退 videoUrl）。提到 useMemo 供加载与"同步新片段"复用。
  const basePanels = useMemo(
    () =>
      storyboards
        .flatMap((sb) => sb.panels || [])
        .map((p) => {
          const url = p.lipSyncVideoUrl || p.videoUrl
          if (!url) return null
          return {
            id: p.id,
            panelIndex: p.panelIndex,
            storyboardId: p.storyboardId,
            videoUrl: url,
            usesLipSyncVideo: !!p.lipSyncVideoUrl,
            description: p.description || undefined,
            duration: normalizeDurationSec(p.duration),
          }
        })
        .filter((p): p is NonNullable<typeof p> => p !== null),
    [storyboards],
  )

  const voiceLinesByPanel = useMemo(
    () =>
      new Map(
        voiceLines
          .filter((line) => line.audioUrl && line.matchedStoryboardId && typeof line.matchedPanelIndex === 'number')
          .map((line) => [`${line.matchedStoryboardId}-${line.matchedPanelIndex}`, line]),
      ),
    [voiceLines],
  )

  // episodeId 变化时立即回到加载态并清空旧工程，避免切换 episode 时串台显示上一个的内容
  useEffect(() => {
    setLoading(true)
    setInitialProject(undefined)
  }, [episodeId])

  useEffect(() => {
    if (!episodeId) {
      setLoading(false)
      return
    }
    // 等剧集数据（含分镜面板）就绪后再构造，否则首次进入会因 storyboards 尚未加载而落空
    if (episodeLoading) {
      setLoading(true)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const saved = await loadProject()
        if (cancelled) return
        if (basePanels.length === 0) {
          if (saved && Array.isArray(saved.timeline) && saved.timeline.length > 0) {
            setInitialProject(saved)
          }
          return
        }

        const hasSavedTimeline = !!saved && Array.isArray(saved.timeline) && saved.timeline.length > 0
        const repairSaved = hasSavedTimeline ? shouldRepairSavedDurations(saved, basePanels) : false
        const durationByPanel = await resolvePanelDurations(
          basePanels,
          saved,
          !hasSavedTimeline || repairSaved,
        )
        if (cancelled) return

        if (process.env.NODE_ENV !== 'production') {
          console.debug(
            '[editor] 剪辑片段时长',
            basePanels.map((p) => ({
              url: p.videoUrl,
              panelDuration: p.duration,
              resolved: durationByPanel.get(panelKey(p)),
            })),
          )
        }

        if (hasSavedTimeline && saved) {
          const panelsByKey = new Map(basePanels.map((p) => [panelKey(p), p]))
          setInitialProject(refreshSavedProjectFromPanels(saved, panelsByKey, durationByPanel))
          return
        }

        const panels = basePanels.map((p) => ({
          ...p,
          duration: durationByPanel.get(panelKey(p)) ?? DEFAULT_CLIP_DURATION_SEC,
        }))
        const clipVoiceLines = panels.map((panel) => {
          if (panel.usesLipSyncVideo) return undefined
          const voiceLine = voiceLinesByPanel.get(`${panel.storyboardId}-${panel.panelIndex ?? 'unknown'}`)
          if (!voiceLine?.audioUrl) return undefined
          return {
            id: voiceLine.id,
            speaker: voiceLine.speaker,
            content: voiceLine.content,
            audioUrl: voiceLine.audioUrl,
          }
        })

        setInitialProject(createProjectFromPanels(episodeId, panels, clipVoiceLines))
      } catch {
        // 加载失败 → 落到空工程
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [episodeId, episodeLoading, basePanels, voiceLinesByPanel, loadProject])

  // basePanels 中尚未进当前工程的片段（按 panelKey 比对），用于"同步新片段"按钮
  const newPanels = useMemo(() => {
    if (!initialProject) return []
    const existing = new Set(
      initialProject.timeline.map((c) => c.metadata?.panelId || `${c.metadata?.storyboardId ?? ''}-unknown`),
    )
    return basePanels.filter((p) => !existing.has(panelKey(p)))
  }, [basePanels, initialProject])

  // 把新片段追加到当前工程末尾，保存到后端（后端会清空 renderStatus/outputUrl，
  // 使旧的渲染结果失效），再 bump key 让 VideoEditorStage 重新挂载载入新工程。
  // ⚠️ 必须先保存再 bump key：保存后后端 renderStatus=null，重挂载时 GET 拿到 null，
  // 界面才会显示「导出」而非「下载成片」——否则用户会下载到旧的视频。
  const handleSyncNewClips = useCallback(async () => {
    if (!episodeId || !initialProject || newPanels.length === 0) return
    const newVoiceLines = newPanels.map((panel) => {
      if (panel.usesLipSyncVideo) return undefined
      const vl = voiceLinesByPanel.get(`${panel.storyboardId}-${panel.panelIndex ?? 'unknown'}`)
      if (!vl?.audioUrl) return undefined
      return { id: vl.id, speaker: vl.speaker, content: vl.content, audioUrl: vl.audioUrl }
    })
    const part = createProjectFromPanels(episodeId, newPanels, newVoiceLines)
    const merged: VideoEditorProject = {
      ...initialProject,
      timeline: [...initialProject.timeline, ...part.timeline],
    }
    try {
      await saveProject(merged)
    } catch {
      // 保存失败仍更新本地状态，让用户能手动保存；但不 bump key（避免显示陈旧的 completed）
      setInitialProject(merged)
      return
    }
    setInitialProject(merged)
    setSyncVersion((v) => v + 1)
  }, [initialProject, newPanels, voiceLinesByPanel, episodeId, saveProject])

  if (!episodeId) return null
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-[var(--glass-text-tertiary)]">
        加载剪辑器…
      </div>
    )
  }

  return (
    <VideoEditorStage
      key={`${episodeId}-${syncVersion}`}
      projectId={projectId}
      episodeId={episodeId}
      initialProject={initialProject}
      newClipCount={newPanels.length}
      onSyncNewClips={handleSyncNewClips}
      onBack={() => runtime.onStageChange('videos')}
    />
  )
}
