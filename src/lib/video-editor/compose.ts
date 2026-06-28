import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { VideoClip, BgmClip, EditorConfig } from '@/features/video-editor/types/editor.types'
import { calculateTimelineDuration } from '@/features/video-editor/utils/time-utils'
import { downloadToFile, runFfmpeg, runFfprobe, type ProbeResult } from './ffmpeg-runner'
import { createScopedLogger } from '@/lib/logging/core'

const log = createScopedLogger({ module: 'video-editor:compose' })

/** 渲染合成入参。clips/bgm 的 src 必须是可直接 fetch 的 URL（COS presigned 或公网）。 */
export interface ComposeInput {
  clips: VideoClip[]
  bgmTrack: BgmClip[]
  config: EditorConfig
}

export interface ComposeOptions {
  /** 渲染进度回调（0-100）。 */
  onProgress?: (percent: number) => void
  /** 取消检查；返回 true 时中止渲染。 */
  shouldCancel?: () => boolean | Promise<boolean>
}

export interface ComposeResult {
  outputPath: string
  cleanup: () => Promise<void>
}

interface ClipMedia {
  /** 相对 workDir 的视频文件名。 */
  video: string
  /** 相对 workDir 的配音文件名；无配音为 null。 */
  dub: string | null
  probe: ProbeResult
}

interface BgmMeta {
  /** 相对 workDir 的 BGM 文件名。 */
  file: string
  startFrame: number
  volume: number
  fadeInFrames: number
  fadeOutFrames: number
}

interface StageContext {
  clips: VideoClip[]
  bgmTrack: BgmClip[]
  config: EditorConfig
  workDir: string
  media: ClipMedia[]
  /** 已下载的 BGM 元数据（仅含有效 src）。 */
  bgmMetas: BgmMeta[]
  shouldCancel?: () => boolean | Promise<boolean>
  emit: (percent: number) => void
}

const AUDIO_RATE = 44100
const AUDIO_CH = 'stereo'

/** 把阶段内进度（0-100）映射到全局区间 [stageStart, stageEnd]。 */
function mapStage(stageStart: number, stageEnd: number, inner: number): number {
  return Math.round(stageStart + (stageEnd - stageStart) * (inner / 100))
}

function framesToSec(frames: number, fps: number): number {
  return frames / fps
}

/**
 * 渲染一个剪辑工程为本地 mp4 文件，返回输出文件路径与 cleanup。
 *
 * 流程（4 阶段，全程 ffmpeg，不依赖 Chromium）：
 *   1. 下载所有素材到 workDir + ffprobe 摸底（0-10%）
 *   2. 每段标准化：scale+pad 画幅适配、trim 裁剪、统一帧率、烧字幕、叠配音、保底音频轨（10-55%）
 *   3. concat 顺序硬切拼接（55-90%）
 *   4. 叠 BGM 混音（90-100%）
 *
 * 调用方负责在用完后调用 cleanup 删除临时目录。
 */
