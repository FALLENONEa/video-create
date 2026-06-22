import { describe, expect, it } from 'vitest'
import {
  type CapabilitySelections,
  type ModelCapabilities,
  type UnifiedModelType,
} from '@/lib/model-config-contract'
import { resolveGenerationOptionsForModel } from '@/lib/model-capabilities/lookup'

describe('model-capabilities/lookup - video fps defaulting', () => {
  const modelType: UnifiedModelType = 'video'
  const modelKey = 'zhipu::cogvideox-3'

  const capabilities: ModelCapabilities = {
    video: {
      generationModeOptions: ['normal', 'firstlastframe'],
      durationOptions: [5, 10],
      fpsOptions: [30, 60],
      resolutionOptions: ['1920x1080', '1080x1920'],
      qualityOptions: ['speed', 'quality'],
      watermarkOptions: [true, false],
    },
  }

  it('auto-fills fps with first option when missing but other fields configured', () => {
    // 回归场景：存量配置里其他字段齐全，唯独缺新加的 fps
    // （cogvideox-3 在 fpsOptions 加入之前就已配置过，复现部署后 CAPABILITY_REQUIRED 报错）
    const capabilityDefaults: CapabilitySelections = {
      [modelKey]: {
        generationMode: 'normal',
        duration: 5,
        resolution: '1920x1080',
        quality: 'speed',
        watermark: false,
      },
    }

    const result = resolveGenerationOptionsForModel({
      modelType,
      modelKey,
      capabilities,
      capabilityDefaults,
      requireAllFields: true,
    })

    expect(result.issues).toEqual([])
    expect(result.options.fps).toBe(30)
    expect(result.options.resolution).toBe('1920x1080')
  })

  it('does not override user-provided fps', () => {
    const capabilityDefaults: CapabilitySelections = {
      [modelKey]: {
        fps: 60,
        generationMode: 'normal',
        duration: 5,
        resolution: '1920x1080',
        quality: 'speed',
        watermark: false,
      },
    }

    const result = resolveGenerationOptionsForModel({
      modelType,
      modelKey,
      capabilities,
      capabilityDefaults,
      requireAllFields: true,
    })

    expect(result.issues).toEqual([])
    expect(result.options.fps).toBe(60)
  })
})
