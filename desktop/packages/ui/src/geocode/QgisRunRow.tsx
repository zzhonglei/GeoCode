import React from 'react';

import { useI18nStore } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';

import { qgisRunning } from './geoTools';
import { qgisRunView } from './qgisRun';
import { QgisLogo } from './QgisLogo';
import { RunRow } from './RunRow';

/**
 * A qgisrun call's row: the QGIS logo and what GeoAgent says the step is for; while it runs, the algorithm being run,
 * its percentage when QGIS reports one, and the time so far; once done, the time it took, the title in the error
 * colour unless it finished. It opens to the English excerpt of the answer: the facts settled before the run, every
 * message QGIS gave, and how the run ended.
 */
export const QgisRunRow: React.FC<{ part: ToolPart }> = ({ part }) => {
  // Subscribed so the row follows a change of language.
  const locale = useI18nStore((state) => state.locale);
  const view = qgisRunView(part, locale);
  return (
    <RunRow
      id={part.id}
      logo={<QgisLogo className="h-3.5 w-3.5" />}
      title={view.title}
      bad={view.bad}
      doing={view.running && view.algorithm ? qgisRunning(view.algorithm.name, locale) : undefined}
      percent={view.percent}
      start={view.start}
      end={view.end}
      lines={view.lines}
    />
  );
};
