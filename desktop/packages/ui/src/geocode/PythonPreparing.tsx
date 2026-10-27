import React from 'react';

import { useI18n, type Locale } from '@/lib/i18n';
import type { PreparingGate } from './geoStatus';

type PreparingText = { preparing: string; loading: (name: string, number: number, total: number) => string };

const TEXT: { en: PreparingText } & Partial<Record<Locale, PreparingText>> = {
  en: {
    preparing: 'Preparing the built-in geo environment…',
    loading: (name, number, total) => `Loading ${name} ${number}/${total}`,
  },
  'zh-CN': {
    preparing: '正在准备内置的地理环境…',
    loading: (name, number, total) => `正在加载 ${name} ${number}/${total}`,
  },
  'zh-TW': {
    preparing: '正在準備內建的地理環境…',
    loading: (name, number, total) => `正在載入 ${name} ${number}/${total}`,
  },
};

/** What the loading screen says while GeoCode's Python environment is prepared. */
export const PythonPreparing: React.FC<{ gate: PreparingGate }> = ({ gate }) => {
  const { locale } = useI18n();
  const text = TEXT[locale] ?? TEXT.en;
  return (
    <>
      <span className="block">{text.preparing}</span>
      {gate.loading ? (
        <span className="block tabular-nums">{text.loading(gate.loading.name, gate.loading.number, gate.loading.total)}</span>
      ) : null}
    </>
  );
};
