import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createScopedLogger } from '@/lib/logging/core'

const log = createScopedLogger({ module: 'video-editor:ffmpeg' })

export interface ProbeResult {
  durationSec: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
  hasVideo: boolean
}

/** ffmpeg 可执行路径：优先 FFMPEG_PATH，否则交给系统 PATH。 */
export function resolveFfmpegPath(): string {
  const fromEnv = (process.env.FFMPEG_PATH || '').trim()
  return fromEnv || 'ffmpeg'
}

/** ffprobe 可执行路径：FFPROBE_PATH → 与 FFMPEG_PATH 同目录 → 系统 PATH。 */
export function resolveFfprobePath(): string {
  const fromEnv = (process.env.FFPROBE_PATH || '').trim()
  if (fromEnv) return fromEnv
  const ffmpegPath = (process.env.FFMPEG_PATH || '').trim()
  if (ffmpegPath) return path.join(path.dirname(ffmpegPath), 'ffprobe')
  return 'ffprobe'
}

/** 下载远程 URL 到本地文件（流式）。用于把 COS presigned URL 落地到 workDir。 */
export async function downloadToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) {
    throw new Error(`VIDEO_RENDER_DOWNLOAD_FAILED: ${res.status} ${url}`)
  }
  await mkdir(path.dirname(dest), { recursive: true })
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(dest))
}

/** 解析 ffprobe JSON 得到时长/分辨率/帧率/音视频流情况。 */
export async function runFfprobe(file: string): Promise<ProbeResult> {
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file]
  const { stdout } = await runCapture(resolveFfprobePath(), args)
  const data = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }>
  }
  const vStream = data.streams?.find((s) => s.codec_type === 'video')
  const aStream = data.streams?.find((s) => s.codec_type === 'audio')
  const durationSec = parseFloat(data.format?.duration || (vStream ? '0' : '0')) || 0
  const fps = parseFps(vStream?.r_frame_rate)
  return {
    durationSec,
    width: vStream?.width ?? 0,
    height: vStream?.height ?? 0,
    fps,
    hasVideo: !!vStream,
    hasAudio: !!aStream,
  }
}

function parseFps(rate?: string): number {
  if (!rate) return 0
  const [num, den] = rate.split('/').map(Number)
  if (!den || !Number.isFinite(num)) return 0
  return num / den
}

export interface RunFfmpegOptions {
  /** 用于进度换算的总时长（秒）。不提供则只报已处理时长不报百分比。 */
  totalDurationSec?: number
  /** 进度回调（0-100）。 */
  onProgress?: (percent: number) => void
  /** 取消检查；为 true 时 SIGKILL 子进程。 */
  shouldCancel?: () => boolean | Promise<boolean>
  /** 日志标签。 */
  label?: string
  /** 子进程工作目录。配合相对文件名可规避 subtitles 滤镜的 Windows 路径转义坑。 */
  cwd?: string
}

/**
 * 执行一次 ffmpeg，解析 stderr 进度，支持取消。
 * 非 0 退出抛错并附带 stderr 末尾内容便于排障。
 */
export async function runFfmpeg(args: string[], opts: RunFfmpegOptions = {}): Promise<void> {
  const { totalDurationSec, onProgress, shouldCancel, label = 'ffmpeg', cwd } = opts
  return new Promise((resolve, reject) => {
    const child = spawn(resolveFfmpegPath(), args, { windowsHide: true, ...(cwd ? { cwd } : {}) })
    let stderrBuf = ''
    let cancelled = false

    const cancelTimer = setInterval(async () => {
      if (shouldCancel && (await shouldCancel())) {
        cancelled = true
        clearInterval(cancelTimer)
        try { child.kill('SIGKILL') } catch { /* noop */ }
      }
    }, 1000)

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stderrBuf += text
      // 防止无限增长，只保留尾部
      if (stderrBuf.length > 16384) stderrBuf = stderrBuf.slice(-16384)
      const m = text.match(/time=(\d+):(\d+):(\d+\.?\d*)/)
      if (m && totalDurationSec && totalDurationSec > 0 && onProgress) {
        const sec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])
        const percent = Math.min(99, Math.round((sec / totalDurationSec) * 100))
        onProgress(percent)
      }
    })

    child.on('error', (err) => {
      clearInterval(cancelTimer)
      reject(new Error(`VIDEO_RENDER_FFMPEG_SPAWN_FAILED: ${label} ${String(err)}`))
    })

    child.on('close', (code) => {
      clearInterval(cancelTimer)
      if (cancelled) {
        reject(new Error('VIDEO_RENDER_CANCELLED'))
        return
      }
      if (code === 0) {
        onProgress?.(100)
        resolve()
        return
      }
      const tail = stderrBuf.split('\n').filter(Boolean).slice(-8).join('\n')
      log.error('ffmpeg 执行失败', { label, code, tail })
      reject(new Error(`VIDEO_RENDER_FFMPEG_FAILED: ${label} exit=${code}\n${tail}`))
    })
  })
}

/** 捕获子进程 stdout（用于 ffprobe）。 */
function runCapture(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(cmd, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString() })
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString() })
    child.on('error', (err) => reject(new Error(`VIDEO_RENDER_FFPROBE_SPAWN_FAILED: ${String(err)}`)))
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`VIDEO_RENDER_FFPROBE_FAILED: exit=${code}\n${stderr}`))
    })
  })
}
