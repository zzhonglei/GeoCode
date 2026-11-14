import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getCurrentIntlLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Action, Section } from './GeoTabs';
import { BY_CLASS, type GeoLook, type GeoStatistics, type Measured, type RasterDescription } from './previewClient';
import { unshownText, valueText, type PreviewText } from './previewText';
import { bandLook, BYTES, CHANNEL_NAMES, CHANNELS, classColour, PLAIN, rampColours, type Classes, type Range } from './rasterLook';

type Stretch = keyof PreviewText['stretches'];

/** The ranges a band is offered to be drawn between, by what they are called; `none` is for a band of bytes alone. */
const rangesOf = (band: Measured, bytes: boolean): [Stretch, Range | null][] => {
  const offered: [Stretch, Range | null][] = [
    ['cut', band.between],
    ['minmax', [band.min, band.max]],
    ['deviation', [band.mean - 2 * band.std, band.mean + 2 * band.std]],
  ];
  if (bytes) offered.push(['none', null]);
  return offered;
};

/** One band as the preview draws it: through `ramp`, between `range`, or as it is with none. */
const lookOf = (bands: number[], ramp: string, range: Range | null): GeoLook => {
  const look: GeoLook = { bands, ramp };
  if (range) look.ranges = [range];
  return look;
};

/** The colours of a band's classes side by side, the first few of them, as a strip stands for a ramp. */
const blocks = (classes: Classes): string => {
  const few = classes.slice(0, 6);
  return `linear-gradient(90deg, ${few.map((each, index) => `${classColour(each)} ${(index * 100) / few.length}% ${((index + 1) * 100) / few.length}%`).join(', ')})`;
};

/** A ramp as a strip from its low end to its high. */
const strip = (colours: readonly string[]): string => `linear-gradient(90deg, ${colours.join(', ')})`;

type Option<T extends string> = { value: T; label: string; off?: boolean; hint?: string };

/**
 * A few options side by side, one of them chosen, drawn as the settings draw such a choice (SettingsChipGroup): the
 * options in a recessed track and the chosen one raised out of it; smaller, as the panel's other controls are. An
 * option that is `off` keeps its place, greyed, and its `hint` says how it comes to be offered. Where they `fill` the
 * row, they share it on one line, each cut short rather than any of them falling to a line of its own.
 */
