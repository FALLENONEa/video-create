'use client'
import { logError as _ulogError } from '@/lib/logging/core'
import { useTranslations } from 'next-intl'
import toast, { Toaster } from 'react-hot-toast'

import React, { useEffect, useMemo, useState } from 'react'
import { useEditorState } from '../hooks/useEditorState'
import { useEditorActions } from '../hooks/useEditorActions'
import { VideoEditorProject } from '../types/editor.types'
import { calculateTimelineDuration, computeClipPositions, framesToTime } from '../utils/time-utils'
import { RemotionPreview } from './Preview'
import { Timeline } from './Timeline'

interface VideoEditorStageProps {
    projectId: string
    episodeId: string
    initialProject?: VideoEditorProject
    newClipCount?: number
    onSyncNewClips?: () => void
    isSyncing?: boolean
    onBack?: () => void
}

/**
 * 视频编辑器主页面
 * 
 * 布局:
 * ┌──────────────────────────────────────────────────────────┐
 * │ Toolbar (返回 | 保存 | 导出)                              │
 * ├──────────────┬───────────────────────────────────────────┤
 * │  素材库       │       Preview (Remotion Player)           │
 * │              │                                           │
 * │              ├───────────────────────────────────────────┤
 * │              │       Properties Panel                    │
 * ├──────────────┴───────────────────────────────────────────┤
 * │                      Timeline                            │
 * └──────────────────────────────────────────────────────────┘
 */
