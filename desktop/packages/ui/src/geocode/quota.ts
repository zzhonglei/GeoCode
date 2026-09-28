import type { QuotaProviderId } from '@/types';
import { isGeoCodeDesktop } from '@/geocode/surface';

// The server drops the same providers, see CLOSED_QUOTA_PROVIDERS in web/server/geocode/closed-quota.js.
const CLOSED_QUOTA_PROVIDERS: ReadonlySet<QuotaProviderId> = new Set(['claude', 'cursor']);

export const withoutClosedQuotaProviders = <T extends { id: QuotaProviderId }>(providers: T[]): T[] =>
  isGeoCodeDesktop() ? providers.filter((provider) => !CLOSED_QUOTA_PROVIDERS.has(provider.id)) : providers;
