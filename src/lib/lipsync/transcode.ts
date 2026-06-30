import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolveFfmpegPath } from '@/lib/video-editor/ffmpeg-runner'

const TRANSCODE_TIMEOUT_MS = 60_000

/**
 * 把任意音频（MP3/M4A/非标准 WAV）转码为标准 PCM WAV（RIFF/WAVE），供 lipsync 预处理 pad/trim。
 *
 * 配音文件名被生成层硬编码为 .wav，但实际编码可能是 MP3 等；pad/trim 只能操作 WAV 的 PCM
 * 字节，故遇到非 WAV（parseWavInfo 返回 null）时先归一化。用 ffmpeg stdin→stdout 管道，无临时文件。
 */
export async function transcodeAudioToWav(input: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(
        resolveFfmpegPath(),
        ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'wav', '-c:a', 'pcm_s16le', 'pipe:1'],
        { windowsHide: true },
      ) as ChildProcessWithoutNullStreams
    } catch (error) {
      reject(toError('LIPSYNC_AUDIO_TRANSCODE_SPAWN_FAILED', error))
      return
    }

    const chunks: Buffer[] = []
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

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
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
      const output = Buffer.concat(chunks)
      if (!isWavHeader(output)) {
        finish(() => reject(new Error('LIPSYNC_AUDIO_TRANSCODE_INVALID_OUTPUT')))
        return
      }
      finish(() => resolve(output))
    })
    // ffmpeg 消费完输入后可能提前关闭 stdin 触发 EPIPE，属正常；最终以 close 事件为准
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

function toError(prefix: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`${prefix}: ${message}`)
}

function isWavHeader(buffer: Buffer): boolean {
  return (
    buffer.length >= 44 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WAVE'
  )
}
