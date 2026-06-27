'use client'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import TaskStatusInline from '@/components/task/TaskStatusInline'
import { resolveTaskPresentationState } from '@/lib/task/presentation'

interface EmotionSettingsPanelProps {
    lineId: string
    emotionPrompt: string | null
    emotionStrength: number
    onSave: (lineId: string, emotionPrompt: string | null, emotionStrength: number) => void
    onGenerate: (lineId: string) => void
    onGenerateEmotionPrompt: (lineId: string) => Promise<string | null>
    isVoiceGenerationRunning: boolean
    emotionSupported: boolean
}

export default function EmotionSettingsPanel({
    lineId,
    emotionPrompt,
    emotionStrength,
    onSave,
    onGenerate,
    onGenerateEmotionPrompt,
    isVoiceGenerationRunning,
    emotionSupported
}: EmotionSettingsPanelProps) {
    const t = useTranslations('voice')
    const voiceGenerationState = isVoiceGenerationRunning
        ? resolveTaskPresentationState({
            phase: 'processing',
            intent: 'generate',
            resource: 'audio',
            hasOutput: false,
        })
        : null
    const [prompt, setPrompt] = useState(emotionPrompt || '')
    const [strength, setStrength] = useState(emotionStrength)
    const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false)

    const handleAiGeneratePrompt = async () => {
        if (isGeneratingPrompt) return
        setIsGeneratingPrompt(true)
        try {
            const generated = await onGenerateEmotionPrompt(lineId)
            if (generated) {
                setPrompt(generated)
            }
        } finally {
            setIsGeneratingPrompt(false)
        }
    }

    const handlePromptChange = (value: string) => {
        setPrompt(value)
    }

    const handleStrengthChange = (value: number) => {
        setStrength(value)
    }

    const handleGenerate = () => {
        onSave(lineId, prompt.trim() || null, strength)
        onGenerate(lineId)
    }

    return (
        <div className="px-4 py-3 bg-[var(--glass-tone-info-bg)] space-y-3">
            {/* 智谱 glm-tts-clone 不支持任何情绪控制（提示词会被原样朗读），整区置灰提示 */}
            {!emotionSupported && (
                <p className="text-[10px] leading-snug text-[var(--glass-text-tertiary)] bg-[var(--glass-bg-surface)] rounded-lg px-2.5 py-2">
                    {t("emotionUnsupported")}
                </p>
            )}

            {/* 情绪提示词 */}
            <div className={emotionSupported ? '' : 'opacity-50'}>
                <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs text-[var(--glass-tone-info-fg)] font-medium">
                        {t("emotionPrompt")} <span className="text-[var(--glass-text-tertiary)] font-normal">{t("emotionPromptTip")}</span>
                    </label>
                    <button
                        type="button"
                        onClick={handleAiGeneratePrompt}
                        disabled={isGeneratingPrompt || !emotionSupported}
                        className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 text-[11px] leading-none text-[var(--glass-tone-info-fg)] border border-[var(--glass-stroke-focus)]/60 rounded-lg hover:bg-[var(--glass-bg-surface)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isGeneratingPrompt ? t("emotionPromptGenerating") : t("emotionPromptGenerate")}
                    </button>
                </div>
                <input
                    type="text"
                    value={prompt}
                    disabled={!emotionSupported}
                    onChange={(e) => handlePromptChange(e.target.value)}
                    placeholder={t("emotionPlaceholder")}
                    className="w-full px-3 py-2 text-sm border border-[var(--glass-stroke-focus)]/60 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--glass-tone-info-fg)]/50 focus:border-[var(--glass-stroke-focus)] bg-[var(--glass-bg-surface)] disabled:cursor-not-allowed"
                />
            </div>

            {/* 情绪强度滑块 */}
            <div className={emotionSupported ? '' : 'opacity-50'}>
                <label className="block text-xs text-[var(--glass-tone-info-fg)] mb-1.5 font-medium">
                    {t("emotionStrength")}: <span className="font-bold">{strength.toFixed(1)}</span>
                </label>
                <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={strength}
                    disabled={!emotionSupported}
                    onChange={(e) => handleStrengthChange(parseFloat(e.target.value))}
                    className="w-full h-2 bg-[var(--glass-tone-info-bg)] rounded-lg appearance-none cursor-pointer accent-[var(--glass-accent-from)] disabled:cursor-not-allowed"
                />
                <div className="flex justify-between text-[10px] text-[var(--glass-text-tertiary)] mt-1">
                    <span>{t("flat")}</span>
                    <span>{t("intense")}</span>
                </div>
            </div>

            {/* 生成语音按钮 */}
            <button
                onClick={handleGenerate}
                disabled={isVoiceGenerationRunning}
                className="w-full py-2 text-sm bg-[var(--glass-tone-success-fg)] text-white rounded-xl hover:bg-[var(--glass-tone-success-fg)] font-medium transition-all shadow-[var(--glass-shadow-sm)] disabled:opacity-50 disabled:cursor-not-allowed"
            >
                {isVoiceGenerationRunning ? (
                    <TaskStatusInline state={voiceGenerationState} className="justify-center text-white [&>span]:text-white [&_svg]:text-white" />
                ) : t("generateVoice")}
            </button>
        </div>
    )
}
