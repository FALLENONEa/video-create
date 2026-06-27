import { readFile } from 'node:fs/promises'
import type { Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'
import { isTaskActive } from '@/lib/task/service'
import { reportTaskProgress } from '../shared'
import { assertTaskActive, toSignedUrlIfCos, uploadVideoSourceToCos } from '../utils'
import { renderEditorProject } from '@/lib/video-editor/compose'
import type { VideoEditorProject, VideoClip, BgmClip, EditorConfig } from '@/features/video-editor/types/editor.types'

type AnyObj = Record<string, unknown>

const DEFAULT_CONFIG: EditorConfig = { fps: 30, width: 1920, height: 1080 }
const URL_TTL_SEC = 7200

function signMediaUrl(src: string): string {
  const url = toSignedUrlIfCos(src, URL_TTL_SEC)
  if (!url) throw new Error(`VIDEO_RENDER_MEDIA_URL_INVALID: ${src}`)
  return url
}

/** 把 clip 的视频/配音 src 解析为可直接 fetch 的 presigned URL。 */
async function resolveClipUrls(clips: VideoClip[]): Promise<VideoClip[]> {
  return Promise.all(
    clips.map(async (clip) => {
      const resolved: VideoClip = { ...clip, src: signMediaUrl(clip.src) }
      if (clip.attachment?.audio?.src) {
        resolved.attachment = {
          ...clip.attachment,
          audio: { ...clip.attachment.audio, src: signMediaUrl(clip.attachment.audio.src) },
        }
      }
      return resolved
    }),
  )
}

async function resolveBgmUrls(bgmTrack: BgmClip[]): Promise<BgmClip[]> {
  return Promise.all(
    bgmTrack.map(async (bgm) => ({ ...bgm, src: signMediaUrl(bgm.src) })),
  )
}

/**
 * VIDEO_RENDER 任务处理器：读取剪辑工程 → ffmpeg 渲染为 mp4 → 上传 COS → 回写产物 URL。
 *
 * 失败时把 renderStatus 置 failed，避免前端长时间停在 rendering。
 */
export async function handleVideoRenderTask(job: Job<TaskJobData>) {
  const payload = (job.data.payload || {}) as AnyObj
  const editorProjectId =
    (typeof payload.editorProjectId === 'string' && payload.editorProjectId.trim()) ||
    (job.data.targetType === 'VideoEditorProject' ? job.data.targetId : '')

  if (!editorProjectId) {
    throw new Error('VIDEO_RENDER_NO_PROJECT: editorProjectId missing')
  }

  try {
    const project = await prisma.videoEditorProject.findUnique({ where: { id: editorProjectId } })
    if (!project) throw new Error('VIDEO_RENDER_PROJECT_NOT_FOUND')

    await prisma.videoEditorProject.update({
      where: { id: editorProjectId },
      data: { renderStatus: 'rendering', renderTaskId: job.data.taskId, outputUrl: null },
    })

    await reportTaskProgress(job, 5, { stage: 'render_prepare' })

    const projectData = JSON.parse(project.projectData) as Partial<VideoEditorProject>
    const clips = projectData.timeline || []
    const bgmTrack = projectData.bgmTrack || []
    const config: EditorConfig = projectData.config ?? DEFAULT_CONFIG

    if (!clips.length) throw new Error('VIDEO_RENDER_EMPTY_TIMELINE')

    const resolvedClips = await resolveClipUrls(clips)
    const resolvedBgm = await resolveBgmUrls(bgmTrack)

    await assertTaskActive(job, 'render_start')
    await reportTaskProgress(job, 8, { stage: 'render_start' })

    const { outputPath, cleanup } = await renderEditorProject(
      { clips: resolvedClips, bgmTrack: resolvedBgm, config },
      {
        shouldCancel: async () => {
          try {
            return !(await isTaskActive(job.data.taskId))
          } catch {
            return false
          }
        },
        onProgress: (percent) => {
          // 渲染进度映射到全局 8-92
          void reportTaskProgress(job, Math.round(8 + percent * 0.84), {
            stage: 'rendering',
            percent,
          }).catch(() => {})
        },
      },
    )

    try {
      await reportTaskProgress(job, 93, { stage: 'render_upload' })
      const buffer = await readFile(outputPath)
      const cosKey = await uploadVideoSourceToCos(buffer, 'video-render', editorProjectId)

      await prisma.videoEditorProject.update({
        where: { id: editorProjectId },
        data: { renderStatus: 'completed', outputUrl: cosKey },
      })

      return { editorProjectId, outputUrl: cosKey }
    } finally {
      await cleanup()
    }
  } catch (error) {
    await prisma.videoEditorProject
      .update({ where: { id: editorProjectId }, data: { renderStatus: 'failed' } })
      .catch(() => {})
    throw error
  }
}

export const VIDEO_RENDER_TASK_TYPE = TASK_TYPE.VIDEO_RENDER