const Segments = <T extends string>({ label, value, options, fill, onValue }: { label: string; value: T; options: readonly Option<T>[]; fill?: boolean; onValue: (value: T) => void }) => (
  <div
    role="group"
    aria-label={label}
    className={cn(
      'oc-recessed items-center gap-0.5 rounded-lg bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-0.5',
      fill ? 'flex w-full' : 'inline-flex max-w-full flex-wrap',
    )}
  >
    {options.map((option) => {
      const chosen = option.value === value;
      return (
        <button
          key={option.value}
          type="button"
          aria-pressed={chosen}
          // Not disabled outright: a disabled button takes no pointer, and its hint would not show.
          aria-disabled={option.off || undefined}
          title={option.hint}
          className={cn(
            'h-5 whitespace-nowrap rounded-md typography-meta',
            fill ? 'min-w-0 flex-1 truncate px-1.5' : 'px-2',
            chosen
              ? 'oc-raised bg-[var(--surface-background)] text-foreground dark:bg-[var(--surface-elevated)]'
              : option.off ? 'cursor-default text-muted-foreground opacity-45' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => {
            if (!option.off && !chosen) onValue(option.value);
          }}
        >
          {option.label}
        </button>
      );
    })}
  </div>
);

/** The ramps and classes a band may be coloured by, each as the strip it is, the one it is coloured by marked and named. */
const Ramps: React.FC<{ value: string; offered: readonly { name: string; background: string }[]; text: PreviewText; onValue: (name: string) => void }> = ({ value, offered, text, onValue }) => (
  <Section title={text.ramp} aside={text.ramps[value] ?? value}>
    <div role="radiogroup" aria-label={text.ramp} className="flex flex-wrap gap-1.5 py-0.5">
      {offered.map(({ name, background }) => {
        const label = text.ramps[name] ?? name;
        return (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={name === value}
            aria-label={label}
            title={label}
            className={cn(
              'h-3.5 w-[30px] rounded-[3px] border border-[color-mix(in_srgb,var(--foreground)_18%,transparent)]',
              name === value && 'outline outline-2 outline-offset-1 outline-[var(--interactive-selection-foreground)]',
            )}
            style={{ background }}
            onClick={() => onValue(name)}
          />
        );
      })}
    </div>
  </Section>
);

/**
 * What a band or a picture is drawn between to choose, under its histogram and a title of its own, on one line
 * however narrow the panel: by short names, each saying in full what it is where it is pointed at.
 */
const StretchChoice: React.FC<{ value: Stretch; options: readonly Option<Stretch>[]; text: PreviewText; onValue: (value: Stretch) => void }> = ({ value, options, text, onValue }) => (
  <Section title={text.stretch}>
    <Segments
      label={text.stretch}
      value={value}
      options={options.map((option) => (option.value === 'custom' ? option : { ...option, hint: text.stretchHints[option.value] }))}
      fill
      onValue={onValue}
    />
  </Section>
);

/**
 * That a value may be a border of no data the file does not declare, `share` of the raster at its `least` end or its
 * greatest: told, with what to do about it, to take it for no data in the preview, or to say it is not.
 */
const Suspect: React.FC<{ value: number; share: number; least: boolean; text: PreviewText; onTake: () => void; onDismiss: () => void }> = ({ value, share, least, text, onTake, onDismiss }) => {
  const locale = getCurrentIntlLocale();
  // In the colours the app tells of something in (as its toasts do), the words across the whole of it and what to do
  // under them, so that neither squeezes the other.
  return (
    <div className="flex items-start gap-1.5 rounded-md border border-[color-mix(in_srgb,var(--status-info)_12%,transparent)] bg-[color-mix(in_srgb,var(--status-info)_5%,transparent)] py-1 pe-1 ps-2">
      <Icon name="information" className="mt-[5px] size-3.5 shrink-0 text-[var(--status-info)]" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5 py-1">
        <span>{text.blank.suspect(valueText(value, locale), share.toLocaleString(locale, { style: 'percent', maximumFractionDigits: 0 }), least)}</span>
        <Button variant="info" size="xs" onClick={onTake}>{text.blank.take}</Button>
      </div>
      <Action icon="close" label={text.blank.dismiss} onClick={onDismiss} />
    </div>
  );
};

const CHIP = 'inline-flex items-center rounded font-mono leading-[18px]';

/**
 * What the raster has no data by: the values its bands declare, and one the preview takes for no data besides them,
 * to add and to take back, which changes the preview alone and never the file.
 */
const Blanks: React.FC<{ description: RasterDescription; blank: number | null; text: PreviewText; onBlank: (blank: number | null) => void }> = ({ description, blank, text, onBlank }) => {
  const locale = getCurrentIntlLocale();
  const [adding, setAdding] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const declared = [...new Set(description.bands.flatMap((band) => (band.nodata === null ? [] : [band.nodata])))];
  return (
    <Section title={text.blank.title}>
      <div className="flex min-h-[26px] flex-wrap items-center gap-1.5">
        {declared.length === 0 ? <span className="text-muted-foreground">{text.blank.undeclared}</span> : null}
        {declared.map((value) => (
          <span key={value} title={text.blank.declared} className={cn(CHIP, 'px-1.5 bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)]')}>{valueText(value, locale)}</span>
        ))}
        {blank !== null ? (
          <span title={text.blank.only} className={cn(CHIP, 'bg-interactive-selection ps-1.5 text-interactive-selection-foreground')}>
            {valueText(blank, locale)}
            <span className="ms-1 font-sans text-[10px] opacity-85">{text.blank.preview}</span>
            <button type="button" aria-label={text.blank.remove} title={text.blank.remove} className="inline-flex size-[18px] items-center justify-center opacity-70 hover:opacity-100" onClick={() => onBlank(null)}>
              <Icon name="close" className="size-3" />
            </button>
          </span>
        ) : adding ? (
          <form
            className={cn(CHIP, 'ps-1.5 ring-1 ring-[var(--interactive-selection-foreground)]')}
            onSubmit={(event) => {
              event.preventDefault();
              const value = Number(typed);
              if (typed.trim() === '' || !Number.isFinite(value)) return;
              setAdding(false);
              onBlank(value);
            }}
          >
            <input
              // Opened to be typed in.
              autoFocus
              value={typed}
              inputMode="decimal"
              aria-label={text.blank.value}
              placeholder={text.blank.value}
              className="w-14 bg-transparent font-mono leading-[18px] text-foreground outline-none"
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setAdding(false);
              }}
            />
            <button type="submit" aria-label={text.blank.confirm} title={text.blank.confirm} className="inline-flex size-[18px] items-center justify-center text-[var(--interactive-selection-foreground)]">
              <Icon name="check" className="size-3" />
            </button>
          </form>
        ) : (
          <Action icon="add" label={text.blank.add} onClick={() => setAdding(true)} />
        )}
      </div>
    </Section>
  );
};

