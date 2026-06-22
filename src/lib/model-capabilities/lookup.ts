import {
  parseModelKeyStrict,
  type CapabilitySelections,
  type CapabilityValue,
  type CapabilityOptionValue,
  type ModelCapabilities,
  type UnifiedModelType,
} from '@/lib/model-config-contract'
import { findBuiltinCapabilities, findBuiltinCapabilityCatalogEntry } from '@/lib/model-capabilities/catalog'

export type CapabilitySelectionValidationCode =
  | 'CAPABILITY_SELECTION_INVALID'
  | 'CAPABILITY_MODEL_UNSUPPORTED'
  | 'CAPABILITY_FIELD_INVALID'
  | 'CAPABILITY_VALUE_NOT_ALLOWED'
  | 'CAPABILITY_REQUIRED'

export interface CapabilitySelectionValidationIssue {
  code: CapabilitySelectionValidationCode
  field: string
  message: string
  allowedValues?: readonly CapabilityOptionValue[]
}

export interface CapabilityModelContext {
  modelType: UnifiedModelType
  capabilities?: ModelCapabilities
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isCapabilityValue(value: unknown): value is CapabilityValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function getNamespaceCapabilities(
  modelType: UnifiedModelType,
  capabilities: ModelCapabilities | undefined,
): Record<string, unknown> | null {
  if (!capabilities) return null
  const namespace = capabilities[modelType]
  if (!namespace || !isRecord(namespace)) return null
  return namespace
}

export function getCapabilityOptionFields(
  modelType: UnifiedModelType,
  capabilities: ModelCapabilities | undefined,
): Record<string, readonly CapabilityOptionValue[]> {
  const namespace = getNamespaceCapabilities(modelType, capabilities)
  if (!namespace) return {}

  const fields: Record<string, readonly CapabilityOptionValue[]> = {}
  for (const [key, rawValue] of Object.entries(namespace)) {
    if (!key.endsWith('Options')) continue
    if (!Array.isArray(rawValue)) continue
    if (rawValue.length === 0) continue
    if (!rawValue.every((item) => isCapabilityValue(item))) continue
    const field = key.slice(0, -'Options'.length)
    fields[field] = rawValue as CapabilityOptionValue[]
  }
  return fields
}

export function hasCapabilityOptions(
  modelType: UnifiedModelType,
  capabilities: ModelCapabilities | undefined,
): boolean {
  return Object.keys(getCapabilityOptionFields(modelType, capabilities)).length > 0
}

function normalizeSelectionRecord(
  value: unknown,
  field: string,
): { value: Record<string, CapabilityValue> | null; issues: CapabilitySelectionValidationIssue[] } {
  const issues: CapabilitySelectionValidationIssue[] = []
  if (value === undefined || value === null) {
    return { value: null, issues }
  }
  if (!isRecord(value)) {
    issues.push({
      code: 'CAPABILITY_SELECTION_INVALID',
      field,
      message: 'selection must be an object',
    })
    return { value: null, issues }
  }

  const normalized: Record<string, CapabilityValue> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!isCapabilityValue(raw)) {
      issues.push({
        code: 'CAPABILITY_SELECTION_INVALID',
        field: `${field}.${key}`,
        message: 'selection value must be string/number/boolean',
      })
      continue
    }
    normalized[key] = raw
  }
  return { value: normalized, issues }
}

