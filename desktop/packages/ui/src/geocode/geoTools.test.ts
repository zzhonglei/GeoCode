import { afterEach, describe, expect, test } from 'bun:test';

import { BUILTIN_ACTIONS } from '@/components/sections/agents/agentPermissionModel';
import { useI18nStore } from '@/lib/i18n';
import type { ToolInput } from '@/lib/opencode/model';
import { toolDescription } from '@/lib/opencode/tools';
import { getToolMetadata } from '@/lib/toolHelpers';

import { geoActionLabel, geoPermissionTitle } from './geoTools';

const english = useI18nStore.getState().locale;
afterEach(() => useI18nStore.setState({ locale: english }));

describe('GeoCode: the geo tools in the interface', () => {
  // Guards against the hook in the shared helpers going missing, which leaves the row titled "Qgisdoc".
  test('a geo tool row is titled in the language of the interface', () => {
    useI18nStore.setState({ locale: 'zh-CN' });
    expect(getToolMetadata('qgisdoc').displayName).toBe('QGIS 文档');
    useI18nStore.setState({ locale: 'en' });
    expect(getToolMetadata('qgisdoc').displayName).toBe('QGIS Docs');
    expect(getToolMetadata('shell').displayName).not.toBe('QGIS Docs');
  });

  test('a qgisdoc row says what it looks up', () => {
    const describe = (input: ToolInput) => toolDescription('qgisdoc', input, undefined);
    expect(describe({ action: 'help', algorithm: 'native:buffer' })).toEqual({ kind: 'text', value: 'native:buffer' });
    expect(describe({ action: 'search', query: ' buffer ' })).toEqual({ kind: 'text', value: 'buffer' });
    expect(describe({ action: 'algorithms', group: 'Vector geometry' })).toEqual({ kind: 'text', value: 'Vector geometry' });
    expect(describe({ action: 'groups' })).toEqual({ kind: 'text', value: 'All groups' });
    expect(describe({ action: 'help' })).toBeNull();
  });

  // Guards against the geo tools' rules being missing from Settings, where the native tools' rules are.
  test('the geo tools have permission rows of their own, named and summarised', () => {
    expect(BUILTIN_ACTIONS).toContain('qgisdoc');
    expect(geoActionLabel('qgisdoc')).toBe('QGIS Docs');
    expect(geoActionLabel('shell')).toBeUndefined();
    useI18nStore.setState({ locale: 'zh-TW' });
    expect(geoPermissionTitle('qgisdoc')).toBe('查閱 QGIS 演算法');
    expect(geoPermissionTitle('read')).toBeUndefined();
  });
});