/**
 * How a band's values are spread, with the two lines the band is drawn between, each to be dragged, and under it
 * the ramp as the map has it: its colours run between the lines, and past them it is the colour of its end, so the
 * strip is the map's legend as well. The lines follow the pointer; `onRange` is told where they are when it lets go,
 * which is when the map is drawn again.
 */
const Spread: React.FC<{ band: Measured; range: Range; colours: readonly string[]; onRange: (range: Range) => void }> = ({ band, range, colours, onRange }) => {
  const locale = getCurrentIntlLocale();
  const [held, setHeld] = React.useState<{ end: 0 | 1; range: Range } | null>(null);
  const [low, high] = held?.range ?? range;
  const span = band.max > band.min ? band.max - band.min : 1;
  // Where a value lies along the band's own range, in hundredths, and where its line is drawn: within the range.
  const along = (value: number) => ((value - band.min) / span) * 100;
  const place = (value: number) => Math.min(100, Math.max(0, along(value)));
  const [from, to] = [place(low), place(high)];
  // Their square roots: a band's most common value, as the sea is in a model of heights, would else flatten the rest.
  const peak = Math.sqrt(Math.max(1, ...band.counts));
  // Each step at its middle, along the band's range, where its steps run from and to.
  const [first, last] = band.edges;
  const step = (last - first) / Math.max(1, band.counts.length);
  const outline = band.counts.map((count, index) => `L${along(first + (index + 0.5) * step)} ${100 - (96 * Math.sqrt(count)) / peak}`).join(' ');
  // The ramp runs from the low value to the high even where those lie outside the band's range, as two deviations
  // about a mean may: the strip then shows the part of the ramp the map is drawn in.
  const between = colours.map((colour, index) => `${colour} ${along(low) + ((along(high) - along(low)) * index) / Math.max(1, colours.length - 1)}%`);
  const valueAt = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return band.min + (Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * span);
  };
  const moved = (end: 0 | 1, value: number): Range => (end === 0 ? [Math.min(value, high), high] : [low, Math.max(value, low)]);

  return (
    <div className="flex flex-col">
      <div
        className="relative h-[72px] cursor-ew-resize touch-none"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const value = valueAt(event);
          // The line nearer the pointer.
          const end = Math.abs(value - low) <= Math.abs(value - high) ? 0 : 1;
          setHeld({ end, range: moved(end, value) });
        }}
        onPointerMove={(event) => {
          if (held) setHeld({ end: held.end, range: moved(held.end, valueAt(event)) });
        }}
        onPointerUp={() => {
          if (held) onRange(held.range);
          setHeld(null);
        }}
        onPointerCancel={() => setHeld(null)}
      >
        <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" className="block h-full w-full text-foreground">
          <path d={`M${along(first)} 100 ${outline} L${along(last)} 100 Z`} fill="currentColor" fillOpacity={0.13} stroke="currentColor" strokeOpacity={0.5} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="absolute inset-y-0 start-0 bg-background opacity-65" style={{ width: `${from}%` }} />
        <div className="absolute inset-y-0 end-0 bg-background opacity-65" style={{ width: `${100 - to}%` }} />
        <div className="absolute inset-y-0 w-px bg-foreground" style={{ left: `${from}%` }} />
        <div className="absolute inset-y-0 w-px bg-foreground" style={{ left: `${to}%` }} />
      </div>
      <div aria-hidden="true" className="h-2" style={{ background: `linear-gradient(90deg, ${between.join(', ')})` }} />
      <div className="relative h-[30px] font-mono text-[11px] text-foreground">
        {[from, to].map((at, index) => (
          <div key={index} aria-hidden="true" className="absolute top-0.5 size-0 -translate-x-1/2 border-x-[4.5px] border-b-[6px] border-x-transparent border-b-foreground" style={{ left: `${at}%` }} />
        ))}
        {/* Each kept within the strip, where a line stands at its end. */}
        <div className="absolute top-[11px] whitespace-nowrap" style={{ left: `${from}%`, transform: `translateX(-${from}%)` }}>{valueText(low, locale)}</div>
        <div className="absolute top-[11px] whitespace-nowrap" style={{ left: `${to}%`, transform: `translateX(-${to}%)` }}>{valueText(high, locale)}</div>
      </div>
    </div>
  );
};

