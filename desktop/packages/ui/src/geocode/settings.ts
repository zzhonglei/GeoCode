// Kept free of runtime imports: the settings metadata that calls these is imported everywhere.
import type { SettingsPageMeta } from '@/lib/settings/metadata';

// Search finds settings, not pages, and the Geo environment page lists none: it is found as a whole, by its keywords.
export const GEO_ENVIRONMENT_SEARCH_ITEM = {
  id: 'geo-environment',
  page: 'geo-environment' as const,
  keywords: ['qgis', 'gis', 'geo', 'geoengine', 'environment', '地理', '環境', '环境', 'gee', 'earth engine'],
};

const CLOSED_PAGES: ReadonlySet<string> = new Set(['remote-instances', 'tunnel', 'extensions', 'plugins', 'magic-prompts', 'snippets', 'skills.catalog', 'isolated-spaces'] satisfies SettingsPageMeta['slug'][]);

// Skills is the one library page left open, so it joins the OpenCode group rather than head a group of its own. A group
// shows only while SettingsView.tsx's NAV_GROUP_ORDER lists it.
const MOVED_PAGES = new Map<SettingsPageMeta['slug'], SettingsPageMeta['group']>([['skills.installed', 'opencode']]);

export const CLOSED_SEARCH_ITEMS = new Set([
  'sessions.desktop-ui-password',
  'sessions.desktop-lan-access',
  'sessions.opencode-binary',
  'sessions.opencode-restart',
  'sessions.opencode-update-notifications',
  'appearance.usage-reports',
  'integrations.linear',
  'integrations.linear.add-workspace',
  'integrations.linear.mapping',
  'git.gitlab-account',
  'git.gitlab-connect',
  'integrations.guests',
  'integrations.third-party',
  'integrations.third-party.opencode-claude',
  'integrations.extensions',
  'integrations.extensions.excalidraw',
  'integrations.extensions.resource-monitor',
  'general.isolated-spaces',
  'general.isolated-spaces-idle-stop',
  'general.isolated-spaces-machine',
  'sessions.browser-provider',
  'chat.session-goal-checker',
  'chat.session-review-offer',
  'projects.worktree.setup.replace',
  'projects.shared',
  'projects.shared.plansDir',
]);

type Gated = { isAvailable?: (ctx: never) => boolean };

const hide = (entry: Gated) => {
  entry.isAvailable = () => false;
};

export const isClosedSettingsPage = (slug: string) => CLOSED_PAGES.has(slug);

export const adaptSettingsPages = (pages: readonly SettingsPageMeta[]) => {
  pages.filter((page) => CLOSED_PAGES.has(page.slug)).forEach(hide);
  for (const page of pages) page.group = MOVED_PAGES.get(page.slug) ?? page.group;
};

export const closeSettingsSearchItems = (items: readonly (Gated & { id: string })[]) => {
  items.filter((item) => CLOSED_SEARCH_ITEMS.has(item.id)).forEach(hide);
};
