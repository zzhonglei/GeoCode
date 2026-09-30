// Kept free of runtime imports: the settings metadata that calls these is imported everywhere.
import type { SettingsPageMeta } from '@/lib/settings/metadata';

const CLOSED_PAGES = new Set(['remote-instances', 'tunnel', 'extensions', 'plugins', 'magic-prompts', 'snippets', 'skills.catalog']);

// A page's group takes no runtime context, so a move also applies outside the desktop app.
const MOVED_PAGES = new Map<SettingsPageMeta['slug'], SettingsPageMeta['group']>([['skills.installed', 'opencode']]);

const CLOSED_SEARCH_ITEMS = new Set([
  'sessions.desktop-ui-password',
  'sessions.desktop-lan-access',
  'sessions.opencode-binary',
  'sessions.opencode-restart',
  'sessions.opencode-update-notifications',
  'appearance.usage-reports',
  'integrations.linear',
  'integrations.linear.add-workspace',
  'integrations.linear.mapping',
  'integrations.guests',
  'sessions.browser-provider',
]);

type Gated<Context> = { isAvailable?: (ctx: Context) => boolean };

const hideInDesktop = <Context extends { isDesktop: boolean }>(entry: Gated<Context>) => {
  const upstream = entry.isAvailable;
  entry.isAvailable = (ctx) => !ctx.isDesktop && (upstream ? upstream(ctx) : true);
};

export const isClosedSettingsPage = (slug: string) => CLOSED_PAGES.has(slug);

export const adaptSettingsPages = (pages: readonly SettingsPageMeta[]) => {
  pages.filter((page) => CLOSED_PAGES.has(page.slug)).forEach(hideInDesktop);
  for (const page of pages) page.group = MOVED_PAGES.get(page.slug) ?? page.group;
};

export const closeSettingsSearchItems = <Context extends { isDesktop: boolean }>(
  items: readonly (Gated<Context> & { id: string })[],
) => {
  items.filter((item) => CLOSED_SEARCH_ITEMS.has(item.id)).forEach(hideInDesktop);
};