export function VideoEditorStage({
    projectId,
    episodeId,
    initialProject,
    newClipCount,
    onSyncNewClips,
    isSyncing,
    onBack
}: VideoEditorStageProps) {
    const t = useTranslations('video')
    const {
        project,
        timelineState,
        isDirty,
        removeClip,
        reorderClips,
        play,
        pause,
        seek,
        selectClip,
        setZoom,
        markSaved
    } = useEditorState({ episodeId, initialProject })

    const { saveProject, startRender, getRenderStatus } = useEditorActions({ projectId, episodeId })

    const [renderStatus, setRenderStatus] = useState<string | null>(null)
    const [outputUrl, setOutputUrl] = useState<string | null>(null)
    const [renderError, setRenderError] = useState<string | null>(null)

    // 初始拉取 + pending/rendering 时轮询渲染状态
    useEffect(() => {
        let cancelled = false
        const poll = async () => {
            try {
                const data = await getRenderStatus()
                if (cancelled) return
                setRenderStatus(data.renderStatus ?? null)
                setOutputUrl(data.outputUrl ?? null)
                setRenderError(data.renderError ?? null)
            } catch {
                // 静默：首次无工程时 404 属正常
            }
        }
        void poll()
        if (renderStatus !== 'pending' && renderStatus !== 'rendering') return
        const timer = setInterval(poll, 3000)
        return () => { cancelled = true; clearInterval(timer) }
    }, [getRenderStatus, renderStatus])

    const totalDuration = calculateTimelineDuration(project.timeline)
    const totalTime = framesToTime(totalDuration, project.config.fps)
    const currentTime = framesToTime(timelineState.currentFrame, project.config.fps)
    const clipPositions = useMemo(() => computeClipPositions(project.timeline), [project.timeline])

    const handleSave = async () => {
        if (!isDirty && renderStatus === 'completed' && outputUrl) return
        try {
            await saveProject(project)
            markSaved()
            setRenderStatus(null)
            setOutputUrl(null)
            setRenderError(null)
            toast.success(t('editor.alert.saveSuccess'))
        } catch (error) {
            _ulogError('Save failed:', error)
            toast.error(t('editor.alert.saveFailed'))
        }
    }

    const handleExport = async () => {
        if (project.timeline.length === 0) {
            toast.error(t('editor.alert.emptyTimeline'))
            return
        }
        try {
            await saveProject(project)
            markSaved()
            await startRender()
            setRenderStatus('pending')
            setOutputUrl(null)
            setRenderError(null)
            toast.success(t('editor.alert.exportStarted'))
        } catch (error) {
            _ulogError('Export failed:', error)
            toast.error(t('editor.alert.exportFailed'))
        }
    }

    // 真正触发浏览器下载文件（而非 window.open 在新标签页里播放）
    const handleDownload = async () => {
        if (!outputUrl) return
        try {
            const res = await fetch(outputUrl)
            if (!res.ok) throw new Error(`status ${res.status}`)
            const blob = await res.blob()
            const blobUrl = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = blobUrl
            a.download = `video-${episodeId}.mp4`
            document.body.appendChild(a)
            a.click()
            a.remove()
            URL.revokeObjectURL(blobUrl)
        } catch {
            // 兜底：CORS / 网络问题时退回新标签打开
            window.open(outputUrl, '_blank')
        }
    }

    const selectedClip = project.timeline.find(c => c.id === timelineState.selectedClipId)

    return (
        <div className="video-editor-stage" style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100vh',
            background: 'var(--glass-bg-canvas)',
            color: 'var(--glass-text-primary)'
        }}>
            {/* Toolbar */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 16px',
                borderBottom: '1px solid var(--glass-stroke-base)',
                background: 'var(--glass-bg-surface)'
            }}>
                <button
                    onClick={onBack}
                    className="glass-btn-base glass-btn-secondary px-4 py-2"
                >
                    {t('editor.toolbar.back')}
                </button>

                <div style={{ flex: 1 }} />

                <span style={{ color: 'var(--glass-text-secondary)', fontSize: '14px' }}>
                    {currentTime} / {totalTime}
                </span>

                {onSyncNewClips ? (
                    <button
                        onClick={onSyncNewClips}
                        disabled={isSyncing}
                        className="glass-btn-base glass-btn-secondary px-4 py-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        title={t('editor.toolbar.syncHint')}
                    >
                        {isSyncing
                            ? t('editor.toolbar.syncing')
                            : newClipCount && newClipCount > 0
                                ? t('editor.toolbar.syncNew', { count: newClipCount })
                                : t('editor.toolbar.syncLatest')}
                    </button>
                ) : null}

                <button
                    onClick={handleSave}
                    className={`glass-btn-base px-4 py-2 ${isDirty ? 'glass-btn-primary text-white' : 'glass-btn-secondary'}`}
                >
                    {isDirty ? t('editor.toolbar.saveDirty') : t('editor.toolbar.saved')}
                </button>

                {renderStatus === 'completed' && outputUrl && !isDirty ? (
                    <button
                        onClick={handleDownload}
                        className="glass-btn-base glass-btn-tone-success px-4 py-2"
                    >
                        {t('editor.toolbar.download')}
                    </button>
                ) : renderStatus === 'failed' ? (
                    <button
                        onClick={handleExport}
                        className="glass-btn-base glass-btn-tone-danger px-4 py-2"
                    >
                        {t('editor.toolbar.reexport')}
                    </button>
                ) : (
                    <button
                        onClick={handleExport}
                        disabled={renderStatus === 'pending' || renderStatus === 'rendering' || project.timeline.length === 0}
                        className="glass-btn-base glass-btn-tone-success px-4 py-2"
                    >
                        {(renderStatus === 'pending' || renderStatus === 'rendering')
                            ? t('editor.toolbar.rendering')
                            : t('editor.toolbar.export')}
                    </button>
                )}
            </div>

            {/* 渲染状态条：让 pending/rendering/failed 都对用户可见，不再"干等" */}
            {renderStatus && renderStatus !== 'completed' && (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '8px 16px',
                    fontSize: '13px',
                    borderBottom: '1px solid var(--glass-stroke-base)',
                    background: renderStatus === 'failed' ? 'rgba(229, 72, 77, 0.10)' : 'var(--glass-bg-surface)',
                    color: renderStatus === 'failed' ? '#e5484d' : 'var(--glass-text-secondary)'
                }}>
                    {renderStatus === 'failed'
                        ? <span>⚠ {t('editor.alert.renderFailed')}{renderError ? `：${renderError}` : ''}</span>
                        : <span>⏳ {t('editor.toolbar.rendering')}</span>}
                </div>
            )}

            {/* Main Content */}
            <div style={{
                display: 'flex',
                flex: 1,
                overflow: 'hidden'
            }}>
                {/* Left Panel - Current clips */}
                <div style={{
                    width: '200px',
                    borderRight: '1px solid var(--glass-stroke-base)',
                    padding: '12px',
                    background: 'var(--glass-bg-surface-strong)',
                    overflowY: 'auto'
                }}>
                    <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', color: 'var(--glass-text-secondary)' }}>
                        {t('editor.left.title')}
                    </h3>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {clipPositions.map((clip, index) => (
                            <button
                                key={clip.id}
                                onClick={() => {
                                    selectClip(clip.id)
                                    seek(clip.startFrame)
                                }}
                                style={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'stretch',
                                    gap: '4px',
                                    padding: '8px',
                                    borderRadius: '6px',
                                    border: timelineState.selectedClipId === clip.id
                                        ? '1px solid var(--glass-stroke-focus)'
                                        : '1px solid var(--glass-stroke-base)',
                                    background: timelineState.selectedClipId === clip.id
                                        ? 'var(--glass-tone-info-bg)'
                                        : 'var(--glass-bg-surface)',
                                    color: 'var(--glass-text-primary)',
                                    cursor: 'pointer',
                                    textAlign: 'left'
                                }}
                            >
                                <span style={{ fontSize: '12px', fontWeight: 600 }}>
                                    {t('editor.right.clipFallback', { index: index + 1 })}
                                </span>
                                <span style={{ fontSize: '11px', color: 'var(--glass-text-secondary)' }}>
                                    {framesToTime(clip.durationInFrames, project.config.fps)}
                                </span>
                                {clip.metadata?.description && (
                                    <span
                                        style={{
                                            fontSize: '11px',
                                            color: 'var(--glass-text-tertiary)',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap'
                                        }}
                                    >
                                        {clip.metadata.description}
                                    </span>
                                )}
                            </button>
                        ))}
                        {clipPositions.length === 0 && (
                            <p style={{ fontSize: '12px', color: 'var(--glass-text-tertiary)' }}>
                                {t('editor.left.description')}
                            </p>
                        )}
                    </div>
                </div>

                {/* Center - Preview + Properties */}
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                    {/* Preview */}
                    <div style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'var(--glass-bg-muted)',
                        padding: '20px'
                    }}>
                        <RemotionPreview
                            project={project}
                            currentFrame={timelineState.currentFrame}
                            playing={timelineState.playing}
                            onFrameChange={seek}
                            onPlayingChange={(playing) => playing ? play() : pause()}
                        />
                    </div>
                </div>

                {/* Right Panel - Properties */}
                <div style={{
                    width: '280px',
                    borderLeft: '1px solid var(--glass-stroke-base)',
                    padding: '12px',
                    background: 'var(--glass-bg-surface-strong)',
                    overflowY: 'auto'
                }}>
                    <h3 style={{ margin: '0 0 12px 0', fontSize: '14px', color: 'var(--glass-text-secondary)' }}>
                        {t('editor.right.title')}
                    </h3>
                    {selectedClip ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            {/* 基础信息 */}
                            <div style={{ fontSize: '12px' }}>
                                <p style={{ margin: '0 0 8px 0' }}>
                                    <span style={{ color: 'var(--glass-text-secondary)' }}>{t('editor.right.clipLabel')}</span> {selectedClip.metadata?.description || t('editor.right.clipFallback', { index: project.timeline.findIndex(c => c.id === selectedClip.id) + 1 })}
                                </p>
                                <p style={{ margin: '0 0 8px 0' }}>
                                    <span style={{ color: 'var(--glass-text-secondary)' }}>{t('editor.right.durationLabel')}</span> {framesToTime(selectedClip.durationInFrames, project.config.fps)}
                                </p>
                            </div>

                            {/* 删除按钮 */}
                            <button
                                onClick={() => {
                                    if (confirm(t('editor.right.deleteConfirm'))) {
                                        removeClip(selectedClip.id)
                                        selectClip(null)
                                    }
                                }}
                                className="glass-btn-base glass-btn-tone-danger mt-2 px-3 py-2 text-xs"
                            >
                                {t('editor.right.deleteClip')}
                            </button>
                        </div>
                    ) : (
                        <p style={{ fontSize: '12px', color: 'var(--glass-text-tertiary)' }}>
                            {t('editor.right.selectClipHint')}
                        </p>
                    )}
                </div>
            </div>

            {/* Timeline */}
            <div style={{
                height: '220px',
                borderTop: '1px solid var(--glass-stroke-base)'
            }}>
                <Timeline
                    clips={project.timeline}
                    timelineState={timelineState}
                    config={project.config}
                    onReorder={reorderClips}
                    onSelectClip={selectClip}
                    onZoomChange={setZoom}
                    onSeek={seek}
                />
            </div>

            <Toaster position="top-center" />
        </div>
    )
}

export default VideoEditorStage