export function validateCapabilitySelectionForModel(input: {
  modelKey: string
  modelType: UnifiedModelType
  capabilities?: ModelCapabilities
  selection?: Record<string, CapabilityValue> | null
  requireAllFields: boolean
}): CapabilitySelectionValidationIssue[] {
  const issues: CapabilitySelectionValidationIssue[] = []
  const optionFields = getCapabilityOptionFields(input.modelType, input.capabilities)
  const optionFieldNames = new Set(Object.keys(optionFields))
  const selection = input.selection || {}

  if (Object.keys(optionFields).length === 0) {
    if (Object.keys(selection).length > 0) {
      issues.push({
        code: 'CAPABILITY_FIELD_INVALID',
        field: `capabilities.${input.modelKey}`,
        message: 'model has no configurable capability options',
      })
    }
    return issues
  }

  for (const [field, value] of Object.entries(selection)) {
    if (!optionFieldNames.has(field)) {
      issues.push({
        code: 'CAPABILITY_FIELD_INVALID',
        field: `capabilities.${input.modelKey}.${field}`,
        message: `field ${field} is not supported by model ${input.modelKey}`,
      })
      continue
    }

    const allowedValues = optionFields[field]
    if (!allowedValues.includes(value)) {
      issues.push({
        code: 'CAPABILITY_VALUE_NOT_ALLOWED',
        field: `capabilities.${input.modelKey}.${field}`,
        message: `value ${String(value)} is not allowed`,
        allowedValues,
      })
    }
  }

  if (input.requireAllFields) {
    for (const field of Object.keys(optionFields)) {
      if (selection[field] === undefined) {
        issues.push({
          code: 'CAPABILITY_REQUIRED',
          field: `capabilities.${input.modelKey}.${field}`,
          message: `field ${field} is required for model ${input.modelKey}`,
          allowedValues: optionFields[field],
        })
      }
    }
  }

  return issues
}

export function validateCapabilitySelectionsPayload(
  selections: unknown,
  resolveModelContext: (modelKey: string) => CapabilityModelContext | null,
): CapabilitySelectionValidationIssue[] {
  const issues: CapabilitySelectionValidationIssue[] = []

  if (selections === undefined || selections === null) return issues
  if (!isRecord(selections)) {
    issues.push({
      code: 'CAPABILITY_SELECTION_INVALID',
      field: 'capabilitySelections',
      message: 'capability selections must be an object',
    })
    return issues
  }

  for (const [modelKey, rawSelection] of Object.entries(selections)) {
    if (!parseModelKeyStrict(modelKey)) {
      issues.push({
        code: 'CAPABILITY_SELECTION_INVALID',
        field: `capabilitySelections.${modelKey}`,
        message: 'model key must be provider::modelId',
      })
      continue
    }

    const context = resolveModelContext(modelKey)
    if (!context) {
      issues.push({
        code: 'CAPABILITY_MODEL_UNSUPPORTED',
        field: `capabilitySelections.${modelKey}`,
        message: `model ${modelKey} is not supported by built-in capability catalog`,
      })
      continue
    }

    const normalizedSelection = normalizeSelectionRecord(
      rawSelection,
      `capabilitySelections.${modelKey}`,
    )
    issues.push(...normalizedSelection.issues)
    if (!normalizedSelection.value) continue

    issues.push(...validateCapabilitySelectionForModel({
      modelKey,
      modelType: context.modelType,
      capabilities: context.capabilities,
      selection: normalizedSelection.value,
      requireAllFields: false,
    }))
  }

  return issues
}

function mergeSelectionRecords(...records: Array<Record<string, CapabilityValue> | undefined>): Record<string, CapabilityValue> {
  const merged: Record<string, CapabilityValue> = {}
  for (const record of records) {
    if (!record) continue
    for (const [field, value] of Object.entries(record)) {
      merged[field] = value
    }
  }
  return merged
}

function pickSelectionForModel(
  selections: CapabilitySelections | undefined,
  modelKey: string,
): Record<string, CapabilityValue> | undefined {
  if (!selections) return undefined
  const selected = selections[modelKey]
  if (!selected || !isRecord(selected)) return undefined

  const normalized: Record<string, CapabilityValue> = {}
  for (const [field, rawValue] of Object.entries(selected)) {
    if (field === 'aspectRatio') continue
    if (!isCapabilityValue(rawValue)) continue
    normalized[field] = rawValue
  }
  return normalized
}

