// The UI hides the same providers, see CLOSED_QUOTA_PROVIDERS in ui/src/geocode/quota.ts.
const CLOSED_QUOTA_PROVIDERS = Object.freeze(['claude', 'cursor']);

// A closed id then answers as unsupported everywhere the table is looked up.
export const withoutClosedQuotaProviders = (table) =>
  Object.fromEntries(Object.entries(table).filter(([id]) => !CLOSED_QUOTA_PROVIDERS.includes(id)));
