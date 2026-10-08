import type { SettingsCardTone } from '@/components/sections/shared/SettingsCards';

import type { Light } from './geoStatus';

/** The Geo environment pages' lists and status pills, alike for every environment. */
export const TONE = {
  ready: 'success',
  checking: 'warning',
  idle: 'neutral',
  failed: 'error',
} satisfies Record<Light, SettingsCardTone>;

export const LIST_CLASS = 'divide-y divide-[var(--interactive-border)] overflow-hidden rounded-lg border border-[var(--interactive-border)]';

export const ROW_CLASS = 'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:bg-[var(--interactive-hover)]';