export async function renderEditorProject(
  input: ComposeInput,
  options: ComposeOptions = {},
): Promise<ComposeResult> {
  const { onProgress, shouldCancel } = options

  if (!input.clips || input.clips.length === 0) {
    throw new Error('VIDEO_RENDER_EMPTY_TIMELINE: 时间轴为空，无可渲染片段')
  }
  const { fps } = input.config
  if (!fps || fps <= 0) throw new Error('VIDEO_RENDER_INVALID_FPS')

  const workDir = path.join(os.tmpdir(), `waoowaoo-render-${randomUUID()}`)
  await fs.mkdir(workDir, { recursive: true })
  log.info('创建渲染工作目录', { workDir })

  const emit = (p: number) => onProgress?.(p)
  const checkCancel = async () => {
    if (shouldCancel && (await shouldCancel())) throw new Error('VIDEO_RENDER_CANCELLED')
  }

  const cleanup = async () => {
    try {
      await fs.rm(workDir, { recursive: true, force: true })
    } catch (error) {
      log.warn('清理临时渲染目录失败', { workDir, error: String(error) })
    }
  }

  try {
    // ── 阶段 1：下载 + probe ──
    const media = await stageDownload(input, workDir, shouldCancel, (p) => emit(mapStage(0, 10, p)))
    const bgmMetas = await stageDownloadBgm(input.bgmTrack, workDir)
    await checkCancel()

    const ctx: StageContext = {
      clips: input.clips,
      bgmTrack: input.bgmTrack,
      config: input.config,
      workDir,
      media,
      bgmMetas,
      shouldCancel,
      emit,
    }

    // ── 阶段 2：每段标准化 ──
    const normFiles = await stageNormalize(ctx, (p) => emit(mapStage(10, 55, p)))
    await checkCancel()

    // ── 阶段 3：顺序硬切拼接 ──
    const totalSec = framesToSec(calculateTimelineDuration(input.clips), fps)
    const concatFile = await stageConcat(ctx, normFiles, totalSec, (p) => emit(mapStage(55, 90, p)))
    await checkCancel()

    // ── 阶段 4：叠 BGM ──
    const outputFile = await stageBgm(ctx, concatFile, totalSec, (p) => emit(mapStage(90, 100, p)))
    await checkCancel()

    const outputPath = path.join(workDir, outputFile)
    log.info('渲染完成', { outputPath, totalSec })
    return { outputPath, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** 阶段 1：并发下载所有 clip 的视频与配音，并 probe 视频元数据。 */
async function stageDownload(
  input: ComposeInput,
  workDir: string,
  shouldCancel: StageContext['shouldCancel'],
  onProgress: (p: number) => void,
): Promise<ClipMedia[]> {
  const total = input.clips.length
  const results = new Array<ClipMedia>(total)
  let done = 0
  const report = () => onProgress(Math.round((done / total) * 100))

  // 限制并发避免一次性打开过多连接
  const CONCURRENCY = 4
  let cursor = 0
  async function worker() {
    while (cursor < total) {
      const i = cursor++
      const clip = input.clips[i]
      const video = `clip_${i}${path.extname(new URL(clip.src).pathname) || '.mp4'}`.replace(/[^A-Za-z0-9._-]/g, '_')
      await downloadToFile(clip.src, path.join(workDir, video))

      let dub: string | null = null
      if (clip.attachment?.audio?.src) {
        const dubExt = path.extname(new URL(clip.attachment.audio.src).pathname) || '.mp3'
        dub = `dub_${i}${dubExt}`.replace(/[^A-Za-z0-9._-]/g, '_')
        await downloadToFile(clip.attachment.audio.src, path.join(workDir, dub))
      }
      const probe = await runFfprobe(path.join(workDir, video))
      results[i] = { video, dub, probe }
      done++
      report()
      if (shouldCancel && (await shouldCancel())) throw new Error('VIDEO_RENDER_CANCELLED')
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker))
  return results
}

/** 下载 BGM 文件，返回元数据列表（与 bgmTrack 中有效 src 对齐）。 */
async function stageDownloadBgm(bgmTrack: BgmClip[], workDir: string): Promise<BgmMeta[]> {
  const metas: BgmMeta[] = []
  for (let i = 0; i < bgmTrack.length; i++) {
    const bgm = bgmTrack[i]
    if (!bgm?.src) continue
    const ext = path.extname(new URL(bgm.src).pathname) || '.mp3'
    const name = `bgm_${i}${ext}`.replace(/[^A-Za-z0-9._-]/g, '_')
    await downloadToFile(bgm.src, path.join(workDir, name))
    metas.push({
      file: name,
      startFrame: bgm.startFrame ?? 0,
      volume: typeof bgm.volume === 'number' ? bgm.volume : 0.6,
      fadeInFrames: bgm.fadeIn ?? 0,
      fadeOutFrames: bgm.fadeOut ?? 0,
    })
  }
  return metas
}

// ── 字幕样式：底部居中，白字黑描边。不强制 FontName，由 fontconfig 选系统中文字体。 ──
const SUB_STYLE = 'FontSize=30,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=70'

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}
function pad3(n: number): string {
  return String(n).padStart(3, '0')
}

function fmtSrtTime(durSec: number): string {
  const totalMs = Math.max(0, Math.round(durSec * 1000))
  const h = Math.floor(totalMs / 3600000)
  const m = Math.floor((totalMs % 3600000) / 60000)
  const s = Math.floor((totalMs % 60000) / 1000)
  const ms = totalMs % 1000
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(ms)}`
}

/** 转义 srt 文本中的 libass 标签字符，换行转空格（单行字幕）。 */
function escapeSrtText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ')
    .trim()
}

/**
 * 生成单条字幕 srt 文件。整段 clip 持续显示该字幕。
 * 返回用于 subtitles 滤镜的引用串（含 force_style）；无字幕返回 null。
 */
async function writeSubtitleSrt(
  workDir: string,
  index: number,
  text: string,
  durSec: number,
): Promise<string | null> {
  const safe = escapeSrtText(text)
  if (!safe) return null
  const content = `1\n00:00:00,000 --> ${fmtSrtTime(durSec)}\n${safe}\n`
  const filename = `sub_${index}.srt`
  await fs.writeFile(path.join(workDir, filename), content, 'utf8')
  return `${filename}:force_style='${SUB_STYLE}'`
}

/** 构造标准化阶段的 filter_complex。 */
function buildNormalizeFilter(
  clip: VideoClip,
  media: ClipMedia,
  config: EditorConfig,
  hasDub: boolean,
  subRef: string | null,
): string {
  const { width: W, height: H, fps } = config
  let vchain = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:-1:-1:color=black,setsar=1,fps=${fps}`
  if (subRef) vchain += `,subtitles=${subRef}`
  const parts: string[] = [`${vchain}[v]`]

  if (hasDub && clip.attachment?.audio) {
    const dv = typeof clip.attachment.audio.volume === 'number' ? clip.attachment.audio.volume : 1
    if (media.probe.hasAudio) {
      parts.push(`[0:a]aresample=${AUDIO_RATE}[a0]`)
      parts.push(`[1:a]aresample=${AUDIO_RATE},volume=${dv}[a1]`)
      parts.push(`[a0][a1]amix=inputs=2:duration=first:normalize=0[a]`)
    } else {
      parts.push(`[1:a]aresample=${AUDIO_RATE},volume=${dv}[a]`)
    }
  } else if (media.probe.hasAudio) {
    parts.push(`[0:a]aresample=${AUDIO_RATE}[a]`)
  } else {
    // 纯画面无原声也无配音：补静音轨，保证后续 concat 音频流一致
    parts.push(`anullsrc=r=${AUDIO_RATE}:cl=${AUDIO_CH}[a]`)
  }
  return parts.join(';')
}

/** 阶段 2：逐段标准化为统一规格（分辨率/帧率/编码 + 烧字幕 + 叠配音 + 保底音频）。 */
async function stageNormalize(
  ctx: StageContext,
  onProgress: (p: number) => void,
): Promise<string[]> {
  const { clips, config, workDir, media, shouldCancel } = ctx
  const total = clips.length
  const normFiles: string[] = []

  for (let i = 0; i < total; i++) {
    const clip = clips[i]
    const m = media[i]
    const durSec = framesToSec(clip.durationInFrames, config.fps)
    const subRef = clip.attachment?.subtitle?.text
      ? await writeSubtitleSrt(workDir, i, clip.attachment.subtitle.text, durSec)
      : null
    const hasDub = !!m.dub && !!clip.attachment?.audio

    const seekArgs: string[] = []
    if (clip.trim && m.probe.fps > 0) {
      seekArgs.push('-ss', String(clip.trim.from / m.probe.fps))
    }
    const filterSpec = buildNormalizeFilter(clip, m, config, hasDub, subRef)

    const args = [
      ...seekArgs,
      '-i', m.video,
      ...(m.dub ? ['-i', m.dub] : []),
      '-filter_complex', filterSpec,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE), '-ac', '2',
      '-r', String(config.fps),
      '-t', String(durSec),
      '-y', `norm_${i}.mp4`,
    ]

    await runFfmpeg(args, {
      cwd: workDir,
      totalDurationSec: durSec,
      label: `normalize-${i}`,
      shouldCancel,
      onProgress: (p) => onProgress(((i + p / 100) / total) * 100),
    })
    normFiles.push(`norm_${i}.mp4`)
    if (shouldCancel && (await shouldCancel())) throw new Error('VIDEO_RENDER_CANCELLED')
  }
  onProgress(100)
  return normFiles
}

