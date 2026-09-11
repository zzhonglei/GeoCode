import type { SkillScope, SkillSource } from '@/stores/useSkillsStore';

export type SkillLocationValue = 'user-opencode' | 'project-opencode' | 'user-claude' | 'project-claude' | 'user-agents' | 'project-agents';

export const SKILL_LOCATION_OPTIONS: Array<{
  value: SkillLocationValue;
  scope: SkillScope;
  source: SkillSource;
  label: string;
  description: string;
}> = [
  {
    value: 'user-opencode',
    scope: 'user',
    source: 'opencode',
    label: 'User / OpenCode',
    description: 'Global OpenCode config location',
  },
  {
    value: 'project-opencode',
    scope: 'project',
    source: 'opencode',
    label: 'Project / OpenCode',
    description: 'Current project .opencode location',
  },
  // --- GeoCode: the two `.agents` options are gone. They wrote a skill into another agent
  // tool's library, which the kernel then refused to load — the option offered the user a
  // location where nothing they created would ever run. The server refuses the same target in
  // `skills.js` and `skills-catalog/install.js`; both ends move together, because closing only
  // one of them is what made an earlier attempt worse than leaving it alone: the skill could
  // still be created and then could not be edited. ---
  /*
  {
    value: 'user-agents',
    scope: 'user',
    source: 'agents',
    label: 'User / Agents',
    description: 'Global .agents compatibility location',
  },
  {
    value: 'project-agents',
    scope: 'project',
    source: 'agents',
    label: 'Project / Agents',
    description: 'Current project .agents compatibility location',
  },
  */
  // --- /GeoCode ---
];

export function locationValueFrom(scope: SkillScope, source: SkillSource): SkillLocationValue {
  if (scope === 'project' && source === 'claude') return 'project-claude';
  if (scope === 'project' && source === 'agents') return 'project-agents';
  if (source === 'claude') return 'user-claude';
  if (scope === 'project') return 'project-opencode';
  if (source === 'agents') return 'user-agents';
  return 'user-opencode';
}

export function locationPartsFrom(value: SkillLocationValue): { scope: SkillScope; source: SkillSource } {
  if (value === 'user-claude') return { scope: 'user', source: 'claude' };
  if (value === 'project-claude') return { scope: 'project', source: 'claude' };
  const match = SKILL_LOCATION_OPTIONS.find((option) => option.value === value);
  if (!match) {
    return { scope: 'user', source: 'opencode' };
  }
  return { scope: match.scope, source: match.source };
}
