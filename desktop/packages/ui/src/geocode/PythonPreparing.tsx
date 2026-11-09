import React from 'react';

import { useI18n, type Locale } from '@/lib/i18n';
import { pythonFractionOf, type PreparingGate, type PythonProgress } from './geoStatus';

type PreparingText = {
  preparing: string;
  installing: (done: number, total: number) => string;
  creating: string;
  warming: (done: number, total: number) => string;
};

const TEXT: { en: PreparingText } & Partial<Record<Locale, PreparingText>> = {
  en: {
    preparing: 'Preparing the built-in Python environment',
    installing: (done, total) => `Installing Python packages ${done} / ${total}`,
    creating: 'Setting up the working environment',
    warming: (done, total) => `Loading common libraries ${done} / ${total}`,
  },
  'zh-CN': {
    preparing: '正在准备内置的 Python 环境',
    installing: (done, total) => `正在安装 Python 包 ${done} / ${total}`,
    creating: '正在建立工作环境',
    warming: (done, total) => `正在加载常用库 ${done} / ${total}`,
  },
  'zh-TW': {
    preparing: '正在準備內建的 Python 環境',
    installing: (done, total) => `正在安裝 Python 套件 ${done} / ${total}`,
    creating: '正在建立工作環境',
    warming: (done, total) => `正在載入常用函式庫 ${done} / ${total}`,
  },
};

const stepText = (text: PreparingText, progress: PythonProgress) =>
  progress.step === 'creating' ? text.creating : text[progress.step](progress.done, progress.total);

/**
 * How far the loading screen's logo rises while a note shows under it: half of what the note adds below the logo, its
 * gap and its three lines, so the two are centered together.
 */
export const STARTUP_NOTE_LIFT = 52;

/** What the loading screen shows while GeoCode's Python environment is prepared: one bar through every step. */
export const PythonPreparing: React.FC<{ gate: PreparingGate }> = ({ gate }) => {
  const { locale } = useI18n();
  const text = TEXT[locale] ?? TEXT.en;
  const percent = Math.floor(pythonFractionOf(gate.progress) * 100);
  return (
    <>
      <span className="block text-foreground">{text.preparing}</span>
      <span className="mx-auto mt-3 flex w-64 max-w-full items-center gap-3">
        <span
          role="progressbar"
          aria-label={text.preparing}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--interactive-border)]"
        >
          <span
            className="absolute inset-y-0 inset-s-0 rounded-full bg-[var(--primary-base)] transition-[width] duration-300 ease-out"
            style={{ width: `${percent}%` }}
          />
        </span>
        <span className="w-9 text-end tabular-nums">{percent}%</span>
      </span>
      <span className="mt-2 block tabular-nums">{stepText(text, gate.progress)}</span>
    </>
  );
};
