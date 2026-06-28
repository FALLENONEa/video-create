// ========================================
// Video Editor Module - Public API
// ========================================

// Types
export type {
    VideoEditorProject,
    VideoClip,
    BgmClip,
    ClipAttachment,
    ClipTransition,
    ClipMetadata,
    EditorConfig,
    TimelineState,
    ComputedClip,
    SaveEditorProjectRequest,
    RenderRequest,
    RenderStatus
} from './types/editor.types'

// Utils
export {
    calculateTimelineDuration,
    computeClipPositions,
    framesToTime,
    timeToFrames,
    generateClipId,
    createDefaultProject
} from './utils/time-utils'

// Components
export { VideoEditorStage } from './components/VideoEditorStage'

// Hooks
export { useEditorState } from './hooks/useEditorState'
export { useEditorActions, createProjectFromPanels } from './hooks/useEditorActions'
