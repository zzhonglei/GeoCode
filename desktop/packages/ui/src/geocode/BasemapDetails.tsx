import React from 'react';
import type { StyleSpecification } from 'maplibre-gl';

import { Icon } from '@/components/icon/Icon';
import { SettingsBackButton } from '@/components/sections/shared/SettingsCards';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useBasemapStyle } from './basemap';
import { SWATCHES, type Swatch } from './basemapLooks';
import { BasemapPreview } from './BasemapPreview';
import { basemapLineOf, basemapText, OPENFREEMAP_STYLES, VERSATILES_STYLES, type BasemapText } from './basemapText';
import { configureBasemap, useGeoStatuses, type BasemapChange } from './geoEngineClient';
import { basemapFaultOf, basemapStatusOf, BASEMAP_CHOICES, type BasemapStatus } from './geoStatus';
import { LightPill } from './QgisDetails';
import { qgisText } from './qgisText';

type Source = BasemapStatus['source'];

const TIANDITU_CONSOLE = 'https://console.tianditu.gov.cn/';

// As geoengine/src/basemap/index.ts checks them (Template, Key), here to tell the user before saving; change both together.
const URL_PATTERN = /^https?:\/\/(?=\S*\{z\})(?=\S*\{x\})(?=\S*\{y\})(?:[^\s{}]|\{[zxys]\})+$/;
const KEY_PATTERN = /^[A-Za-z0-9]+$/;

type Group = keyof BasemapText['groups'];

/** The list's group of each kind of basemap: every kind has one, so a kind added cannot be left off the list. */
const GROUP = {
  offline: 'offline',
  openfreemap: 'online',
  versatiles: 'online',
  osm: 'online',
  tianditu: 'online',
  custom: 'other',
  none: 'other',
} satisfies Record<Source, Group>;

const GROUPS = (['offline', 'online', 'other'] satisfies Group[]).map((group) => ({
  group,
  sources: BASEMAP_CHOICES.sources.filter((source) => GROUP[source] === group),
}));

/** Ready to be drawn as soon as it is chosen: Tianditu needs a key first, a custom basemap its address. */
const readyOf = (source: Source, status: BasemapStatus) =>
  source === 'tianditu' ? status.tianditu.key !== undefined : source === 'custom' ? status.custom !== undefined : true;

/** The status with a change sent and not yet reported made to it, so a click shows at once. */
const withChange = (status: BasemapStatus, change: BasemapChange | null): BasemapStatus =>
  change
    ? {
      ...status,
      source: change.source ?? status.source,
      openfreemap: change.openfreemap ?? status.openfreemap,
      versatiles: change.versatiles ?? status.versatiles,
      tianditu: { ...status.tianditu, layer: change.tianditu?.layer ?? status.tianditu.layer },
    }
    : status;

/**
 * A change sent and not yet reported; `written`, the status as it stood once GeoEngine wrote it, as JSON. Any status
 * after that is the change's outcome, as when another window or a hand edit wrote the block meanwhile.
 */
type Pending = { change: BasemapChange; written: string | null };

/** Whether the status reports `change`: its key and address show only as having been set. */
const reports = (status: BasemapStatus, change: BasemapChange) =>
  (change.source === undefined || status.source === change.source)
  && (change.openfreemap === undefined || status.openfreemap === change.openfreemap)
  && (change.versatiles === undefined || status.versatiles === change.versatiles)
  && (change.tianditu?.layer === undefined || status.tianditu.layer === change.tianditu.layer);

/**
 * The basemap's settings page: every basemap and every style of one in a list, each row as tall as the others, and the
 * world as the chosen one draws it below. Tianditu's key and a custom address are set in dialogs, so the list never
 * grows; what keeps the basemap from being drawn is laid over the preview.
 */
