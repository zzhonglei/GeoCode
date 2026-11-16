import React from 'react';

import { SettingsBackButton } from '@/components/sections/shared/SettingsCards';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SETTINGS_HELPER_CLASS, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { basemapText, OPENFREEMAP_STYLES, VERSATILES_STYLES, type BasemapText } from './basemapText';
import { configureBasemap, useGeoStatuses, type BasemapChange } from './geoEngineClient';
import { BASEMAP_CHOICES, basemapStatusOf, type BasemapStatus } from './geoStatus';
import { LIST_CLASS, ROW_CLASS } from './settingsList';

type Source = BasemapStatus['source'];

const TIANDITU_CONSOLE = 'https://console.tianditu.gov.cn/';


/** Writes `change`, telling the user when GeoEngine refuses it. */
const useChange = (text: BasemapText) => {
  const [busy, setBusy] = React.useState(false);
  const change = React.useCallback(async (next: BasemapChange) => {
    setBusy(true);
    const outcome = await configureBasemap(next);
    setBusy(false);
    if (!outcome.ok) toast.error(text.failed(outcome.reason));
    return outcome.ok;
  }, [text]);
  return { busy, change };
};

const Choices = <T extends string>({ label, values, names, chosen, onChoose, disabled }: {
  label: string;
  values: readonly T[];
  names: Record<T, string>;
  chosen: T;
  onChoose: (value: T) => void;
  disabled?: boolean;
}) => (
  <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={label}>
    <span className="typography-meta me-1 text-muted-foreground">{label}</span>
    {values.map((value) => (
      <Button
        key={value}
        type="button"
        role="radio"
        aria-checked={value === chosen}
        size="xs"
        variant={value === chosen ? 'default' : 'outline'}
        disabled={disabled}
        onClick={() => onChoose(value)}
      >
        {names[value]}
      </Button>
    ))}
  </div>
);

// As geoengine/src/basemap/index.ts checks them (Template, Key), here to tell the user before saving; change both together.
const URL_PATTERN = /^https?:\/\/(?=\S*\{z\})(?=\S*\{x\})(?=\S*\{y\})(?:[^\s{}]|\{[zxys]\})+$/;
const KEY_PATTERN = /^[A-Za-z0-9]+$/;

/** What a kind of basemap is set to, under its row; choosing there also chooses the kind. */
const Settings: React.FC<{ source: Source; status: BasemapStatus; text: BasemapText }> = ({ source, status, text }) => {
  const { busy, change } = useChange(text);
  const [key, setKey] = React.useState('');
  const [url, setUrl] = React.useState(status.custom?.url ?? '');
  const [credit, setCredit] = React.useState(status.custom?.attribution ?? '');

  if (source === 'openfreemap') {
    return <Choices label={text.style} values={BASEMAP_CHOICES.openfreemap} names={OPENFREEMAP_STYLES} chosen={status.openfreemap} disabled={busy} onChoose={(style) => void change({ source, openfreemap: style })} />;
  }
  if (source === 'versatiles') {
    return <Choices label={text.style} values={BASEMAP_CHOICES.versatiles} names={VERSATILES_STYLES} chosen={status.versatiles} disabled={busy} onChoose={(style) => void change({ source, versatiles: style })} />;
  }
  if (source === 'tianditu') {
    const typed = key.trim();
    return (
      <div className="space-y-2">
        <Choices
          label={text.layer}
          values={BASEMAP_CHOICES.tianditu}
          names={text.layers}
          chosen={status.tianditu.layer}
          disabled={busy || !status.tianditu.key}
          onChoose={(layer) => void change({ source, tianditu: { layer } })}
        />
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!typed) return;
            void change({ source, tianditu: { key: typed } }).then((ok) => ok && setKey(''));
          }}
        >
          <Input
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={status.tianditu.key ? text.keySaved : text.keyPlaceholder}
            aria-label={text.key}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-7 max-w-sm font-mono typography-meta"
          />
          <Button type="submit" variant="outline" size="xs" disabled={busy || !KEY_PATTERN.test(typed)}>
            {text.use}
          </Button>
        </form>
        <p className={SETTINGS_HELPER_CLASS}>
          {text.keyHelp[0]}
          <button type="button" onClick={() => { void openExternalUrl(TIANDITU_CONSOLE); }} className="text-[var(--primary-text)] hover:underline">
            {text.names.tianditu}
          </button>
          {text.keyHelp[1]}
        </p>
      </div>
    );
  }
  if (source === 'custom') {
    const address = url.trim();
    const invalid = address !== '' && !URL_PATTERN.test(address);
    return (
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!address || invalid) return;
          const attribution = credit.trim();
          void change({ source, custom: attribution ? { url: address, attribution } : { url: address } });
        }}
      >
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://…/{z}/{x}/{y}.png"
          aria-label={text.url}
          aria-invalid={invalid || undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-7 font-mono typography-meta"
        />
        <p className={cn(SETTINGS_HELPER_CLASS, invalid && 'text-[var(--status-error)]')}>{invalid ? text.urlInvalid : text.urlHelp}</p>
        <div className="flex items-center gap-2">
          <Input
            value={credit}
            onChange={(event) => setCredit(event.target.value)}
            placeholder={text.attribution}
            aria-label={text.attribution}
            className="h-7 max-w-sm typography-meta"
          />
          <Button type="submit" variant="outline" size="xs" disabled={busy || !address || invalid}>
            {text.use}
          </Button>
        </div>
        <p className={SETTINGS_HELPER_CLASS}>{text.attributionHelp}</p>
      </form>
    );
  }
  return null;
};