/**
 * A band's classes, each with its colour and how much of the raster is of it, `sampled` where that is of a sample.
 * A class without a name, as most rasters of classes bring none, has a bar of its share where the name would be.
 */
const ClassList: React.FC<{ classes: Classes; sampled: boolean; text: PreviewText }> = ({ classes, sampled, text }) => {
  const locale = getCurrentIntlLocale();
  const most = Math.max(...classes.map((each) => each.share));
  return (
    <div>
      {classes.map((each) => (
        <div key={each.value} className="flex items-center gap-2.5 border-b border-edge-muted py-1.5 last:border-b-0">
          <span aria-hidden="true" className="size-3.5 shrink-0 rounded-[3px] border border-edge-muted" style={{ backgroundColor: classColour(each) }} />
          <span className="w-10 shrink-0 font-mono tabular-nums text-foreground">{each.value}</span>
          <span className="min-w-0 flex-1 truncate text-foreground">
            {each.name ?? (
              <span aria-hidden="true" className="block h-1.5 rounded-full bg-[color-mix(in_srgb,var(--foreground)_22%,transparent)]" style={{ width: `${most > 0 ? Math.max(2, (each.share / most) * 100) : 2}%` }} />
            )}
          </span>
          <span className="w-12 shrink-0 text-end font-mono tabular-nums text-muted-foreground">{(each.share * 100).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</span>
        </div>
      ))}
      {sampled ? <div className="py-1.5 text-[11px] text-muted-foreground">{text.sampled}</div> : null}
    </div>
  );
};

/** How one band is drawn, in parts a wide panel lays side by side: see `oneBand`. */
type Drawing = { ramps: React.ReactNode; rest: React.ReactNode; listed: boolean };

/**
 * One band as it is drawn and measured: the ramps and classes it may be coloured by to choose, and then either the
 * range it is drawn between, to drag or to choose, with what is measured of it, or the list of its classes, which is
 * `listed` to stand apart where there is room. `classes` are this band's, none of a band that has none; `dragged` is
 * the range its lines were last dragged to, offered to go back to.
 */
const oneBand = ({ number, bytes, statistics, classes, look, dragged, text, onLook, onDragged }: {
  number: number;
  bytes: boolean;
  statistics: GeoStatistics;
  classes: Classes | null;
  look: GeoLook | null;
  dragged: Range | undefined;
  text: PreviewText;
  onLook: (look: GeoLook) => void;
  onDragged: (band: number, range: Range) => void;
}): Drawing => {
  const locale = getCurrentIntlLocale();
  const band = statistics.bands[number - 1];
  if (!band) return { ramps: null, rest: <div className="text-muted-foreground">{text.bandEmpty}</div>, listed: false };

  const offered = rangesOf(band, bytes);
  const { ramp, classed, range } = bandLook(band, classes, look);
  const stretch = range === null ? 'none' : (offered.find(([, each]) => each && each[0] === range[0] && each[1] === range[1])?.[0] ?? 'custom');
  const colours = rampColours(statistics, ramp);
  const bands = [number];
  const ramps = (
    <Ramps
      value={ramp}
      offered={[...(classes ? [{ name: BY_CLASS, background: blocks(classes) }] : []), ...Object.entries(statistics.ramps).map(([name, each]) => ({ name, background: strip(each) }))]}
      text={text}
      onValue={(chosen) => onLook(lookOf(bands, chosen, range))}
    />
  );
  if (classed && classes) return { ramps, rest: <ClassList classes={classes} sampled={statistics.sampled ?? false} text={text} />, listed: true };

  const options: Option<Stretch>[] = [
    ...offered.map(([name]) => ({ value: name, label: text.stretches[name] })),
    { value: 'custom', label: text.stretches.custom, off: !dragged, hint: dragged ? text.custom.back : text.custom.hint },
  ];
  return {
    ramps,
    listed: false,
    rest: (
      <>
        <Spread
          band={band}
          range={range ?? BYTES}
          colours={colours}
          onRange={(moved) => {
            onDragged(number, moved);
            onLook(lookOf(bands, ramp, moved));
          }}
        />
        <StretchChoice
          value={stretch}
          options={options}
          text={text}
          onValue={(chosen) => {
            if (chosen === 'custom') {
              if (dragged) onLook(lookOf(bands, ramp, dragged));
              return;
            }
            const found = offered.find(([name]) => name === chosen);
            if (found) onLook(lookOf(bands, ramp, found[1]));
          }}
        />
        <div className="mt-2.5 grid grid-cols-4 gap-2 border-t border-edge-muted pt-2.5">
          {(['min', 'max', 'mean', 'std'] as const).map((measure) => (
            <div key={measure} className="flex min-w-0 flex-col gap-px">
              <div className="truncate text-[11px] text-muted-foreground">{text.measures[measure]}</div>
              <div className="truncate font-mono text-foreground">{valueText(band[measure], locale)}</div>
            </div>
          ))}
        </div>
        <div className="pt-2 text-[11px] text-muted-foreground">{text.sampled}</div>
      </>
    ),
  };
};

/** Three bands as a picture: each band's range by what it is called, or none of them where they are drawn as they are. */
const pictureOf = (bands: number[], statistics: GeoStatistics, stretch: Stretch): GeoLook => {
  const look: GeoLook = { bands };
  if (stretch === 'none') return look;
  look.ranges = bands.map((number): Range => {
    const band = statistics.bands[number - 1];
    // A band without data is drawn between anything.
    return (band && rangesOf(band, false).find(([name]) => name === stretch)?.[1]) || [0, 1];
  });
  return look;
};

/** How the values of the three bands of a picture are spread, a line each in the colour the band is drawn as, along one scale. */
const Spreads: React.FC<{ bands: (Measured | null)[] }> = ({ bands }) => {
  const known = bands.flatMap((band) => (band ? [band] : []));
  if (known.length === 0) return <div className="h-[72px]" />;
  const least = Math.min(...known.map((band) => band.min));
  const span = Math.max(...known.map((band) => band.max)) - least || 1;
  const peak = Math.sqrt(Math.max(1, ...known.flatMap((band) => band.counts)));
  return (
    <svg aria-hidden="true" viewBox="0 0 256 100" preserveAspectRatio="none" className="block h-[72px] w-full">
      {bands.map((band, channel) => {
        if (!band) return null;
        const step = (band.edges[1] - band.edges[0]) / Math.max(1, band.counts.length);
        const line = band.counts.map((count, index) => `${index === 0 ? 'M' : 'L'}${((band.edges[0] + (index + 0.5) * step - least) / span) * 256} ${100 - (96 * Math.sqrt(count)) / peak}`).join(' ');
        return <path key={channel} d={line} fill="none" stroke={CHANNELS[channel]} strokeWidth={1.25} vectorEffect="non-scaling-stroke" />;
      })}
    </svg>
  );
};

/** Whether two pictures are drawn between the same values. */
const sameRanges = (one: GeoLook, other: GeoLook): boolean => JSON.stringify(one.ranges ?? null) === JSON.stringify(other.ranges ?? null);

/** What a picture is offered to be drawn between, by what it is called, and which of those it is drawn between. */
type Stretches = { kinds: Stretch[]; stretch: Stretch };

const stretchesOf = (description: RasterDescription, statistics: GeoStatistics, look: GeoLook): Stretches => {
  const bytes = look.bands.every((number) => description.bands[number - 1]?.type === 'Byte');
  const kinds: Stretch[] = bytes ? ['cut', 'minmax', 'deviation', 'none'] : ['cut', 'minmax', 'deviation'];
  return { kinds, stretch: kinds.find((kind) => sameRanges(pictureOf(look.bands, statistics, kind), look)) ?? 'cut' };
};

/** A raster of several bands as a picture of three of them: how their values are spread, and what they are drawn between to choose. */
const Picture: React.FC<{ description: RasterDescription; statistics: GeoStatistics; look: GeoLook; text: PreviewText; onLook: (look: GeoLook) => void }> = ({ description, statistics, look, text, onLook }) => {
  const { kinds, stretch } = stretchesOf(description, statistics, look);
  return (
    <div className="flex flex-col gap-2">
      <Spreads bands={look.bands.map((number) => statistics.bands[number - 1] ?? null)} />
      <StretchChoice value={stretch} options={kinds.map((kind) => ({ value: kind, label: text.stretches[kind] }))} text={text} onValue={(chosen) => onLook(pictureOf(look.bands, statistics, chosen))} />
      <div className="text-[11px] text-muted-foreground">{text.sampled}</div>
    </div>
  );
};

/**
 * The bands of a raster, a row each with what is measured of it, in which the bands drawn are chosen: as red, green
 * or blue by the marks in a band's row where three are drawn as a picture, else by the band's row itself. A band is
 * named by its number and by the colour the file says it holds, where it says one.
 */
const BandTable: React.FC<{
  description: RasterDescription;
  statistics: GeoStatistics;
  drawn: readonly number[];
  composite: boolean;
  text: PreviewText;
  onChannel: (channel: 0 | 1 | 2, band: number) => void;
  onBand: (band: number) => void;
}> = ({ description, statistics, drawn, composite, text, onChannel, onBand }) => {
  const locale = getCurrentIntlLocale();
  const head = 'border-b border-edge-muted px-1 py-1 font-normal text-muted-foreground';
  const cell = 'border-b border-edge-muted px-1 py-1';
  const mark = 'size-3 rounded-full border border-[color-mix(in_srgb,var(--foreground)_30%,transparent)] align-middle';
  return (
    <table className="w-full border-collapse font-mono text-[11px] [&_tr:last-child>td]:border-b-0">
      <thead>
        <tr>
          <th scope="col" className={cn(head, 'text-start')}>{text.band}</th>
          {composite
            ? CHANNEL_NAMES.map((name) => <th key={name} scope="col" className={cn(head, 'w-4 px-0.5 text-center')}>{name}</th>)
            : <th scope="col" className={cn(head, 'w-10 text-center')}>{text.columns.drawn}</th>}
          <th scope="col" className={cn(head, 'text-end')}>{text.columns.low}</th>
          <th scope="col" className={cn(head, 'text-end')}>{text.columns.high}</th>
          <th scope="col" className={cn(head, 'text-end')}>{text.columns.mean}</th>
        </tr>
      </thead>
      <tbody>
        {description.bands.map((each, index) => {
          const number = index + 1;
          const band = statistics.bands[index];
          const chosen = !composite && drawn[0] === number;
          return (
            <tr
              key={number}
              className={cn(!composite && 'cursor-pointer hover:bg-[var(--interactive-hover)]', chosen && 'bg-interactive-selection hover:bg-interactive-selection')}
              onClick={composite || chosen ? undefined : () => onBand(number)}
            >
              {/* The band's name whole: the marks beside it give up their room first, as narrow as their dots. */}
              <td className={cn(cell, 'whitespace-nowrap text-foreground')}>
                {number}
                {each.color === 'Undefined' ? null : <span className="ms-1.5 font-sans text-muted-foreground">{each.color}</span>}
              </td>
              {composite ? (
                ([0, 1, 2] as const).map((channel) => {
                  const given = drawn[channel] === number;
                  return (
                    <td key={channel} className={cn(cell, 'px-0.5 text-center')}>
                      <button
                        type="button"
                        aria-label={text.bandAs(number, channel)}
                        title={text.bandAs(number, channel)}
                        aria-pressed={given}
                        className={mark}
                        style={given ? { backgroundColor: CHANNELS[channel], borderColor: CHANNELS[channel] } : undefined}
                        onClick={() => onChannel(channel, number)}
                      />
                    </td>
                  );
                })
              ) : (
                <td className={cn(cell, 'text-center')}>
                  <button
                    type="button"
                    aria-label={text.bandAlone(number)}
                    title={text.bandAlone(number)}
                    aria-pressed={chosen}
                    className={mark}
                    style={chosen ? { backgroundColor: 'var(--interactive-selection-foreground)', borderColor: 'var(--interactive-selection-foreground)' } : undefined}
                    onClick={(event) => {
                      // The row would choose it as well.
                      event.stopPropagation();
                      if (!chosen) onBand(number);
                    }}
                  />
                </td>
              )}
              {(['low', 'high', 'mean'] as const).map((measure) => (
                <td key={measure} className={cn(cell, 'truncate text-end tabular-nums text-foreground')}>{band ? valueText(band[measure], locale) : ''}</td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

/**
 * How a raster is drawn, and what is measured of it. `measured` is what the reader measured or the code it was
 * refused with, none while it is being read; `look` is how the preview has the raster drawn, none while that is left
 * to the reader, and `onLook` changes it; `dragged` is the range each band's lines were last dragged to, told to
 * `onDragged`. A raster of several bands is drawn as a picture of three of them or as one of them alone, chosen in
 * the table of its bands; one band is drawn and chosen for as a raster of one band is. Where the panel is wide, the
 * bands stand on one side and how they are drawn on the other. Under them is what the raster has no data by, with
 * `blank`, the value the preview takes for no data besides, changed by `onBlank`; above how it is drawn, a hint of a
 * border of no data the file does not declare, until `onDismiss` says it is not one.
 */
export const LookTab: React.FC<{
  description: RasterDescription;
  measured: { statistics: GeoStatistics } | { code: string } | null;
  look: GeoLook | null;
  dragged: ReadonlyMap<number, Range>;
  blank: number | null;
  /** Whether a border of no data the file does not declare is still to be hinted at, where one is suspected. */
  hinted: boolean;
  text: PreviewText;
  onLook: (look: GeoLook) => void;
  onDragged: (band: number, range: Range) => void;
  onBlank: (blank: number | null) => void;
  onDismiss: () => void;
}> = ({ description, measured, look, dragged, blank, hinted, text, onLook, onDragged, onBlank, onDismiss }) => {
  if (measured === null) return <div className="p-3 typography-meta text-muted-foreground">{text.reading}</div>;
  if ('code' in measured) return <div className="p-3 typography-meta text-muted-foreground">{unshownText(text, measured.code)}</div>;
  const statistics = measured.statistics;
  const drawn = look?.bands ?? description.shown;
  const number = drawn[0] ?? 1;
  const bytes = (band: number) => description.bands[band - 1]?.type === 'Byte';
  const several = description.bands.length > 1;
  // Left to the reader, three bands of bytes are a picture drawn as it is, and any others are drawn between the
  // first of the ranges offered.
  const picture = look ?? pictureOf(description.shown, statistics, description.shown.every(bytes) ? 'none' : 'cut');
  const composite = drawn.length > 1;
  // A band chosen alone keeps the ramp it was coloured by, but not classes, which are another band's.
  const alone = (band: number): GeoLook => lookOf([band], look?.ramp && look.ramp !== BY_CLASS ? look.ramp : PLAIN, statistics.bands[band - 1]?.between ?? null);

  // A picture takes three bands.
  const modes = description.bands.length >= 3 ? (
    <Segments
      label={text.mode}
      value={composite ? 'composite' : 'single'}
      options={[{ value: 'composite', label: text.modes.composite }, { value: 'single', label: text.modes.single }]}
      onValue={(chosen) => onLook(chosen === 'single' ? alone(number) : pictureOf(description.shown.length === 3 ? description.shown : [1, 2, 3], statistics, description.shown.every(bytes) ? 'none' : 'cut'))}
    />
  ) : null;
  const drawing: Drawing = composite
    ? { ramps: null, rest: <Picture description={description} statistics={statistics} look={picture} text={text} onLook={onLook} />, listed: false }
    : oneBand({
        number,
        bytes: bytes(number),
        statistics,
        // The classes the reader found are those of the band it draws by default, and it draws by them that band alone.
        classes: number === description.shown[0] ? (statistics.classes ?? null) : null,
        look,
        dragged: dragged.get(number),
        text,
        onLook,
        onDragged,
      });
  const column = 'flex min-w-0 flex-col gap-3';
  const suspect = hinted ? statistics.suspect : undefined;
  const hint = suspect ? (
    <Suspect
      value={suspect.value}
      share={suspect.share}
      least={suspect.value <= (statistics.bands[drawn[0] - 1]?.min ?? suspect.value)}
      text={text}
      onTake={() => onBlank(suspect.value)}
      onDismiss={onDismiss}
    />
  ) : null;
  const blanks = <Blanks description={description} blank={blank} text={text} onBlank={onBlank} />;

  return (
    <ScrollableOverlay outerClassName="h-full min-h-0" className="@container p-3 typography-meta">
      <div className="grid gap-x-6 gap-y-3 @[34rem]:grid-cols-2">
        {several ? (
          <>
            <div className={column}>
              {modes ? <div>{modes}</div> : null}
              <BandTable
                description={description}
                statistics={statistics}
                drawn={drawn}
                composite={composite}
                text={text}
                // The picture keeps what it is drawn between, of the band given in place of another as well.
                onChannel={(channel, band) => onLook(pictureOf(picture.bands.map((each, at) => (at === channel ? band : each)), statistics, stretchesOf(description, statistics, picture).stretch))}
                onBand={(band) => onLook(alone(band))}
              />
              <div className="hidden @[34rem]:block">{blanks}</div>
            </div>
            <div className={column}>
              {hint}
              {drawing.ramps}
              <div className="flex min-w-0 flex-col">{drawing.rest}</div>
              <div className="@[34rem]:hidden">{blanks}</div>
            </div>
          </>
        ) : drawing.listed ? (
          <>
            <div className={column}>
              {drawing.ramps}
              <div className="hidden @[34rem]:block">{blanks}</div>
            </div>
            <div className={column}>
              {hint}
              {drawing.rest}
              <div className="@[34rem]:hidden">{blanks}</div>
            </div>
          </>
        ) : (
          <>
            <div className={column}>
              {hint}
              {drawing.ramps}
              <div className="flex min-w-0 flex-col">{drawing.rest}</div>
            </div>
            <div className={column}>{blanks}</div>
          </>
        )}
      </div>
    </ScrollableOverlay>
  );
};
