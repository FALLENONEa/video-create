'use client'

import { useEffect, useState } from 'react'
import { VideoEditorStage, useEditorActions, createProjectFromPanels } from '@/features/video-editor'
import type { VideoEditorProject } from '@/features/video-editor/types/editor.types'
import { useWorkspaceProvider } from '../WorkspaceProvider'
import { useWorkspaceStageRuntime } from '../WorkspaceStageRuntimeContext'
import { useWorkspaceEpisodeStageData } from '../hooks/useWorkspaceEpisodeStageData'

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
    timer = setTimeout(() => done(null), 6000)
    document.body.appendChild(video)
    video.src = src
    try {
      video.load()
    } catch {
      /* noop */
    }
  })
}

/**
 * AI 剪辑 stage：加载已保存工程；若无则从当前 episode 的分镜面板（含已生成视频）自动构造。
 */
export default function EditorStageRoute() {
  const { projectId, episodeId } = useWorkspaceProvider()
  const runtime = useWorkspaceStageRuntime()
  const { storyboards } = useWorkspaceEpisodeStageData()
  const { loadProject } = useEditorActions({ projectId, episodeId: episodeId || '' })

  const [initialProject, setInitialProject] = useState<VideoEditorProject | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!episodeId) {
      setLoading(false)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const saved = await loadProject()
        if (cancelled) return
        // 仅当存档含有效片段时才采用；空 timeline 存档（如误触导出保存的空工程）
        // 回退到面板重建，避免被空存档永久固化
        if (saved && Array.isArray(saved.timeline) && saved.timeline.length > 0) {
          setInitialProject(saved)
          return
        }
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
              duration:
                typeof p.duration === 'number' && p.duration > 0 ? p.duration : undefined,
            }
          })
          .filter((p): p is NonNullable<typeof p> => p !== null)

        if (basePanels.length === 0) return

        // 时长探测仅用于"修正"：成功用视频真实时长，失败回退 panel.duration，再回退默认 3s
        const durations = await Promise.all(
          basePanels.map((p) => probeVideoDuration(p.videoUrl)),
        )
        if (cancelled) return

        if (process.env.NODE_ENV !== 'production') {
          const ok = durations.filter((d) => d !== null).length
          console.debug(
            `[editor] 视频时长探测 ${ok}/${durations.length} 成功`,
            basePanels.map((p, i) => ({
              url: p.videoUrl,
              probed: durations[i],
              panelDuration: p.duration,
            })),
          )
        }

        const panels = basePanels.map((p, i) => ({
          ...p,
          duration: durations[i] ?? p.duration ?? 3,
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
  }, [episodeId, storyboards, loadProject])

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
      projectId={projectId}
      episodeId={episodeId}
      initialProject={initialProject}
      onBack={() => runtime.onStageChange('videos')}
    />
  )
}
