import React from 'react';

import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { useI18n, type Locale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { chooseBasemap, useGeoStatuses } from './geoEngineClient';
import { basemapStatusOf, type BasemapStatus } from './geoStatus';
import { LIST_CLASS, ROW_CLASS } from './settingsList';

type Source = BasemapStatus['source'];

interface BasemapText {
  heading: string;
  description: string;
  offline: string;
  offlineDetail: string;
  none: string;
  noneDetail: string;
  missing: string;
  chooseFailed: (reason: string) => string;
}

const TEXT: { en: BasemapText } & Partial<Record<Locale, BasemapText>> = {
  en: {
    heading: 'Basemap',
    description: 'Drawn under geographic data, in the files view and in the maps the agent shows.',
    offline: 'Offline basemap',
    offlineDetail: 'Comes with GeoCode and works without a network',
    none: 'None',
    noneDetail: 'The data on a plain background',
    missing: 'This installation lacks the basemap’s files.',
    chooseFailed: (reason) => `The basemap could not be changed: ${reason}`,
  },
  'zh-CN': {
    heading: '底图',
    description: '画在地理数据下面，用于文件预览与智能体展示的地图。',
    offline: '离线底图',
    offlineDetail: '随 GeoCode 安装，不联网也能显示',
    none: '不显示',
    noneDetail: '数据画在空白背景上',
    missing: '这次安装缺少底图的文件。',
    chooseFailed: (reason) => `无法更改底图：${reason}`,
  },
  'zh-TW': {
    heading: '底圖',
    description: '畫在地理資料下面，用於檔案預覽與智慧體展示的地圖。',
    offline: '離線底圖',
    offlineDetail: '隨 GeoCode 安裝，不連網也能顯示',
    none: '不顯示',
    noneDetail: '資料畫在空白背景上',
    missing: '這次安裝缺少底圖的檔案。',
    chooseFailed: (reason) => `無法變更底圖：${reason}`,
  },
};

/** The settings' choice of basemap, on the Geo environment page. */
export const BasemapSection: React.FC = () => {
  const { locale } = useI18n();
  const text = TEXT[locale] ?? TEXT.en;
  const status = basemapStatusOf(useGeoStatuses());
  // Shown as chosen until GeoEngine reports the choice it wrote.
  const [pending, setPending] = React.useState<Source | null>(null);
  const shown = pending ?? status?.source;
  React.useEffect(() => {
    if (pending !== null && status?.source === pending) setPending(null);
  }, [pending, status?.source]);

  const choose = async (source: Source) => {
    if (source === shown) return;
    setPending(source);
    const outcome = await chooseBasemap(source);
    if (outcome.ok) return;
    setPending(null);
    toast.error(text.chooseFailed(outcome.reason));
  };

  const options: { source: Source; label: string; detail: string }[] = [
    { source: 'offline', label: text.offline, detail: text.offlineDetail },
    { source: 'none', label: text.none, detail: text.noneDetail },
  ];
  return (
    <SettingsSection title={text.heading} description={text.description} settingsItem="geo-environment.basemap">
      {status && !status.available ? <p className="typography-meta mb-2 text-[var(--status-error)]">{text.missing}</p> : null}
      <div role="radiogroup" aria-label={text.heading} className={LIST_CLASS}>
        {options.map((option) => {
          const selected = option.source === shown;
          return (
            <button
              key={option.source}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => void choose(option.source)}
              className={cn(ROW_CLASS, selected ? 'bg-[var(--interactive-selection)]/25' : 'hover:bg-[var(--interactive-hover)]/50')}
            >
              <span
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-full border',
                  selected ? 'border-[var(--primary-base)]' : 'border-[var(--interactive-border-hover)]',
                )}
                aria-hidden
              >
                {selected ? <span className="size-2 rounded-full bg-[var(--primary-base)]" /> : null}
              </span>
              <span className="typography-ui-label shrink-0 font-medium text-foreground">{option.label}</span>
              <span className="typography-meta min-w-0 flex-1 truncate text-muted-foreground">{option.detail}</span>
            </button>
          );
        })}
      </div>
    </SettingsSection>
  );
};
