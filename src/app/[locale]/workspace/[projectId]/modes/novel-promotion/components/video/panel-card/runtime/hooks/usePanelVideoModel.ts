import { useEffect, useMemo, useRef, useState } from 'react'
import type { VideoModelOption, VideoGenerationOptionValue, VideoGenerationOptions } from '../../../types'
import type { CapabilitySelections, CapabilityValue } from '@/lib/model-config-contract'
import {
  normalizeVideoGenerationSelections,
  resolveEffectiveVideoCapabilityDefinitions,
  resolveEffectiveVideoCapabilityFields,
} from '@/lib/model-capabilities/video-effective'
import { projectVideoPricingTiersByFixedSelections } from '@/lib/model-pricing/video-tier'

interface UsePanelVideoModelParams {
  defaultVideoModel: string
  capabilityOverrides?: CapabilitySelections
  userVideoModels?: VideoModelOption[]
  onCapabilityOverridesChange?: (value: CapabilitySelections) => void
}

interface CapabilityField {
  field: string
  label: string
  labelKey?: string
  unitKey?: string
  optionLabelKeys?: Record<string, string>
  options: VideoGenerationOptionValue[]
  disabledOptions?: VideoGenerationOptionValue[]
  value: VideoGenerationOptionValue | undefined
}

function toFieldLabel(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').replace(/^./, (char) => char.toUpperCase())
}