/** Ready to be drawn as soon as it is chosen: Tianditu needs a key first, a custom basemap its address. */
const readyOf = (source: Source, status: BasemapStatus) =>
  source === 'tianditu' ? Boolean(status.tianditu.key) : source === 'custom' ? Boolean(status.custom) : true;

/** The basemap's page of the Geo environment settings. */
export const BasemapDetails: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { locale } = useI18n();
  const text = basemapText(locale);
  const status = basemapStatusOf(useGeoStatuses());
  const { change } = useChange(text);
  // Shown as chosen until GeoEngine reports the choice it wrote; open, a kind not yet set up, to set it up.
  const [pending, setPending] = React.useState<Source | null>(null);
  const [opened, setOpened] = React.useState<Source | null>(null);
  const shown = pending ?? status?.source;
  React.useEffect(() => {
    if (pending !== null && status?.source === pending) setPending(null);
  }, [pending, status?.source]);

  const choose = async (source: Source) => {
    if (!status) return;
    setOpened(source);
    if (source === shown || !readyOf(source, status)) return;
    setPending(source);
    if (!(await change({ source }))) setPending(null);
  };

  return (
    <SettingsPageLayout title={text.title} titleLeading={<SettingsBackButton label={text.back} onClick={onBack} />}>
      <SettingsSection divider={false} title={text.title} description={text.description} settingsItem="geo-environment.basemap">
        {status?.invalid ? <p className="typography-meta mb-2 text-[var(--status-error)]">{status.invalid}</p> : null}
        {status && !status.available ? <p className="typography-meta mb-2 text-[var(--status-error)]">{text.missing}</p> : null}
        <div role="radiogroup" aria-label={text.title} className={LIST_CLASS}>
          {BASEMAP_CHOICES.sources.map((source) => {
            const selected = source === shown;
            const open = status && (selected || source === opened) && source !== 'offline' && source !== 'osm' && source !== 'none';
            return (
              <div key={source}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!status}
                  onClick={() => void choose(source)}
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
                  <span className="typography-ui-label shrink-0 font-medium text-foreground">{text.names[source]}</span>
                  <span className="typography-meta min-w-0 flex-1 truncate text-muted-foreground">{text.details[source]}</span>
                </button>
                {open ? (
                  <div className="px-3 pb-3 ps-10 pt-1">
                    <Settings source={source} status={status} text={text} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </SettingsSection>
    </SettingsPageLayout>
  );
};