/** 阶段 3：顺序硬切拼接所有标准化片段。单片段直接返回。 */
async function stageConcat(
  ctx: StageContext,
  normFiles: string[],
  totalSec: number,
  onProgress: (p: number) => void,
): Promise<string> {
  const { config, workDir, shouldCancel } = ctx
  const fps = config.fps

  if (normFiles.length === 1) {
    onProgress(100)
    return normFiles[0]
  }

  const inputArgs: string[] = []
  for (const f of normFiles) inputArgs.push('-i', f)

  const parts: string[] = []
  let prevV = '0:v'
  let prevA = '0:a'

  for (let i = 1; i < normFiles.length; i++) {
    const isLast = i === normFiles.length - 1
    const vLabel = isLast ? 'vout' : `vt${i}`
    const aLabel = isLast ? 'aout' : `at${i}`
    parts.push(`[${prevV}][${prevA}][${i}:v][${i}:a]concat=n=2:v=1:a=1[${vLabel}][${aLabel}]`)
    prevV = vLabel
    prevA = aLabel
  }

  const args = [
    ...inputArgs,
    '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE), '-ac', '2',
    '-r', String(fps),
    '-y', 'concat.mp4',
  ]

  await runFfmpeg(args, {
    cwd: workDir,
    totalDurationSec: totalSec,
    label: 'concat',
    shouldCancel,
    onProgress: (p) => onProgress(p),
  })
  onProgress(100)
  return 'concat.mp4'
}

