import React from 'react';
import { Popover } from '@base-ui/react/popover';

import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useGeoStatuses } from './geoEngineClient';
import { useGeoSettingsStore } from './geoSettingsStore';
import { DOT_CLASS, lightOf, qgisStatusOf } from './geoStatus';
import { QgisLogo } from './QgisLogo';
import { QgisStatusDetails } from './QgisStatusDetails';
import { qgisText } from './qgisText';

/** The QGIS indicator in the window header; nothing until GeoEngine has reported QGIS. */
export const GeoStatusButton: React.FC<{ className?: string }> = ({ className }) => {
  const { locale } = useI18n();
  const text = qgisText(locale);
  const statuses = useGeoStatuses();
  const [open, setOpen] = React.useState(false);
  const status = React.useMemo(() => qgisStatusOf(statuses), [statuses]);
  if (!status) return null;

  const light = lightOf(status.status);
  const label = text.status[status.status];

  const manage = () => {
    setOpen(false);
    useGeoSettingsStore.getState().request('qgis');
    const ui = useUIStore.getState();
    ui.setSettingsPage('geo-environment');
    ui.setSettingsDialogOpen(true);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Popover.Trigger
            render={<button type="button" aria-label={`QGIS: ${label}`} className={cn('relative', className)} />}
          >
            <QgisLogo className={cn('h-[18px] w-[18px]', (light === 'idle' || light === 'failed') && 'opacity-60')} />
            <span className={cn('absolute right-1 top-1 size-2 rounded-full border border-[var(--background)]', DOT_CLASS[light])} aria-hidden />
          </Popover.Trigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{`QGIS · ${label}`}</TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} className="app-region-no-drag z-50">
          <Popover.Popup aria-label="QGIS" className={cn(dropdownMenuPopupClass, 'flex w-[23rem] max-w-[calc(100vw-2rem)] flex-col gap-1.5 p-3')}>
            <div className="flex items-center gap-2">
              <span className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[light])} aria-hidden />
              <span className="typography-ui-label font-medium text-foreground">QGIS</span>
              <span className="typography-ui-label min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
              <button
                type="button"
                onClick={manage}
                className="typography-micro shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
              >
                {text.manage}
              </button>
            </div>
            <QgisStatusDetails status={status} text={text} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};
