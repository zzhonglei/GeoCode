// Kept free of runtime imports: the settings metadata that calls these is imported everywhere.
const CLOSED_PAGES = new Set(['remote-instances', 'tunnel']);

const CLOSED_SEARCH_ITEMS = new Set([
  'sessions.desktop-ui-password',
  'sessions.desktop-lan-access',
  'sessions.opencode-binary',
  'sessions.opencode-restart',
  'sessions.opencode-update-notifications',
  'appearance.usage-reports',
]);

type Gated<Context> = { isAvailable?: (ctx: Context) => boolean };

const hideInDesktop = <Context extends { isDesktop: boolean }>(entry: Gated<Context>) => {
  const upstream = entry.isAvailable;
  entry.isAvailable = (ctx) => !ctx.isDesktop && (upstream ? upstream(ctx) : true);
};

export const closeSettingsPages = <Context extends { isDesktop: boolean }>(
  pages: readonly (Gated<Context> & { slug: string })[],
) => {
  pages.filter((page) => CLOSED_PAGES.has(page.slug)).forEach(hideInDesktop);
};

export const closeSettingsSearchItems = <Context extends { isDesktop: boolean }>(
  items: readonly (Gated<Context> & { id: string })[],
) => {
  items.filter((item) => CLOSED_SEARCH_ITEMS.has(item.id)).forEach(hideInDesktop);
};
