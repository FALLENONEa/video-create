import type { AssistantSkillDefinition } from '../types'
import { renderAssistantSystemPrompt } from '../system-prompts'

function buildTutorialPrompt(): string {
  return renderAssistantSystemPrompt('tutorial')
}

export const tutorialSkill: AssistantSkillDefinition = {
  id: 'tutorial',
  systemPrompt: buildTutorialPrompt,
  temperature: 0.2,
  maxSteps: 4,
}