export const BasemapDetails: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const { locale } = useI18n();
  const text = basemapText(locale);
  const reported = basemapStatusOf(useGeoStatuses());
  const style = useBasemapStyle();
  const [pending, setPending] = React.useState<Pending | null>(null);
  // The status as it stands, for a write's outcome to hold on to.
  const latest = React.useRef(reported);
  React.useEffect(() => {
    latest.current = reported;
  });
  // The style whose tiles did not load: a style read again starts with none failed.
  const [failedFor, setFailedFor] = React.useState<StyleSpecification | null>(null);
  const [dialog, setDialog] = React.useState<'key' | 'custom' | null>(null);

  React.useEffect(() => {
    if (!pending || !reported) return;
    if (reports(reported, pending.change) || (pending.written !== null && JSON.stringify(reported) !== pending.written)) setPending(null);
  }, [pending, reported]);

  // An online style that could not be read at all reads as null, as no basemap does.
  const unreachable = style === null || (style !== undefined && failedFor === style);
  // Not told while a change is written: what is wrong may be what it puts right.
  const fault = pending ? undefined : basemapFaultOf(reported, unreachable);
  const status = reported ? withChange(reported, pending?.change ?? null) : undefined;

  /** Writes `change`, telling the user when GeoEngine refuses it; true once it is written. Only its own outcome ends it. */
  const change = async (next: BasemapChange) => {
    setPending({ change: next, written: null });
    const outcome = await configureBasemap(next);
    if (outcome.ok) {
      setPending((current) => (current?.change === next ? { change: next, written: JSON.stringify(latest.current) } : current));
      return true;
    }
    setPending((current) => (current?.change === next ? null : current));
    toast.error(text.failed(outcome.reason));
    return false;
  };

  const choose = (source: Source) => {
    if (!status || source === status.source) return;
    // Not yet drawable, it opens its dialog instead, and is chosen once it is set up.
    if (readyOf(source, status)) void change({ source });
    else setDialog(source === 'tianditu' ? 'key' : 'custom');
  };

  const why = !fault
    ? undefined
    : fault === 'invalid'
      // GeoEngine's own words say where the block is wrong; it refuses every change until the file is put right.
      ? text.why.invalid(reported?.invalid ?? '')
      : fault === 'unreachable' && status?.source === 'tianditu' ? text.why.unreachableKey : text.why[fault];

  return (
    <SettingsPageLayout
      title={text.title}
      description={text.description}
      titleLeading={<SettingsBackButton label={text.back} onClick={onBack} />}
      titleAccessory={<LightPill light={status ? (fault ? 'failed' : 'ready') : undefined} text={qgisText(locale)} />}
    >
      <SettingsSection divider={false} settingsItem="geo-environment.basemap">
        <div role="radiogroup" aria-label={text.title} className="space-y-4">
          {GROUPS.map(({ group, sources }) => (
            <div key={group}>
              <p className="typography-micro mb-1.5 ms-1 font-semibold uppercase tracking-wide text-muted-foreground">{text.groups[group]}</p>
              <div className="oc-tile overflow-hidden rounded-xl">
                {sources.map((source) => (
                  <Row
                    key={source}
                    source={source}
                    status={status}
                    faulty={fault !== undefined}
                    text={text}
                    onChoose={() => choose(source)}
                    onChange={(next) => void change(next)}
                    onDialog={setDialog}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection title={text.preview} description={text.previewDescription}>
        <BasemapPreview
          style={style}
          none={status?.source === 'none'}
          name={basemapLineOf(status, text)}
          fault={fault}
          why={why}
          pending={pending !== null || (reported !== undefined && style === undefined)}
          text={text}
          onFailed={setFailedFor}
        />
      </SettingsSection>
      {status ? (
        <>
          <KeyDialog open={dialog === 'key'} text={text} onClose={() => setDialog(null)} onSave={(key) => change({ source: 'tianditu', tianditu: { key } })} />
          <CustomDialog
            open={dialog === 'custom'}
            current={status.custom}
            text={text}
            onClose={() => setDialog(null)}
            onUse={(custom) => change({ source: 'custom', custom })}
          />
        </>
      ) : null}
    </SettingsPageLayout>
  );
};

/** A row of the list: the radio, the name over one line, and what the basemap is set with on the right. */
const Row: React.FC<{
  source: Source;
  status: BasemapStatus | undefined;
  faulty: boolean;
  text: BasemapText;
  onChoose: () => void;
  onChange: (change: BasemapChange) => void;
  onDialog: (dialog: 'key' | 'custom') => void;
}> = ({ source, status, faulty, text, onChoose, onChange, onDialog }) => {
  const chosen = status?.source === source;
  // The address in place of the description, once there is one.
  const address = source === 'custom' ? status?.custom?.url : undefined;
  return (
    <div
      className={cn(
        'grid h-[62px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 pe-3.5 [&+&]:border-t [&+&]:border-[var(--interactive-border)]',
        chosen && 'bg-[color-mix(in_srgb,var(--primary-base)_7%,transparent)]',
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={chosen}
        disabled={!status}
        onClick={onChoose}
        className="flex h-full min-w-0 items-center gap-3 rounded-s-xl ps-3.5 text-start focus-visible:bg-[var(--interactive-hover)] focus-visible:outline-none"
      >
        <span
          aria-hidden
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-full border',
            chosen ? (faulty ? 'border-[var(--status-error)]' : 'border-[var(--primary-base)]') : 'border-[var(--interactive-border-hover)]',
          )}
        >
          {chosen ? <span className={cn('size-2 rounded-full', faulty ? 'bg-[var(--status-error)]' : 'bg-[var(--primary-base)]')} /> : null}
        </span>
        <span className="min-w-0">
          <span className="typography-ui-label block truncate font-semibold text-foreground">{text.names[source]}</span>
          <span className={cn('typography-micro block h-[17px] truncate leading-[17px] text-muted-foreground', address && 'font-mono')}>
            {address ?? text.descriptions[source]}
          </span>
        </span>
      </button>
      {status ? <Side source={source} status={status} text={text} onChange={onChange} onDialog={onDialog} /> : null}
    </div>
  );
};

/** What a row is set with: its styles or layers, Tianditu's key, a custom basemap's address. */
const Side: React.FC<{
  source: Source;
  status: BasemapStatus;
  text: BasemapText;
  onChange: (change: BasemapChange) => void;
  onDialog: (dialog: 'key' | 'custom') => void;
}> = ({ source, status, text, onChange, onDialog }) => {
  const chosen = status.source === source;
  if (source === 'openfreemap') {
    return (
      <Styles
        label={text.style}
        values={BASEMAP_CHOICES.openfreemap}
        names={OPENFREEMAP_STYLES}
        swatches={SWATCHES.openfreemap}
        current={status.openfreemap}
        chosen={chosen}
        onPick={(openfreemap) => onChange({ source, openfreemap })}
      />
    );
  }
  if (source === 'versatiles') {
    return (
      <Styles
        label={text.style}
        values={BASEMAP_CHOICES.versatiles}
        names={VERSATILES_STYLES}
        swatches={SWATCHES.versatiles}
        current={status.versatiles}
        chosen={chosen}
        onPick={(versatiles) => onChange({ source, versatiles })}
      />
    );
  }
  if (source === 'tianditu') {
    const keyed = status.tianditu.key !== undefined;
    return (
      <div className="flex items-center gap-1.5">
        <Styles
          label={text.layer}
          values={BASEMAP_CHOICES.tianditu}
          names={text.layers}
          swatches={SWATCHES.tianditu}
          current={status.tianditu.layer}
          chosen={chosen}
          disabled={!keyed}
          onPick={(layer) => onChange({ source, tianditu: { layer } })}
        />
        <Button
          variant="outline"
          size="xs"
          className={cn(!keyed && 'border-[var(--primary-base)] text-[var(--primary-text)]')}
          title={keyed ? text.keySaved : text.noKey}
          onClick={() => onDialog('key')}
        >
          <span aria-hidden className={cn('size-1.5 rounded-full', keyed ? 'bg-[var(--status-success)]' : 'bg-[var(--interactive-border-hover)]')} />
          Key
        </Button>
      </div>
    );
  }
  if (source === 'custom') {
    const set = status.custom !== undefined;
    return (
      <Button
        variant="outline"
        size="xs"
        className={cn(!set && 'border-[var(--primary-base)] text-[var(--primary-text)]')}
        onClick={() => onDialog('custom')}
      >
        {set ? text.edit : text.setAddress}
      </Button>
    );
  }
  return null;
};

/** A style's colours in a small disc, as an image: the app paints the paths of an SVG inside a button in the text's colour. */
const dotOf = (swatch: Swatch) =>
  `data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><clipPath id="c"><circle cx="8" cy="8" r="8"/></clipPath>'
      + `<g clip-path="url(#c)"><rect width="16" height="16" fill="${swatch.land}"/><path d="M0 10 C 4 8, 7 12, 10 16 L0 16 Z" fill="${swatch.water}"/>`
      + `<path d="M3 0 C 6 6, 11 7, 16 6" stroke="${swatch.road}" stroke-width="2.4" fill="none"/></g>`
      + '<circle cx="8" cy="8" r="7.5" fill="none" stroke="#000" stroke-opacity="0.12"/></svg>',
  )}`;

const Dot: React.FC<{ swatch: Swatch }> = ({ swatch }) => <img alt="" src={dotOf(swatch)} className="size-4 shrink-0" />;

/**
 * A basemap's styles, each with its colours: as buttons where the row has room for them, as a menu below @2xl, where
 * they would crowd its name. Picking one chooses the basemap too.
 */
const Styles = <T extends string>({ label, values, names, swatches, current, chosen, disabled = false, onPick }: {
  label: string;
  values: readonly T[];
  names: Record<T, string>;
  swatches: Record<T, Swatch>;
  current: T;
  chosen: boolean;
  disabled?: boolean;
  onPick: (value: T) => void;
}) => (
  <>
    <div className="hidden items-center gap-1.5 @2xl:flex" role="group" aria-label={label}>
      {values.map((value) => {
        const on = chosen && value === current;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onPick(value)}
            className={cn(
              'typography-micro inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border bg-[var(--surface-background)] ps-1 pe-2.5 text-foreground transition-colors disabled:cursor-default disabled:opacity-45',
              on ? 'border-[var(--primary-base)] font-semibold ring-1 ring-[var(--primary-base)]' : 'border-[var(--interactive-border-hover)] hover:border-muted-foreground',
            )}
          >
            <Dot swatch={swatches[value]} />
            {names[value]}
          </button>
        );
      })}
    </div>
    <div className="@2xl:hidden">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="xs" disabled={disabled} aria-label={label} className="gap-1.5 ps-1.5">
            <Dot swatch={swatches[current]} />
            {names[current]}
            <Icon name="arrow-down-s" className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-36">
          <DropdownMenuRadioGroup
            value={chosen ? current : null}
            onValueChange={(value) => {
              const picked = values.find((each) => each === value);
              if (picked !== undefined) onPick(picked);
            }}
          >
            {values.map((value) => (
              <DropdownMenuRadioItem key={value} value={value} closeOnClick className="items-center">
                <Dot swatch={swatches[value]} />
                {names[value]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </>
);

/** Tianditu's key, entered anew: the status tells only that one is saved, never the key. */
const KeyDialog: React.FC<{ open: boolean; text: BasemapText; onClose: () => void; onSave: (key: string) => Promise<boolean> }> = ({
  open,
  text,
  onClose,
  onSave,
}) => {
  const [key, setKey] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const typed = key.trim();
  React.useEffect(() => {
    if (open) setKey('');
  }, [open]);
  const save = async () => {
    if (!KEY_PATTERN.test(typed) || saving) return;
    setSaving(true);
    const saved = await onSave(typed);
    setSaving(false);
    if (saved) onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{text.keyTitle}</DialogTitle>
          <DialogDescription>{text.keyDescription}</DialogDescription>
        </DialogHeader>
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Input
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={text.keyPlaceholder}
            aria-label={text.keyTitle}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoFocus
            className="h-8 font-mono typography-meta"
          />
          <p className="typography-micro text-muted-foreground">
            {text.keyHelp[0]}
            <button type="button" onClick={() => { void openExternalUrl(TIANDITU_CONSOLE); }} className="text-[var(--primary-text)] hover:underline">
              {text.console}
            </button>
            {text.keyHelp[1]}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>{text.cancel}</Button>
            <Button type="submit" size="sm" disabled={!KEY_PATTERN.test(typed) || saving}>{text.save}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** A custom basemap's address and credit, starting from those set. */
const CustomDialog: React.FC<{
  open: boolean;
  current: BasemapStatus['custom'];
  text: BasemapText;
  onClose: () => void;
  onUse: (custom: { url: string; attribution?: string }) => Promise<boolean>;
}> = ({ open, current, text, onClose, onUse }) => {
  const [url, setUrl] = React.useState('');
  const [credit, setCredit] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  // Filled as it opens; by the strings, as the status is parsed anew whenever any environment's status changes.
  const savedUrl = current?.url ?? '';
  const savedCredit = current?.attribution ?? '';
  React.useEffect(() => {
    if (!open) return;
    setUrl(savedUrl);
    setCredit(savedCredit);
  }, [open, savedUrl, savedCredit]);
  const address = url.trim();
  const invalid = address !== '' && !URL_PATTERN.test(address);
  const usable = address !== '' && !invalid && !saving;
  const use = async () => {
    if (!usable) return;
    setSaving(true);
    const attribution = credit.trim();
    const used = await onUse(attribution ? { url: address, attribution } : { url: address });
    setSaving(false);
    if (used) onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{text.customTitle}</DialogTitle>
          <DialogDescription>{text.customDescription}</DialogDescription>
        </DialogHeader>
        <form className="space-y-1.5" onSubmit={(event) => { event.preventDefault(); void use(); }}>
          <label htmlFor="basemap-address" className="typography-ui-label block font-semibold text-foreground">{text.address}</label>
          <Input
            id="basemap-address"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://…/{z}/{x}/{y}.png"
            aria-invalid={invalid || undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoFocus
            className="h-8 font-mono typography-meta"
          />
          {/* Two lines' room, so the help giving way to an error while typing moves nothing below. */}
          <p className={cn('typography-micro line-clamp-2 h-8 leading-4', invalid ? 'text-[var(--status-error)]' : 'text-muted-foreground')}>
            {invalid ? text.addressInvalid : text.addressHelp}
          </p>
          <label htmlFor="basemap-credit" className="typography-ui-label block pt-1.5 font-semibold text-foreground">{text.credit}</label>
          <Input
            id="basemap-credit"
            value={credit}
            onChange={(event) => setCredit(event.target.value)}
            placeholder={text.creditPlaceholder}
            className="h-8 typography-meta"
          />
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>{text.cancel}</Button>
            <Button type="submit" size="sm" disabled={!usable}>{text.use}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
