import { expect, test } from 'bun:test';

import { formatAgentStatus } from '@/lib/agentStatus';
import { formatMessage, useI18nStore, type Locale } from '@/lib/i18n';

import { geoStatus } from './geoStatusText';
import { GEO_TOOLS } from './geoTools';

const loaded = async (locale: Locale) => {
  useI18nStore.getState().setLocale(locale);
  while (useI18nStore.getState().loadingLocale) await new Promise((resolve) => setTimeout(resolve, 5));
  return useI18nStore.getState().dictionary;
};

// Guards against a geo tool's status shown as its key: its keys are GeoCode's, which only the dictionaries the app
// loads hold.
test('GeoCode: the status row says what a geo tool does, in each of the app\'s languages', async () => {
  for (const locale of ['en', 'zh-CN', 'zh-TW'] satisfies Locale[]) {
    const dictionary = await loaded(locale);
    for (const tool of GEO_TOOLS) {
      for (const count of [1, 3]) {
        const label = formatAgentStatus((key, params) => formatMessage(dictionary, key, params), locale, geoStatus(tool, count));
        expect(label).not.toContain('geocode.agentStatus');
        if (count > 1 && (tool === 'qgisrun' || tool === 'geerun')) expect(label).toContain('3');
      }
    }
  }
  const zh = await loaded('zh-CN');
  expect(formatAgentStatus((key, params) => formatMessage(zh, key, params), 'zh-CN', geoStatus('qgisrun', 3))).toBe('正在运行 3 个 QGIS 算法');
});
