'use client'

import React, { useMemo, useRef, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { Player, PlayerRef } from '@remotion/player'
import { AppIcon } from '@/components/ui/icons'
import { VideoComposition } from '../../remotion/VideoComposition'
import { VideoEditorProject } from '../../types/editor.types'
import { calculateTimelineDuration } from '../../utils/time-utils'

interface RemotionPreviewProps {
    project: VideoEditorProject
    currentFrame: number
    playing: boolean
    onFrameChange?: (frame: number) => void
    onPlayingChange?: (playing: boolean) => void
}

/**
 * Remotion Player 预览封装
 * 支持双向同步：timelineState ↔ Player
 */
export const RemotionPreview: React.FC<RemotionPreviewProps> = ({
    project,
    currentFrame,
    playing,
    onFrameChange,
    onPlayingChange
}) => {
    const t = useTranslations('video')
    const playerRef = useRef<PlayerRef>(null)
    const lastSyncedFrame = useRef<number>(0)

    const totalDuration = useMemo(
        () => calculateTimelineDuration(project.timeline),
        [project.timeline]
    )

    // 当 currentFrame 从外部改变时，同步到 Player
    useEffect(() => {
        const player = playerRef.current
        if (!player) return
        if (playing) return

        // 避免循环更新：只有当帧差距大于 1 时才 seek
        const nextFrame = Math.max(0, Math.min(currentFrame, Math.max(0, totalDuration - 1)))
        if (Math.abs(nextFrame - lastSyncedFrame.current) > 1) {
            player.seekTo(nextFrame)
            lastSyncedFrame.current = nextFrame
        }
    }, [currentFrame, playing, totalDuration])

    // 当 playing 状态改变时，控制 Player 播放/暂停
    useEffect(() => {
        const player = playerRef.current
        if (!player) return

        if (playing) {
            player.play()
        } else {
            player.pause()
        }
    }, [playing])

    // 监听 Player 的帧变化，同步到 timelineState
    useEffect(() => {
        const player = playerRef.current
        if (!player) return

        const handleFrameUpdate = () => {
            const frame = player.getCurrentFrame()
            lastSyncedFrame.current = frame
            onFrameChange?.(frame)
        }

        // Remotion Player 触发 timeupdate 事件
        player.addEventListener('frameupdate', handleFrameUpdate)

        return () => {
            player.removeEventListener('frameupdate', handleFrameUpdate)
        }
    }, [onFrameChange])

    // 监听 Player 播放状态变化
    useEffect(() => {
        const player = playerRef.current
        if (!player) return

        const handlePlay = () => onPlayingChange?.(true)
        const handlePause = () => onPlayingChange?.(false)
        const handleEnded = () => onPlayingChange?.(false)

        player.addEventListener('play', handlePlay)
        player.addEventListener('pause', handlePause)
        player.addEventListener('ended', handleEnded)

        return () => {
            player.removeEventListener('play', handlePlay)
            player.removeEventListener('pause', handlePause)
            player.removeEventListener('ended', handleEnded)
        }
    }, [onPlayingChange])

    // 如果没有片段，显示占位
    if (project.timeline.length === 0) {
        return (
            <div style={{
                width: '100%',
                aspectRatio: `${project.config.width} / ${project.config.height}`,
                maxHeight: '100%',
                background: 'var(--glass-bg-surface)',
                border: '1px solid var(--glass-stroke-base)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '8px',
                color: 'var(--glass-text-tertiary)'
            }}>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ marginBottom: '12px', display: 'flex', justifyContent: 'center' }}>
                        <AppIcon name="image" className="w-12 h-12" />
                    </div>
                    <span>{t('editor.preview.emptyStartEditing')}</span>
                </div>
            </div>
        )
    }

    return (
        <div style={{
            position: 'relative',
            width: '100%',
            aspectRatio: `${project.config.width} / ${project.config.height}`,
            maxHeight: '100%',
            background: 'var(--glass-overlay-strong)',
            borderRadius: '8px',
            overflow: 'hidden',
            cursor: 'pointer'
        }}>
            <Player
                ref={playerRef}
                component={VideoComposition}
                inputProps={{
                    clips: project.timeline,
                    bgmTrack: project.bgmTrack,
                    config: project.config
                }}
                durationInFrames={Math.max(1, totalDuration)}
                fps={project.config.fps}
                compositionWidth={project.config.width}
                compositionHeight={project.config.height}
                style={{
                    width: '100%',
                    height: '100%'
                }}
                controls={false}
                loop={false}
                // 点画面播放：clickToPlay 在用户手势同步栈内触发 play，可绕过浏览器 autoplay 限制
                clickToPlay
            />
            {!playing && (
                <div style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'none'
                }}>
                    <div style={{
                        width: '72px',
                        height: '72px',
                        borderRadius: '50%',
                        background: 'rgba(0, 0, 0, 0.55)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}>
                        <AppIcon name="play" className="w-8 h-8 text-white" />
                    </div>
                </div>
            )}
        </div>
    )
}

export default RemotionPreview
