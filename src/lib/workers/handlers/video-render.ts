import { readFile } from 'node:fs/promises'
import type { Job } from 'bullmq'
import { prisma } from '@/lib/prisma'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'
import { isTaskActive } from '@/lib/task/service'
import { reportTaskProgress } from '../shared'
import { assertTaskActive, uploadVideoSourceToCos } from '../utils'
import { renderEditorProject } from '@/lib/video-editor/compose'
import { getMediaObjectByPublicId } from '@/lib/media/service'
import { getSignedObjectUrl } from '@/lib/storage'
import type { VideoEditorProject, VideoClip, BgmClip, EditorConfig } from '@/features/video-editor/types/editor.types'

type AnyObj = Record<string, unknown>

const DEFAULT_CONFIG: EditorConfig = { fps: 30, width: 1920, height: 1080 }
const URL_TTL_SEC = 7200

const COS_KEY_PREFIXES = ['images/', 'voice/', 'video/'] as const

function isCosKey(src: string): boolean {
  return COS_KEY_PREFIXES.some((p) => src.startsWith(p))
}

/** 从 src 提取 /m/<publicId> 短链的 publicId（兼容相对 /m/xxx 与绝对 .../m/xxx）。 */
function extractMediaPublicId(src: string): string | null {
  try {
    const u = new URL(src, 'http://placeholder.local')
    const m = u.pathname.match(/^\/m\/([^/?#]+)/)
    if (m) return m[1]
  } catch {
    // 非法 URL 走正则兜底
  }
  const m2 = src.match(/\/m\/([^/?#]+)/)
  return m2 ? m2[1] : null
}

/**
 * 从各种 src 形态提取底层 COS storageKey（不含协议 / 代理前缀）。
 *  - 裸 key（images/voice/video/…）→ 原样；
 *  - /m/<publicId> 短链 → 查 media_objects.storageKey；
 *  - /api/storage/sign?key=XXX → 反解 key（searchParams 自动 URL-decode）；
 *  - /api/files/KEY（local 代理）→ decode KEY；
 *  - 绝对 http(s)/data URL → 返回 null（不当 key，留给上层原样放行）；
 *  - 其它 → 当 key 原样返回（交给签名方，无效 key 最终 fetch 会 404，但不至于抛 parse 错）。
 */
async function extractStorageKey(src: string): Promise<string | null> {
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return null
  if (isCosKey(src)) return src

  const publicId = extractMediaPublicId(src)
  if (publicId) {
    const media = await getMediaObjectByPublicId(publicId)
    return media?.storageKey ?? null
  }

  if (src.includes('key=')) {
    try {
      const u = new URL(src, 'http://placeholder.local')
      const key = u.searchParams.get('key')
      if (key) return key
    } catch {
      // 解析失败继续尝试后续路径
    }
  }

  const filesMatch = src.match(/\/api\/files\/(.+)$/)
  if (filesMatch) return decodeURIComponent(filesMatch[1])

  return src
}

/**
 * 把 clip/bgm 的 src 归一为 worker 端可直接 fetch 的【绝对】COS presigned URL。
 *
 * ⚠️ 不能用 getSignedUrl / toSignedUrlIfCos：它们返回的是应用层代理相对 URL
 * （/api/storage/sign?key=…），浏览器同源能访问，但 worker 的 fetch 拿到相对路径会抛
 * "Failed to parse URL"。这里统一提取 storageKey 后用 getSignedObjectUrl 直签 MinIO
 * presigned（绝对 URL，带 endpoint），worker 直连对象存储，彻底绕开 app 代理。
 */
async function resolveWorkerMediaUrl(src: string): Promise<string> {
  // 绝对 http(s)/data URL：无需签名，原样放行
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) {
    return src
  }

  const key = await extractStorageKey(src)
  if (key === null) {
    throw new Error(`VIDEO_RENDER_MEDIA_URL_INVALID: ${src.slice(0, 100)}`)
  }
  return await getSignedObjectUrl(key, URL_TTL_SEC)
}

/** 把 clip 的视频/配音 src 解析为可直接 fetch 的 presigned URL。 */
async function resolveClipUrls(clips: VideoClip[]): Promise<VideoClip[]> {
  return Promise.all(
    clips.map(async (clip) => {
      const resolved: VideoClip = { ...clip, src: await resolveWorkerMediaUrl(clip.src) }
      if (clip.attachment?.audio?.src) {
        resolved.attachment = {
          ...clip.attachment,
          audio: { ...clip.attachment.audio, src: await resolveWorkerMediaUrl(clip.attachment.audio.src) },
        }
      }
      return resolved
    }),
  )
}

async function resolveBgmUrls(bgmTrack: BgmClip[]): Promise<BgmClip[]> {
  return Promise.all(
    bgmTrack.map(async (bgm) => ({ ...bgm, src: await resolveWorkerMediaUrl(bgm.src) })),
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