export function resolveGenerationOptionsForModel(input: {
  modelType: UnifiedModelType
  modelKey: string
  capabilities?: ModelCapabilities
  capabilityDefaults?: CapabilitySelections
  capabilityOverrides?: CapabilitySelections
  runtimeSelections?: Record<string, CapabilityValue>
  requireAllFields?: boolean
}): { options: Record<string, CapabilityValue>; issues: CapabilitySelectionValidationIssue[] } {
  const defaults = pickSelectionForModel(input.capabilityDefaults, input.modelKey)
  const overrides = pickSelectionForModel(input.capabilityOverrides, input.modelKey)
  const runtime = input.runtimeSelections

  const selection = mergeSelectionRecords(defaults, overrides, runtime)

  // Custom model not in built-in catalog: skip validation, pass through selections directly
  if (input.capabilities === undefined) {
    return { options: { ...selection }, issues: [] }
  }

  // 对有能力选项的模型做一次预检，捕获「必填字段缺失」场景
  const precheckIssues = validateCapabilitySelectionForModel({
    modelKey: input.modelKey,
    modelType: input.modelType,
    capabilities: input.capabilities,
    selection,
    requireAllFields: input.requireAllFields ?? true,
  })

  let normalizedSelection = { ...selection }
  const autofillIssues: CapabilitySelectionValidationIssue[] = []

  // V7: 通用兜底 —— 对任何 option 字段，只要 catalog 声明了 *Options 且用户配置中缺失，
  // 且 precheck 报告了 CAPABILITY_REQUIRED，就自动用第一个可选值补全。
  // 原逻辑只覆盖 image/resolution，现泛化到所有 modelType / 所有字段，
  // 避免新增 option 字段（如 video.fps）导致存量配置在 requireAllFields 校验时报错。
  const optionFields = getCapabilityOptionFields(input.modelType, input.capabilities)
  for (const field of Object.keys(optionFields)) {
    const fieldOptions = optionFields[field]
    if (!Array.isArray(fieldOptions) || fieldOptions.length === 0) continue
    if (Object.prototype.hasOwnProperty.call(normalizedSelection, field)) continue

    const missingIssue = precheckIssues.find(
      (issue) =>
        issue.code === 'CAPABILITY_REQUIRED'
        && issue.field === `capabilities.${input.modelKey}.${field}`,
    )
    if (missingIssue) {
      normalizedSelection = {
        ...normalizedSelection,
        [field]: fieldOptions[0],
      }
    }
  }

  // 使用补全后的 selection 再做一次严格校验，确保不会产生非法值
  const issues = validateCapabilitySelectionForModel({
    modelKey: input.modelKey,
    modelType: input.modelType,
    capabilities: input.capabilities,
    selection: normalizedSelection,
    requireAllFields: input.requireAllFields ?? true,
  })

  if (issues.length > 0) {
    return { options: {}, issues: autofillIssues.length > 0 ? [...autofillIssues, ...issues] : issues }
  }

  const options: Record<string, CapabilityValue> = {}
  for (const field of Object.keys(optionFields)) {
    const value = normalizedSelection[field]
    if (value !== undefined) {
      options[field] = value
    }
  }

  return { options, issues: [] }
}

export function resolveBuiltinModelContext(modelType: UnifiedModelType, modelKey: string): CapabilityModelContext | null {
  const parsed = parseModelKeyStrict(modelKey)
  if (!parsed) return null
  const entry = findBuiltinCapabilityCatalogEntry(modelType, parsed.provider, parsed.modelId)
  if (!entry) return null
  return {
    modelType: entry.modelType,
    capabilities: entry.capabilities,
  }
}

export function resolveBuiltinCapabilitiesByModelKey(
  modelType: UnifiedModelType,
  modelKey: string,
): ModelCapabilities | undefined {
  const parsed = parseModelKeyStrict(modelKey)
  if (!parsed) return undefined
  return findBuiltinCapabilities(modelType, parsed.provider, parsed.modelId)
}
