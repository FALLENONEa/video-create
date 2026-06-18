'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  VideoGenerationOptions,
  VideoModelOption,
  VideoPanel,
} from '@/app/[locale]/workspace/[projectId]/modes/novel-promotion/components/video'
import type { CapabilitySelections, CapabilityValue } from '@/lib/model-config-contract'
import {
  normalizeVideoGenerationSelections,
  resolveEffectiveVideoCapabilityDefinitions,
  resolveEffectiveVideoCapabilityFields,
} from '@/lib/model-capabilities/video-effective'
import { supportsFirstLastFrame } from '@/lib/model-capabilities/video-model-options'
import { projectVideoPricingTiersByFixedSelections } from '@/lib/model-pricing/video-tier'

interface FirstLastFrameCapabilityField {
  field: string
  label: string
  options: VideoGenerationOptionValue[]
  disabledOptions?: VideoGenerationOptionValue[]
  value: VideoGenerationOptionValue | undefined
}

type VideoGenerationOptionValue = string | number | boolean

function parseByOptionType(
  input: string,
  sample: VideoGenerationOptionValue,
): VideoGenerationOptionValue {
  if (typeof sample === 'number') return Number(input)
  if (typeof sample === 'boolean') return input === 'true'
  return input
}

function readFlSelectionForModel(
  capabilityOverrides: CapabilitySelections | undefined,
  modelKey: string,
): VideoGenerationOptions {
  if (!modelKey || !capabilityOverrides) return {}
  const raw = capabilityOverrides[modelKey]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const selection: VideoGenerationOptions = {}
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (field === 'aspectRatio') continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      selection[field] = value
    }
  }
  return selection
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toFieldLabel(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase())
}

interface UseVideoFirstLastFrameFlowParams {
  allPanels: VideoPanel[]
  linkedPanels: Map<string, boolean>
  videoModelOptions: VideoModelOption[]
  capabilityOverrides?: CapabilitySelections
  onCapabilityOverridesChange?: (value: CapabilitySelections) => void | Promise<void>
  onGenerateVideo: (
    storyboardId: string,
    panelIndex: number,
    videoModel?: string,
    firstLastFrame?: {
      lastFrameStoryboardId: string
      lastFramePanelIndex: number
      flModel: string
      customPrompt?: string
    },
    generationOptions?: VideoGenerationOptions,
    panelId?: string,
  ) => Promise<void>
  t: (key: string) => string
}

