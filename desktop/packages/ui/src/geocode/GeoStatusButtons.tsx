import React from 'react';
import { Popover } from '@base-ui/react/popover';

import { dropdownMenuPopupClass } from '@/components/ui/dropdown-menu.styles';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { GeeLogo } from './GeeLogo';
import { GeeStatusDetails } from './GeeStatusDetails';
import { geeLabel, geeText } from './geeText';
import { useGeoStatuses } from './geoEngineClient';
import { useGeoSettingsStore } from './geoSettingsStore';
import { DOT_CLASS, geeStatusOf, lightOf, qgisStatusOf } from './geoStatus';
import { QgisLogo } from './QgisLogo';
import { QgisStatusDetails } from './QgisStatusDetails';
import { QGIS_STATUS, qgisText } from './qgisText';

/** One environment's indicator: its logo with a coloured dot, opening its status and diagnostics. */
const GeoIndicator: React.FC<{
  name: string;
  /** What a screen reader says, where `name` is an abbreviation it would spell out. */
  spoken?: string;
  logo: React.FC<{ className?: string }>;
  status: string;
  label: string;
  details: React.ReactNode;
  /** The way to this environment's settings, when the settings page has them. */
  manage?: { readonly text: string; readonly open: () => void };
  className?: string;
}> = ({ name, spoken = name, logo: Logo, status, label, details, manage, className }) => {
  const [open, setOpen] = React.useState(false);
  const light = lightOf(status);
  const blink = useWaitingBlink(light === 'checking');

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Popover.Trigger
            render={<button type="button" aria-label={`${spoken}: ${label}`} className={cn('relative', className)} />}
          >
            <Logo className={cn('h-[18px] w-[18px]', (light === 'idle' || light === 'failed') && 'opacity-60')} />
            <span className={cn('absolute inset-e-1 top-1 size-2 rounded-full border border-[var(--background)]', DOT_CLASS[light], blink)} aria-hidden />
          </Popover.Trigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{`${name} · ${label}`}</TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} className="app-region-no-drag z-50">
          <Popover.Popup aria-label={spoken} className={cn(dropdownMenuPopupClass, 'flex w-[23rem] max-w-[calc(100vw-2rem)] flex-col gap-1.5 p-3')}>
            <div className="flex items-center gap-2">
              <span className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[light], blink)} aria-hidden />
              <span className="typography-ui-label font-medium text-foreground">{name}</span>
              <span className="typography-ui-label min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
              {manage ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    manage.open();
                  }}
                  className="typography-micro shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                >
                  {manage.text}
                </button>
              ) : null}
            </div>
            {details}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

/** The environments' indicators in the window header, QGIS then Google Earth Engine; each only once GeoEngine reports it. */
export const GeoStatusButtons: React.FC<{ className?: string }> = ({ className }) => {
  const { locale } = useI18n();
  const text = qgisText(locale);
  const quota = geeText(locale).quota;
  const statuses = useGeoStatuses();
  const qgis = React.useMemo(() => qgisStatusOf(statuses), [statuses]);
  const gee = React.useMemo(() => geeStatusOf(statuses), [statuses]);

  const manage = (domain: 'qgis' | 'gee') => ({
    text: text.manage,
    open: () => {
      useGeoSettingsStore.getState().request(domain);
      const ui = useUIStore.getState();
      ui.setSettingsPage('geo-environment');
      ui.setSettingsDialogOpen(true);
    },
  });

  return (
    <>
      {qgis ? (
        <GeoIndicator
          name="QGIS"
          logo={QgisLogo}
          status={qgis.status}
          label={QGIS_STATUS[qgis.status]}
          details={<QgisStatusDetails status={qgis} text={text} />}
          manage={manage('qgis')}
          className={className}
        />
      ) : null}
      {gee ? (
        <GeoIndicator
          name="GEE"
          spoken="Google Earth Engine"
          logo={GeeLogo}
          status={gee.status}
          label={geeLabel(gee)}
          details={<GeeStatusDetails status={gee} text={text} quota={quota} />}
          manage={manage('gee')}
          className={className}
        />
      ) : null}
    </>
  );
};
