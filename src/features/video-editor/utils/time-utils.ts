import { VideoClip, ComputedClip, VideoEditorProject } from '../types/editor.types'

/**
 * 计算某个片段与下一个片段之间的有效转场重叠帧数。
 * 当前导出链路的语义是转场参数的一半作为真实重叠时长。
 */
export function getTransitionOverlapFrames(
    clips: VideoClip[],
    index: number,
    previousAvailableFrames?: number
): number {
    const clip = clips[index]
    const nextClip = clips[index + 1]
    const transition = clip?.transition

    if (!clip || !nextClip || !transition || transition.type === 'none' || transition.durationInFrames <= 0) {
        return 0
    }

    const requestedFrames = Math.max(1, Math.floor(transition.durationInFrames / 2))
    const previousFrames = Math.max(0, previousAvailableFrames ?? clip.durationInFrames)
    const nextFrames = Math.max(0, nextClip.durationInFrames)
    const maxSafeFrames = Math.min(requestedFrames, previousFrames - 1, nextFrames - 1)

    return maxSafeFrames > 0 ? maxSafeFrames : 0
}

/**
 * 计算时间轴总时长 (帧数)
 * 考虑转场重叠
 */
export function calculateTimelineDuration(clips: VideoClip[]): number {
    if (clips.length === 0) return 0

    let total = 0

    clips.forEach((clip, index) => {
        total += clip.durationInFrames
        total -= getTransitionOverlapFrames(clips, index, total)
    })

    return Math.max(0, total)
}

/**
 * 计算每个片段的起始帧位置
 * 用于渲染和 UI 显示
 */
export function computeClipPositions(clips: VideoClip[]): ComputedClip[] {
    let currentFrame = 0

    return clips.map((clip, index) => {
        const startFrame = currentFrame
        const endFrame = startFrame + clip.durationInFrames

        // 计算下一个片段的起始位置（考虑转场重叠）
        currentFrame = endFrame - getTransitionOverlapFrames(clips, index, endFrame)

        return {
            ...clip,
            startFrame,
            endFrame
        }
    })
}

/**
 * 帧数转时间字符串
 */
export function framesToTime(frames: number, fps: number): string {
    const totalSeconds = frames / fps
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = Math.floor(totalSeconds % 60)
    const milliseconds = Math.floor((totalSeconds % 1) * 100)

    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(2, '0')}`
}

/**
 * 时间字符串转帧数
 */
export function timeToFrames(time: string, fps: number): number {
    const [minSec, ms] = time.split('.')
    const [minutes, seconds] = minSec.split(':').map(Number)
    const totalSeconds = minutes * 60 + seconds + (parseInt(ms || '0') / 100)
    return Math.round(totalSeconds * fps)
}

/**
 * 生成唯一 ID
 */
export function generateClipId(): string {
    return `clip_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

/**
 * 创建默认编辑器项目
 */
export function createDefaultProject(episodeId: string): VideoEditorProject {
    return {
        id: `editor_${Date.now()}`,
        episodeId,
        schemaVersion: '1.0',
        config: {
            fps: 30,
            width: 1920,
            height: 1080
        },
        timeline: [],
        bgmTrack: []
    }
}
