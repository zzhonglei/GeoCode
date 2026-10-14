// Kept free of runtime imports: the settings metadata that calls these is imported everywhere.
import type { SettingsPageMeta } from '@/lib/settings/metadata';

const CLOSED_PAGES = new Set(['remote-instances', 'tunnel', 'extensions', 'plugins', 'magic-prompts', 'snippets', 'skills.catalog', 'isolated-spaces']);

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
  'git.gitlab-account',
  'git.gitlab-connect',
  'integrations.guests',
  'integrations.third-party',
  'integrations.third-party.opencode-claude',
  'integrations.extensions',
  'integrations.extensions.excalidraw',
  'general.isolated-spaces',
  'general.isolated-spaces-idle-stop',
  'sessions.browser-provider',
  'sessions.work-auto-open',
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