/** 阶段 4：把 BGM 混入主音轨（视频流 copy 不重编码）。无 BGM 直接返回主文件。 */
async function stageBgm(
  ctx: StageContext,
  mainFile: string,
  totalSec: number,
  onProgress: (p: number) => void,
): Promise<string> {
  const { bgmMetas, config, workDir, shouldCancel } = ctx
  const fps = config.fps

  if (bgmMetas.length === 0) {
    onProgress(100)
    return mainFile
  }

  const inputArgs: string[] = ['-i', mainFile]
  for (const m of bgmMetas) inputArgs.push('-i', m.file)

  const parts: string[] = []
  bgmMetas.forEach((bgm, idx) => {
    const startSec = bgm.startFrame / fps
    const delayMs = Math.round(startSec * 1000)
    const chain = [`[${idx + 1}:a]adelay=${delayMs}|${delayMs},volume=${bgm.volume}`]
    if (bgm.fadeInFrames > 0) {
      chain.push(`afade=t=in:st=${startSec}:d=${bgm.fadeInFrames / fps}`)
    }
    if (bgm.fadeOutFrames > 0) {
      const outStart = Math.max(0, totalSec - bgm.fadeOutFrames / fps)
      chain.push(`afade=t=out:st=${outStart}:d=${bgm.fadeOutFrames / fps}`)
    }
    parts.push(`${chain.join(',')}[bgm${idx}]`)
  })

  const mixInputs = ['[0:a]', ...bgmMetas.map((_, idx) => `[bgm${idx}]`)].join('')
  parts.push(`${mixInputs}amix=inputs=${bgmMetas.length + 1}:duration=first:normalize=0[aout]`)

  const args = [
    ...inputArgs,
    '-filter_complex', parts.join(';'),
    '-map', '0:v', '-map', '[aout]',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE), '-ac', '2',
    '-y', 'output.mp4',
  ]

  await runFfmpeg(args, {
    cwd: workDir,
    totalDurationSec: totalSec,
    label: 'bgm',
    shouldCancel,
    onProgress: (p) => onProgress(p),
  })
  onProgress(100)
  return 'output.mp4'
}