function parseByOptionType(
  input: string,
  sample: VideoGenerationOptionValue,
): VideoGenerationOptionValue {
  if (typeof sample === 'number') return Number(input)
  if (typeof sample === 'boolean') return input === 'true'
  return input
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isGenerationOptionValue(value: unknown): value is VideoGenerationOptionValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function readSelectionForModel(
  capabilityOverrides: CapabilitySelections | undefined,
  modelKey: string,
): VideoGenerationOptions {
  if (!modelKey || !capabilityOverrides) return {}
  const rawSelection = capabilityOverrides[modelKey]
  if (!isRecord(rawSelection)) return {}

  const selection: VideoGenerationOptions = {}
  for (const [field, value] of Object.entries(rawSelection)) {
    if (field === 'aspectRatio') continue
    if (!isGenerationOptionValue(value)) continue
    selection[field] = value
  }
  return selection
}

export function usePanelVideoModel({
  defaultVideoModel,
  capabilityOverrides,
  userVideoModels,
  onCapabilityOverridesChange,
}: UsePanelVideoModelParams) {
  const [selectedModel, setSelectedModel] = useState(defaultVideoModel || '')
  const prevSelectedModelRef = useRef(selectedModel)
  // 用户是否已手动改过当前模型的 local 选项。capabilityOverrides 异步加载到位时若尚未 touched，
  // 用 DB 值回填 generationOptions（否则首挂载 overrides 为空留下的默认值会一直留着，DB 的值进不来）。
  const userTouchedRef = useRef(false)
  const [generationOptions, setGenerationOptions] = useState<VideoGenerationOptions>(() =>
    readSelectionForModel(capabilityOverrides, defaultVideoModel || ''),
  )
  const videoModelOptions = userVideoModels ?? []
  const selectedOption = videoModelOptions.find((option) => option.value === selectedModel)
  const pricingTiers = useMemo(
    () => projectVideoPricingTiersByFixedSelections({
      tiers: selectedOption?.videoPricingTiers ?? [],
      fixedSelections: {
        generationMode: 'normal',
      },
    }),
    [selectedOption?.videoPricingTiers],
  )

  useEffect(() => {
    setSelectedModel(defaultVideoModel || '')
  }, [defaultVideoModel])

  useEffect(() => {
    if (!selectedModel) {
      if (videoModelOptions.length > 0) {
        setSelectedModel(videoModelOptions[0].value)
      }
      return
    }
    if (videoModelOptions.some((option) => option.value === selectedModel)) return
    setSelectedModel(videoModelOptions[0]?.value || '')
  }, [selectedModel, videoModelOptions])

  const capabilityDefinitions = useMemo(
    () => resolveEffectiveVideoCapabilityDefinitions({
      videoCapabilities: selectedOption?.capabilities?.video,
      pricingTiers,
    }),
    [pricingTiers, selectedOption?.capabilities?.video],
  )

  const selectedModelOverrides = useMemo(
    () => readSelectionForModel(capabilityOverrides, selectedModel),
    [capabilityOverrides, selectedModel],
  )
  const selectedModelOverridesSignature = useMemo(
    () => JSON.stringify(selectedModelOverrides),
    [selectedModelOverrides],
  )

  useEffect(() => {
    // 切模型 → 用新模型的 DB 默认重置，并清 touched；
    // DB 配置（capabilityOverrides）异步加载到位 → 用户尚未手动改过时回填 DB 值
    //   （否则首挂载 overrides 为空留下的默认 5 会一直留着，DB 的 10 进不来 → 出 5s 视频）；
    // 用户已手动改过 → 保留 local，避免被异步刷新 / DB 回写覆盖。
    const modelChanged = prevSelectedModelRef.current !== selectedModel
    prevSelectedModelRef.current = selectedModel
    if (modelChanged) userTouchedRef.current = false
    const useDB = modelChanged || !userTouchedRef.current
    setGenerationOptions((previous) => normalizeVideoGenerationSelections({
      definitions: capabilityDefinitions,
      pricingTiers,
      selection: useDB ? selectedModelOverrides : previous,
    }))
  }, [selectedModel, selectedModelOverridesSignature, capabilityDefinitions, pricingTiers, selectedModelOverrides])

  useEffect(() => {
    setGenerationOptions((previous) => normalizeVideoGenerationSelections({
      definitions: capabilityDefinitions,
      pricingTiers,
      selection: previous,
    }))
  }, [capabilityDefinitions, pricingTiers])

  const effectiveFields = useMemo(
    () => resolveEffectiveVideoCapabilityFields({
      definitions: capabilityDefinitions,
      pricingTiers,
      selection: generationOptions,
    }),
    [capabilityDefinitions, generationOptions, pricingTiers],
  )
  const missingCapabilityFields = useMemo(
    () => effectiveFields
      .filter((field) => field.options.length === 0 || field.value === undefined)
      .map((field) => field.field),
    [effectiveFields],
  )
  const effectiveFieldMap = useMemo(
    () => new Map(effectiveFields.map((field) => [field.field, field])),
    [effectiveFields],
  )
  const definitionFieldMap = useMemo(
    () => new Map(capabilityDefinitions.map((definition) => [definition.field, definition])),
    [capabilityDefinitions],
  )
  const capabilityFields: CapabilityField[] = useMemo(() => {
    return capabilityDefinitions.map((definition) => {
      const effectiveField = effectiveFieldMap.get(definition.field)
      const enabledOptions = effectiveField?.options ?? []
      return {
        field: definition.field,
        label: toFieldLabel(definition.field),
        labelKey: definition.fieldI18n?.labelKey,
        unitKey: definition.fieldI18n?.unitKey,
        optionLabelKeys: definition.fieldI18n?.optionLabelKeys,
        options: definition.options as VideoGenerationOptionValue[],
        disabledOptions: (definition.options as VideoGenerationOptionValue[])
          .filter((option) => !enabledOptions.includes(option)),
        value: effectiveField?.value as VideoGenerationOptionValue | undefined,
      }
    })
  }, [capabilityDefinitions, effectiveFieldMap])

  const setCapabilityValue = (field: string, rawValue: string) => {
    const definitionField = definitionFieldMap.get(field)
    if (!definitionField || definitionField.options.length === 0) return
    const parsedValue = parseByOptionType(rawValue, definitionField.options[0])
    if (!definitionField.options.includes(parsedValue)) return
    userTouchedRef.current = true
    setGenerationOptions((previous) => ({
      ...normalizeVideoGenerationSelections({
        definitions: capabilityDefinitions,
        pricingTiers,
        selection: {
          ...previous,
          [field]: parsedValue,
        },
        pinnedFields: [field],
      }),
    }))
    // 方案A：把用户的选择回写到项目级 capabilityOverrides，使其持久化并成为该项目默认。
    // 否则下方 useEffect 会在 capabilityDefinitions/pricingTiers 变化时，用 capabilityOverrides
    // 里的旧值（默认）覆盖用户在 local generationOptions 中的修改（duration/fps/quality 等所有参数均受此影响）。
    if (onCapabilityOverridesChange && selectedModel) {
      const nextOverrides: CapabilitySelections = { ...(capabilityOverrides || {}) }
      const current = isRecord(nextOverrides[selectedModel])
        ? { ...(nextOverrides[selectedModel] as Record<string, CapabilityValue>) }
        : {}
      current[field] = parsedValue
      nextOverrides[selectedModel] = current
      onCapabilityOverridesChange(nextOverrides)
    }
  }

  return {
    selectedModel,
    setSelectedModel,
    generationOptions,
    capabilityFields,
    setCapabilityValue,
    missingCapabilityFields,
    videoModelOptions,
  }
}
