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

const COS_KEY_PREFIXES = ['images/', 'voice/', 'video/'] as const

function isCosKey(src: string): boolean {
  return COS_KEY_PREFIXES.some((p) => src.startsWith(p))
}

/**
 * 把 clip/bgm 的 src 归一为 worker 端可直接 fetch 的 COS presigned 绝对 URL。
 *
 * 工程里 src 可能是多种形态：
 *  - 裸 COS key（video/xxx.mp4）→ 直接签名；
 *  - 前端签名代理 URL（/api/storage/sign?key=video/xxx 或 https://域名/api/storage/sign?key=...）
 *    → 反解 key 参数重新签名（拿到新鲜 COS 直连 URL：绕开 app 域名可达性问题、避免旧 token 过期）；
 *  - 绝对 http(s)/data URL → 原样使用；
 *  - 其它 → 尝试当 key 签名，失败则抛 VIDEO_RENDER_MEDIA_URL_INVALID。
 *
 * 关键：相对 URL（/api/...）会被 Node 的 new URL/fetch 判为 "Invalid URL" 瞬间挂掉任务，
 * 这里统一归一成绝对 URL，避免下游 compose/downloadToFile 再踩这个坑。
 */
function resolveWorkerMediaUrl(src: string): string {
  // 1. 裸 COS key：直接签
  if (isCosKey(src)) {
    const signed = toSignedUrlIfCos(src, URL_TTL_SEC)
    if (signed) return signed
    throw new Error(`VIDEO_RENDER_MEDIA_URL_INVALID: ${src.slice(0, 100)}`)
  }

  // 2. 签名代理 URL（含 key= 参数）：反解出真实 key，重新签 COS 直连 URL
  if (src.includes('key=')) {
    try {
      const u = new URL(src, 'http://placeholder.local')
      const key = u.searchParams.get('key')
      if (key && isCosKey(key)) {
        const signed = toSignedUrlIfCos(key, URL_TTL_SEC)
        if (signed) return signed
      }
    } catch {
      // 解析失败则继续尝试后续路径
    }
  }

  // 3. 绝对 http(s) / data URL：原样使用
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
    return src
  }

  // 4. 兜底：当作 key 尝试签名
  const fallback = toSignedUrlIfCos(src, URL_TTL_SEC)
  if (fallback) return fallback

  throw new Error(`VIDEO_RENDER_MEDIA_URL_INVALID: ${src.slice(0, 100)}`)
}

/** 把 clip 的视频/配音 src 解析为可直接 fetch 的 presigned URL。 */
async function resolveClipUrls(clips: VideoClip[]): Promise<VideoClip[]> {
  return Promise.all(
    clips.map(async (clip) => {
      const resolved: VideoClip = { ...clip, src: resolveWorkerMediaUrl(clip.src) }
      if (clip.attachment?.audio?.src) {
        resolved.attachment = {
          ...clip.attachment,
          audio: { ...clip.attachment.audio, src: resolveWorkerMediaUrl(clip.attachment.audio.src) },
        }
      }
      return resolved
    }),
  )
}

async function resolveBgmUrls(bgmTrack: BgmClip[]): Promise<BgmClip[]> {
  return Promise.all(
    bgmTrack.map(async (bgm) => ({ ...bgm, src: resolveWorkerMediaUrl(bgm.src) })),
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
