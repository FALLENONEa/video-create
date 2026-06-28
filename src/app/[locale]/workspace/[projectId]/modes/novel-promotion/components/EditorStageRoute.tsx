'use client'

import { useEffect, useState } from 'react'
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
  description?: string
  duration?: number
}

function normalizeDurationSec(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function panelKey(panel: Pick<EditorPanelDraft, 'id' | 'storyboardId' | 'panelIndex'>): string {
  return panel.id || `${panel.storyboardId}:${panel.panelIndex ?? 'unknown'}`
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
    const metadataKey = metadata?.panelId || `${metadata?.storyboardId ?? ''}:${panel.panelIndex ?? 'unknown'}`
    return metadataKey === key
  })
  return normalizeDurationSec(clip ? clip.durationInFrames / saved.config.fps : undefined)
}

function shouldRepairSavedDurations(saved: VideoEditorProject, panels: EditorPanelDraft[]): boolean {
  const panelsByKey = new Map(panels.map((panel) => [panelKey(panel), panel]))
  return saved.timeline.some((clip) => {
    const metadataKey = clip.metadata?.panelId || `${clip.metadata?.storyboardId ?? ''}:unknown`
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
    const storedDuration = normalizeDurationSec(panel.duration)
    if (storedDuration) return [panelKey(panel), storedDuration] as const

    const savedDuration = findSavedClipDuration(saved, panel)
    if (savedDuration && (!probeMissing || savedDuration > SHORT_FALLBACK_DURATION_SEC)) {
      return [panelKey(panel), savedDuration] as const
    }

    if (probeMissing) {
      const probedDuration = await probeVideoDurationWithRetry(panel.videoUrl)
      if (probedDuration) return [panelKey(panel), probedDuration] as const
    }

    return [panelKey(panel), savedDuration ?? DEFAULT_CLIP_DURATION_SEC] as const
  }))

  return new Map(entries)
}

function applyPanelDurationsToProject(
  project: VideoEditorProject,
  durations: Map<string, number>,
): VideoEditorProject {
  let changed = false
  const timeline = project.timeline.map((clip) => {
    const key = clip.metadata?.panelId || `${clip.metadata?.storyboardId ?? ''}:unknown`
    const duration = durations.get(key)
    if (!duration) return clip
    const durationInFrames = Math.max(1, Math.round(duration * project.config.fps))
    if (durationInFrames === clip.durationInFrames) return clip
    changed = true
    return { ...clip, durationInFrames }
  })

  return changed ? { ...project, timeline } : project
}

/**
 * AI 剪辑 stage：加载已保存工程；若无则从当前 episode 的分镜面板（含已生成视频）自动构造。
 */
export default function EditorStageRoute() {
  const { projectId, episodeId } = useWorkspaceProvider()
  const runtime = useWorkspaceStageRuntime()
  const { storyboards, isLoading: episodeLoading } = useWorkspaceEpisodeStageData()
  const { loadProject } = useEditorActions({ projectId, episodeId: episodeId || '' })

  const [initialProject, setInitialProject] = useState<VideoEditorProject | undefined>(undefined)
  const [loading, setLoading] = useState(true)

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
        // 先收集所有"有视频源"的面板——panel 是否纳入只取决于有无 URL，
        // 绝不因时长探测失败而丢弃（这正是上一版视频整体消失的根因）。
        // lipSyncVideoUrl 优先，回退 videoUrl。
        const basePanels = storyboards
          .flatMap((sb) => sb.panels || [])
          .map((p) => {
            const url = p.lipSyncVideoUrl || p.videoUrl
            if (!url) return null
            return {
              id: p.id,
              panelIndex: p.panelIndex,
              storyboardId: p.storyboardId,
              videoUrl: url,
              description: p.description || undefined,
              duration: normalizeDurationSec(p.duration),
            }
          })
          .filter((p): p is NonNullable<typeof p> => p !== null)

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
          setInitialProject(applyPanelDurationsToProject(saved, durationByPanel))
          return
        }

        const panels = basePanels.map((p) => ({
          ...p,
          duration: durationByPanel.get(panelKey(p)) ?? DEFAULT_CLIP_DURATION_SEC,
        }))

        setInitialProject(createProjectFromPanels(episodeId, panels))
      } catch {
        // 加载失败 → 落到空工程
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [episodeId, episodeLoading, storyboards, loadProject])

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
      key={episodeId}
      projectId={projectId}
      episodeId={episodeId}
      initialProject={initialProject}
      onBack={() => runtime.onStageChange('videos')}
    />
  )
}
