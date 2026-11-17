import type { SettingsCardTone } from '@/components/sections/shared/SettingsCards';

import type { Light } from './geoStatus';

/** The Geo environment pages' status pills, alike for every environment. */
export const TONE = {
  ready: 'success',
  checking: 'warning',
  idle: 'neutral',
  failed: 'error',
} satisfies Record<Light, SettingsCardTone>;
