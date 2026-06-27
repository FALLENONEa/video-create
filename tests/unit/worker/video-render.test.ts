import type { Job } from 'bullmq'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TASK_TYPE, type TaskJobData } from '@/lib/task/types'

const cleanupMock = vi.hoisted(() => vi.fn(async () => undefined))
const composeMock = vi.hoisted(() => ({
  renderEditorProject: vi.fn(async () => ({
    outputPath: '/tmp/waoowaoo-render-test/output.mp4',
    cleanup: cleanupMock,
  })),
}))
const sharedMock = vi.hoisted(() => ({
  reportTaskProgress: vi.fn(async () => undefined),
  assertTaskActive: vi.fn(async () => undefined),
}))
const utilsMock = vi.hoisted(() => ({
  assertTaskActive: vi.fn(async () => undefined),
  toSignedUrlIfCos: vi.fn((url: string | null) => (url ? `https://signed.example/${url}` : null)),
  uploadVideoSourceToCos: vi.fn(async () => 'cos/video-render/out.mp4'),
}))
const isTaskActiveMock = vi.hoisted(() => vi.fn(async () => true))
const prismaMock = vi.hoisted(() => ({
  videoEditorProject: {
    findUnique: vi.fn(),
    update: vi.fn(async () => undefined),
  },
}))
const fsMock = vi.hoisted(() => ({ readFile: vi.fn(async () => Buffer.from('fake-mp4')) }))

vi.mock('@/lib/video-editor/compose', () => ({ renderEditorProject: composeMock.renderEditorProject }))
vi.mock('@/lib/workers/shared', () => ({
  reportTaskProgress: sharedMock.reportTaskProgress,
  assertTaskActive: sharedMock.assertTaskActive,
}))
vi.mock('@/lib/workers/utils', () => ({
  assertTaskActive: utilsMock.assertTaskActive,
  toSignedUrlIfCos: utilsMock.toSignedUrlIfCos,
  uploadVideoSourceToCos: utilsMock.uploadVideoSourceToCos,
}))
vi.mock('@/lib/task/service', () => ({ isTaskActive: isTaskActiveMock }))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('node:fs/promises', () => ({ readFile: fsMock.readFile }))

const { handleVideoRenderTask } = await import('@/lib/workers/handlers/video-render')

function makeJob(overrides?: Partial<TaskJobData>): Job<TaskJobData> {
  return {
    data: {
      taskId: 'task-1',
      type: TASK_TYPE.VIDEO_RENDER,
      locale: 'zh',
      projectId: 'proj-1',
      episodeId: 'ep-1',
      targetType: 'VideoEditorProject',
      targetId: 'vep-1',
      payload: { editorProjectId: 'vep-1' },
      userId: 'user-1',
      ...overrides,
    },
  } as unknown as Job<TaskJobData>
}

function lastUpdateData(): Record<string, unknown> {
  const calls = prismaMock.videoEditorProject.update.mock.calls as unknown as Array<unknown[]>
  const arg = calls[calls.length - 1]?.[0] as { data: Record<string, unknown> } | undefined
  return arg?.data ?? {}
}

describe('video-render handler (TASK_TYPE.VIDEO_RENDER)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.videoEditorProject.findUnique.mockResolvedValue({
      id: 'vep-1',
      episodeId: 'ep-1',
      projectData: JSON.stringify({
        config: { fps: 30, width: 1920, height: 1080 },
        timeline: [
          {
            id: 'c1',
            src: 'cos/clips/c1.mp4',
            durationInFrames: 90,
            metadata: { panelId: 'p1', storyboardId: 's1' },
          },
        ],
        bgmTrack: [],
      }),
    })
  })

  it('renders, uploads and writes back completed + outputUrl', async () => {
    const result = await handleVideoRenderTask(makeJob())

    expect(composeMock.renderEditorProject).toHaveBeenCalledTimes(1)
    expect(utilsMock.toSignedUrlIfCos).toHaveBeenCalled()
    expect(utilsMock.uploadVideoSourceToCos).toHaveBeenCalledWith(
      expect.any(Buffer),
      'video-render',
      'vep-1',
    )
    expect(lastUpdateData()).toMatchObject({
      renderStatus: 'completed',
      outputUrl: 'cos/video-render/out.mp4',
    })
    expect(cleanupMock).toHaveBeenCalled()
    expect(result).toMatchObject({ editorProjectId: 'vep-1', outputUrl: 'cos/video-render/out.mp4' })
  })

  it('marks renderStatus failed when render throws', async () => {
    composeMock.renderEditorProject.mockRejectedValueOnce(new Error('render boom'))
    await expect(handleVideoRenderTask(makeJob())).rejects.toThrow('render boom')
    expect(lastUpdateData()).toMatchObject({ renderStatus: 'failed' })
  })

  it('throws VIDEO_RENDER_NO_PROJECT when editorProjectId missing', async () => {
    await expect(
      handleVideoRenderTask(makeJob({ targetType: 'Other', targetId: 'x', payload: {} })),
    ).rejects.toThrow(/editorProjectId/)
  })

  it('throws when project not found', async () => {
    prismaMock.videoEditorProject.findUnique.mockResolvedValueOnce(null)
    await expect(handleVideoRenderTask(makeJob())).rejects.toThrow(/PROJECT_NOT_FOUND/)
  })
})
