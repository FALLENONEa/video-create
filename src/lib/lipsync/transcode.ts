import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveFfmpegPath } from '@/lib/video-editor/ffmpeg-runner'

const TRANSCODE_TIMEOUT_MS = 60_000

/**
 * 把任意音频（MP3/M4A/非标准 WAV）转码为标准 PCM WAV，供 lipsync 预处理 pad/trim。
 *
 * 必须输出到临时文件而非 stdout 管道：WAV 的 data chunk size 需在写完后回填，但管道不可 seek，
 * ffmpeg 会把 data size 写成 0/占位，下游 parseWavInfo 取不到时长（LIPSYNC_AUDIO_DURATION_PARSE_FAILED）。
 * 文件可 seek，size 正确回填。转码后校验产物 RIFF/WAVE + data size > 0，确保下游 pad/trim 可用。
 */
export async function transcodeAudioToWav(input: Buffer): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lip-transcode-'))
  const inFile = path.join(dir, `in-${randomUUID()}`)
  const outFile = path.join(dir, `out-${randomUUID()}.wav`)
  try {
    await writeFile(inFile, input)
    await runFfmpegFileToFile(inFile, outFile)
    const output = await readFile(outFile)
    if (!isValidTranscodedWav(output)) {
      throw new Error('LIPSYNC_AUDIO_TRANSCODE_INVALID_OUTPUT')
    }
    return output
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // 清理失败不影响主流程
    })
  }
}

function runFfmpegFileToFile(input: string, output: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      resolveFfmpegPath(),
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-f', 'wav', '-c:a', 'pcm_s16le', output],
      { windowsHide: true },
    )

    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      finish(() => reject(new Error('LIPSYNC_AUDIO_TRANSCODE_TIMEOUT')))
    }, TRANSCODE_TIMEOUT_MS)

    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGKILL')
      } catch {
        // 子进程可能已退出，忽略
      }
      action()
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish(() => reject(toError('LIPSYNC_AUDIO_TRANSCODE_FAILED', error)))
    })
    child.on('close', (code) => {
      if (code !== 0) {
        finish(() => reject(new Error(`LIPSYNC_AUDIO_TRANSCODE_FAILED(${code ?? 'null'}): ${stderr.slice(-400)}`)))
        return
      }
      finish(() => resolve())
    })
  })
}

function toError(prefix: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`${prefix}: ${message}`)
}

/** 校验转码产物：RIFF/WAVE 头 + 能解析到 fmt 的 byteRate 与 data chunk size 均 > 0。 */
function isValidTranscodedWav(buffer: Buffer): boolean {
  if (buffer.length < 44) return false
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF') return false
  if (buffer.subarray(8, 12).toString('ascii') !== 'WAVE') return false
  let offset = 12
  let byteRate = 0
  let dataSize = 0
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.subarray(offset, offset + 4).toString('ascii')
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkSize
    if (chunkEnd > buffer.length) return false
    if (chunkId === 'fmt ') {
      byteRate = buffer.readUInt32LE(chunkStart + 8)
    } else if (chunkId === 'data') {
      dataSize = chunkSize
      break
    }
    offset = chunkEnd + (chunkSize % 2)
  }
  return byteRate > 0 && dataSize > 0
}