export function useVideoFirstLastFrameFlow({
  allPanels,
  linkedPanels,
  videoModelOptions,
  capabilityOverrides,
  onCapabilityOverridesChange,
  onGenerateVideo,
  t,
}: UseVideoFirstLastFrameFlowParams) {
  const firstLastFrameModelOptions = useMemo(
    () => videoModelOptions.filter((option) => supportsFirstLastFrame(option)),
    [videoModelOptions],
  )
  const [flModel, setFlModel] = useState(firstLastFrameModelOptions[0]?.value || '')
  const prevFlModelRef = useRef(flModel)
  // 标记用户是否手动改过首尾帧选项；项目级 capabilityOverrides 异步到位时若尚未 touched，则回填 DB 值
  const userTouchedRef = useRef(false)
  const [flGenerationOptions, setFlGenerationOptions] = useState<VideoGenerationOptions>(() =>
    readFlSelectionForModel(capabilityOverrides, flModel),
  )
  const [flCustomPrompts, setFlCustomPrompts] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    setFlCustomPrompts((previous) => {
      const next = new Map(previous)
      const existingPanelKeys = new Set<string>()

      for (const panel of allPanels) {
        const panelKey = `${panel.storyboardId}-${panel.panelIndex}`
        existingPanelKeys.add(panelKey)
        if (!next.has(panelKey)) {
          next.set(panelKey, panel.firstLastFramePrompt || '')
        }
      }

      for (const key of next.keys()) {
        if (!existingPanelKeys.has(key)) next.delete(key)
      }

      return next
    })
  }, [allPanels])

  useEffect(() => {
    if (!flModel && firstLastFrameModelOptions.length > 0) {
      setFlModel(firstLastFrameModelOptions[0].value)
      return
    }
    if (flModel && !firstLastFrameModelOptions.some((option) => option.value === flModel)) {
      setFlModel(firstLastFrameModelOptions[0]?.value || '')
    }
  }, [firstLastFrameModelOptions, flModel])

  const selectedFlModelOption = useMemo(
    () => firstLastFrameModelOptions.find((option) => option.value === flModel),
    [firstLastFrameModelOptions, flModel],
  )
  const flPricingTiers = useMemo(
    () => projectVideoPricingTiersByFixedSelections({
      tiers: selectedFlModelOption?.videoPricingTiers ?? [],
      fixedSelections: {
        generationMode: 'firstlastframe',
      },
    }),
    [selectedFlModelOption?.videoPricingTiers],
  )
  const flCapabilityDefinitions = useMemo(
    () => resolveEffectiveVideoCapabilityDefinitions({
      videoCapabilities: selectedFlModelOption?.capabilities?.video,
      pricingTiers: flPricingTiers,
    }),
    [flPricingTiers, selectedFlModelOption?.capabilities?.video],
  )

  useEffect(() => {
    // 切 flModel → 用新模型的项目级默认重置并清 touched；
    // 项目级 capabilityOverrides 异步到位 → 用户尚未手动改过时回填 DB 值
    //   （否则首挂载时 overrides 为空留下的默认值会一直留着，项目级 duration=10 永远进不来，
    //   首尾帧视频时长停在默认 5）；
    // 用户已手动改过 → 保留 local，避免被异步刷新 / 项目级回写覆盖。
    const modelChanged = prevFlModelRef.current !== flModel
    prevFlModelRef.current = flModel
    if (modelChanged) userTouchedRef.current = false
    const useDB = modelChanged || !userTouchedRef.current
    const dbSelection = readFlSelectionForModel(capabilityOverrides, flModel)
    setFlGenerationOptions((previous) => normalizeVideoGenerationSelections({
      definitions: flCapabilityDefinitions,
      pricingTiers: flPricingTiers,
      selection: useDB ? dbSelection : previous,
    }))
  }, [flCapabilityDefinitions, flPricingTiers, flModel, capabilityOverrides])

  const flEffectiveCapabilityFields = useMemo(
    () => resolveEffectiveVideoCapabilityFields({
      definitions: flCapabilityDefinitions,
      pricingTiers: flPricingTiers,
      selection: flGenerationOptions,
    }),
    [flCapabilityDefinitions, flGenerationOptions, flPricingTiers],
  )
  const flEffectiveFieldMap = useMemo(
    () => new Map(flEffectiveCapabilityFields.map((field) => [field.field, field])),
    [flEffectiveCapabilityFields],
  )
  const flDefinitionFieldMap = useMemo(
    () => new Map(flCapabilityDefinitions.map((definition) => [definition.field, definition])),
    [flCapabilityDefinitions],
  )

  const flCapabilityFields: FirstLastFrameCapabilityField[] = useMemo(() => {
    return flCapabilityDefinitions.map((definition) => {
      const effectiveField = flEffectiveFieldMap.get(definition.field)
      const enabledOptions = effectiveField?.options ?? []
      return {
        field: definition.field,
        label: toFieldLabel(definition.field),
        options: definition.options as VideoGenerationOptionValue[],
        disabledOptions: (definition.options as VideoGenerationOptionValue[])
          .filter((option) => !enabledOptions.includes(option)),
        value: effectiveField?.value as VideoGenerationOptionValue | undefined,
      }
    })
  }, [flCapabilityDefinitions, flEffectiveFieldMap])

  const flMissingCapabilityFields = useMemo(
    () => flEffectiveCapabilityFields
      .filter((field) => field.options.length === 0 || field.value === undefined)
      .map((field) => field.field),
    [flEffectiveCapabilityFields],
  )

  const setFlCapabilityValue = useCallback((field: string, rawValue: string) => {
    const definitionField = flDefinitionFieldMap.get(field)
    if (!definitionField || definitionField.options.length === 0) return
    const parsedValue = parseByOptionType(rawValue, definitionField.options[0])
    if (!definitionField.options.includes(parsedValue)) return
    userTouchedRef.current = true
    setFlGenerationOptions((previous) => ({
      ...normalizeVideoGenerationSelections({
        definitions: flCapabilityDefinitions,
        pricingTiers: flPricingTiers,
        selection: {
          ...previous,
          [field]: parsedValue,
        },
        pinnedFields: [field],
      }),
    }))
    // 回写到项目级 capabilityOverrides，使其持久化并成为该模型的项目默认（与单图面板一致）
    if (onCapabilityOverridesChange && flModel) {
      const nextOverrides: CapabilitySelections = { ...(capabilityOverrides || {}) }
      const current = isRecord(nextOverrides[flModel])
        ? { ...(nextOverrides[flModel] as Record<string, CapabilityValue>) }
        : {}
      current[field] = parsedValue
      nextOverrides[flModel] = current
      void onCapabilityOverridesChange(nextOverrides)
    }
  }, [flCapabilityDefinitions, flDefinitionFieldMap, flPricingTiers, flModel, capabilityOverrides, onCapabilityOverridesChange])

  const setFlCustomPrompt = useCallback((panelKey: string, value: string) => {
    setFlCustomPrompts((previous) => new Map(previous).set(panelKey, value))
  }, [])

  const resetFlCustomPrompt = useCallback((panelKey: string) => {
    setFlCustomPrompts((previous) => {
      const next = new Map(previous)
      next.delete(panelKey)
      return next
    })
  }, [])

  const handleGenerateFirstLastFrame = useCallback(async (
    firstStoryboardId: string,
    firstPanelIndex: number,
    lastStoryboardId: string,
    lastPanelIndex: number,
    panelKey: string,
    generationOptions?: VideoGenerationOptions,
    firstPanelId?: string,
  ) => {
    const persistedCustomPrompt = allPanels.find(
      (panel) =>
        panel.storyboardId === firstStoryboardId
        && panel.panelIndex === firstPanelIndex,
    )?.firstLastFramePrompt
    const customPrompt = flCustomPrompts.get(panelKey) ?? persistedCustomPrompt
    await onGenerateVideo(firstStoryboardId, firstPanelIndex, flModel, {
      lastFrameStoryboardId: lastStoryboardId,
      lastFramePanelIndex: lastPanelIndex,
      flModel,
      customPrompt,
    }, generationOptions ?? flGenerationOptions, firstPanelId)
  }, [allPanels, flCustomPrompts, flGenerationOptions, flModel, onGenerateVideo])

  const getDefaultFlPrompt = useCallback((firstPrompt?: string, lastPrompt?: string): string => {
    const first = firstPrompt || ''
    const last = lastPrompt || ''
    if (last) {
      return `${first} ${t('firstLastFrame.thenTransitionTo')}: ${last}`
    }
    return first
  }, [t])

  const getNextPanel = useCallback((currentIndex: number): VideoPanel | null => {
    if (currentIndex >= allPanels.length - 1) return null
    return allPanels[currentIndex + 1]
  }, [allPanels])

  const isLinkedAsLastFrame = useCallback((currentIndex: number): boolean => {
    if (currentIndex === 0) return false
    const previousPanel = allPanels[currentIndex - 1]
    const previousKey = `${previousPanel.storyboardId}-${previousPanel.panelIndex}`
    return linkedPanels.get(previousKey) || false
  }, [allPanels, linkedPanels])

  return {
    flModel,
    flModelOptions: firstLastFrameModelOptions,
    flGenerationOptions,
    flCapabilityFields,
    flMissingCapabilityFields,
    flCustomPrompts,
    setFlModel,
    setFlCapabilityValue,
    setFlCustomPrompt,
    resetFlCustomPrompt,
    handleGenerateFirstLastFrame,
    getDefaultFlPrompt,
    getNextPanel,
    isLinkedAsLastFrame,
  }
}
