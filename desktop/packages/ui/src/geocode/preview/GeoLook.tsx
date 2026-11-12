import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getCurrentIntlLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { BY_CLASS, type GeoLook, type GeoStatistics, type Measured, type RasterDescription } from './previewClient';
import { unshownText, type PreviewText } from './previewText';

type Range = [number, number];
type Stretch = keyof PreviewText['stretches'];

// The ramp a band is drawn through when the preview names none.
const PLAIN = 'grey';
// What a band of bytes is drawn between when it is drawn as it is.
const BYTES: Range = [0, 255];

/** A value of a band as it is read out: whole where it is large, with the decimals that tell small ones apart. */
const figure = (value: number, locale: string): string => {
  const size = Math.abs(value);
  return value.toLocaleString(locale, { maximumFractionDigits: size >= 100 ? 0 : size >= 1 ? 2 : 4 });
};

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

type Classes = NonNullable<GeoStatistics['classes']>;

const colourOf = (each: Classes[number]): string => `rgb(${each.color.slice(0, 3).join(' ')} / ${(each.color[3] ?? 255) / 255})`;

/** The colours of a band's classes side by side, the first few of them, as a strip stands for a ramp. */
const blocks = (classes: Classes): string => {
  const few = classes.slice(0, 6);
  return `linear-gradient(90deg, ${few.map((each, index) => `${colourOf(each)} ${(index * 100) / few.length}% ${((index + 1) * 100) / few.length}%`).join(', ')})`;
};

/** A ramp as a strip from its low end to its high. */
const strip = (colours: readonly string[]): string => `linear-gradient(90deg, ${colours.join(', ')})`;

const Choice: React.FC<{ label: string; value: string; onValue: (value: string) => void; shown: React.ReactNode; children: React.ReactNode }> = ({ label, value, onValue, shown, children }) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild nativeButton={false}>
      <div className={cn(dropdownTriggerVariants(), 'w-fit min-w-0 shrink-0')} title={label}>
        {shown}
        <Icon name="arrow-down-s" />
      </div>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start">
      <DropdownMenuRadioGroup value={value} onValueChange={(chosen) => onValue(String(chosen))}>
        {children}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>
);

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
  const outline = band.counts.map((count, index) => `L${index + 0.5} ${100 - (96 * Math.sqrt(count)) / peak}`).join(' ');
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
        <svg aria-hidden="true" viewBox="0 0 256 100" preserveAspectRatio="none" className="block h-full w-full text-foreground">
          <path d={`M0 100 ${outline} L256 100 Z`} fill="currentColor" fillOpacity={0.13} stroke="currentColor" strokeOpacity={0.5} strokeWidth={1} vectorEffect="non-scaling-stroke" />
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
        <div className="absolute top-[11px] whitespace-nowrap" style={{ left: `${from}%`, transform: `translateX(-${from}%)` }}>{figure(low, locale)}</div>
        <div className="absolute top-[11px] whitespace-nowrap" style={{ left: `${to}%`, transform: `translateX(-${to}%)` }}>{figure(high, locale)}</div>
      </div>
    </div>
  );
};

/** A band's classes, each with its colour and how much of the raster is of it; `sampled` where that is of a sample. */
const ClassList: React.FC<{ classes: Classes; sampled: boolean; text: PreviewText }> = ({ classes, sampled, text }) => {
  const locale = getCurrentIntlLocale();
  return (
    <>
      {classes.map((each) => (
        <div key={each.value} className="flex items-center gap-2.5 border-b border-edge-muted py-1.5 last:border-b-0">
          <span aria-hidden="true" className="size-3.5 shrink-0 rounded-[3px] border border-edge-muted" style={{ backgroundColor: colourOf(each) }} />
          <span className="w-10 shrink-0 font-mono tabular-nums text-foreground">{each.value}</span>
          <span className="min-w-0 flex-1 truncate text-foreground">{each.name ?? ''}</span>
          <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{(each.share * 100).toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</span>
        </div>
      ))}
      {sampled ? <div className="py-1.5 text-[11px] text-muted-foreground">{text.sampled}</div> : null}
    </>
  );
};

/**
 * One band as it is drawn and measured: its ramp or its classes and the range it is drawn between to choose, its
 * histogram or the list of its classes, and what is measured of it. `classes` are this band's, none of a band that
 * has none. `lead` goes above, where the band is one of several.
 */
const OneBand: React.FC<{
  number: number;
  bytes: boolean;
  statistics: GeoStatistics;
  classes: Classes | null;
  look: GeoLook | null;
  text: PreviewText;
  lead?: React.ReactNode;
  onLook: (look: GeoLook) => void;
}> = ({ number, bytes, statistics, classes, look, text, lead, onLook }) => {
  const locale = getCurrentIntlLocale();
  const band = statistics.bands[number - 1];
  if (!band) return <>{lead}<div className="text-muted-foreground">{text.unshown.empty}</div></>;

  const offered = rangesOf(band, bytes);
  // Left to the reader, a band is drawn by its classes where it has them, else between the first of the ranges offered.
  const ramp = look?.ramp ?? (classes ? BY_CLASS : PLAIN);
  const classed = classes !== null && ramp === BY_CLASS;
  const range = look && !classed ? (look.ranges?.[0] ?? null) : band.between;
  const stretch = range === null ? 'none' : (offered.find(([, each]) => each && each[0] === range[0] && each[1] === range[1])?.[0] ?? 'custom');
  const colours = statistics.ramps[ramp] ?? statistics.ramps[PLAIN] ?? ['#000000', '#ffffff'];
  const bands = [number];

  return (
    <>
      {lead}
      <div className="flex items-center justify-between gap-2 pb-3">
        <Choice
          label={text.ramp}
          value={ramp}
          onValue={(chosen) => onLook(lookOf(bands, chosen, range))}
          shown={<><span aria-hidden="true" className="h-2 w-[34px] shrink-0 rounded-sm" style={{ background: classed ? blocks(classes) : strip(colours) }} /><span className="truncate">{text.ramps[ramp] ?? ramp}</span></>}
        >
          {classes ? (
            <DropdownMenuRadioItem value={BY_CLASS}>
              <span aria-hidden="true" className="h-2 w-12 shrink-0 rounded-sm" style={{ background: blocks(classes) }} />
              {text.ramps[BY_CLASS]}
            </DropdownMenuRadioItem>
          ) : null}
          {Object.entries(statistics.ramps).map(([name, each]) => (
            <DropdownMenuRadioItem key={name} value={name}>
              <span aria-hidden="true" className="h-2 w-12 shrink-0 rounded-sm" style={{ background: strip(each) }} />
              {text.ramps[name] ?? name}
            </DropdownMenuRadioItem>
          ))}
        </Choice>
        {classed ? null : (
          <Choice
            label={text.stretch}
            value={stretch}
            onValue={(chosen) => {
              const found = offered.find(([name]) => name === chosen);
              if (found) onLook(lookOf(bands, ramp, found[1]));
            }}
            shown={<span className="truncate">{text.stretches[stretch]}</span>}
          >
            {offered.map(([name]) => (
              <DropdownMenuRadioItem key={name} value={name}>{text.stretches[name]}</DropdownMenuRadioItem>
            ))}
          </Choice>
        )}
      </div>
      {classed ? (
        <ClassList classes={classes} sampled={statistics.sampled ?? false} text={text} />
      ) : (
        <>
          <Spread band={band} range={range ?? BYTES} colours={colours} onRange={(dragged) => onLook(lookOf(bands, ramp, dragged))} />
          <div className="mt-1.5 grid grid-cols-4 gap-2 border-t border-edge-muted pt-2.5">
            {(['min', 'max', 'mean', 'std'] as const).map((measure) => (
              <div key={measure} className="flex min-w-0 flex-col gap-px">
                <div className="truncate text-[11px] text-muted-foreground">{text.measures[measure]}</div>
                <div className="truncate font-mono text-foreground">{figure(band[measure], locale)}</div>
              </div>
            ))}
          </div>
          <div className="pt-2 text-[11px] text-muted-foreground">{text.sampled}</div>
        </>
      )}
    </>
  );
};

// What the three bands of a picture are drawn as, and the colours their lines and marks are drawn in: these are of
// the data, as the colours of a ramp are.
const CHANNELS = ['#e03131', '#2f9e44', '#1971c2'] as const;
const CHANNEL_NAMES = ['R', 'G', 'B'] as const;

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
        const step = (band.max - band.min || 1) / band.counts.length;
        const line = band.counts.map((count, index) => `${index === 0 ? 'M' : 'L'}${((band.min + (index + 0.5) * step - least) / span) * 256} ${100 - (96 * Math.sqrt(count)) / peak}`).join(' ');
        return <path key={channel} d={line} fill="none" stroke={CHANNELS[channel]} strokeWidth={1.25} vectorEffect="non-scaling-stroke" />;
      })}
    </svg>
  );
};

/** Whether two pictures are drawn between the same values. */
const sameRanges = (one: GeoLook, other: GeoLook): boolean => JSON.stringify(one.ranges ?? null) === JSON.stringify(other.ranges ?? null);

/**
 * A raster of several bands as a picture of three of them: what they are drawn between to choose, how their values
 * are spread, and a table of all the bands, in which a band is given to red, green or blue by the mark in its row.
 * `look` is the picture as it is drawn.
 */
const Picture: React.FC<{
  description: RasterDescription;
  statistics: GeoStatistics;
  look: GeoLook;
  text: PreviewText;
  lead: (more: React.ReactNode) => React.ReactNode;
  onLook: (look: GeoLook) => void;
}> = ({ description, statistics, look, text, lead, onLook }) => {
  const locale = getCurrentIntlLocale();
  const bytes = look.bands.every((number) => description.bands[number - 1]?.type === 'Byte');
  const kinds: Stretch[] = bytes ? ['cut', 'minmax', 'deviation', 'none'] : ['cut', 'minmax', 'deviation'];
  const stretch = kinds.find((kind) => sameRanges(pictureOf(look.bands, statistics, kind), look)) ?? 'cut';

  return (
    <>
      {lead(
        <Choice label={text.stretch} value={stretch} onValue={(chosen) => onLook(pictureOf(look.bands, statistics, kinds.find((kind) => kind === chosen) ?? 'cut'))} shown={<span className="truncate">{text.stretches[stretch]}</span>}>
          {kinds.map((kind) => (
            <DropdownMenuRadioItem key={kind} value={kind}>{text.stretches[kind]}</DropdownMenuRadioItem>
          ))}
        </Choice>,
      )}
      <Spreads bands={look.bands.map((number) => statistics.bands[number - 1] ?? null)} />
      <div className="mt-2 grid grid-cols-[2.25rem_1.25rem_1.25rem_1.25rem_repeat(3,minmax(0,1fr))] items-center gap-x-1 border-t border-edge-muted pt-1.5 font-mono text-[11px]">
        <div className="py-1 text-muted-foreground">{text.band}</div>
        {CHANNEL_NAMES.map((name) => (
          <div key={name} className="py-1 text-center text-muted-foreground">{name}</div>
        ))}
        <div className="py-1 text-end text-muted-foreground">{text.columns.low}</div>
        <div className="py-1 text-end text-muted-foreground">{text.columns.high}</div>
        <div className="py-1 text-end text-muted-foreground">{text.columns.mean}</div>
        {description.bands.map((_, index) => {
          const number = index + 1;
          const band = statistics.bands[index];
          return (
            <React.Fragment key={number}>
              <div className="border-t border-edge-muted py-1 text-foreground">{number}</div>
              {([0, 1, 2] as const).map((channel) => {
                const given = look.bands[channel] === number;
                return (
                  <div key={channel} className="flex justify-center border-t border-edge-muted py-1">
                    <button
                      type="button"
                      aria-label={text.bandAs(number, channel)}
                      title={text.bandAs(number, channel)}
                      aria-pressed={given}
                      className="size-3 rounded-full border border-[color-mix(in_srgb,var(--foreground)_30%,transparent)]"
                      style={given ? { backgroundColor: CHANNELS[channel], borderColor: CHANNELS[channel] } : undefined}
                      onClick={() => onLook(pictureOf(look.bands.map((each, at) => (at === channel ? number : each)), statistics, stretch))}
                    />
                  </div>
                );
              })}
              {(['low', 'high', 'mean'] as const).map((measure) => (
                <div key={measure} className="truncate border-t border-edge-muted py-1 text-end text-foreground">{band ? figure(band[measure], locale) : ''}</div>
              ))}
            </React.Fragment>
          );
        })}
      </div>
      <div className="pt-2 text-[11px] text-muted-foreground">{text.sampled}</div>
    </>
  );
};

/**
 * How a raster is drawn, and what is measured of it. `measured` is what the reader measured or the code it was
 * refused with, none while it is being read; `look` is how the preview has the raster drawn, none while that is left
 * to the reader, and `onLook` changes it. A raster of several bands is drawn as a picture of three of them or as one
 * of them alone, which is then drawn and chosen for as a raster of one band is.
 */
export const LookTab: React.FC<{
  description: RasterDescription;
  measured: { statistics: GeoStatistics } | { code: string } | null;
  look: GeoLook | null;
  text: PreviewText;
  onLook: (look: GeoLook) => void;
}> = ({ description, measured, look, text, onLook }) => {
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
  const mode = drawn.length === 1 ? 'single' : 'composite';
  const alone = (band: number): GeoLook => lookOf([band], PLAIN, statistics.bands[band - 1]?.between ?? null);

  // A picture takes three bands.
  const modes = description.bands.length >= 3 ? (
    <Choice
      label={text.mode}
      value={mode}
      onValue={(chosen) => onLook(chosen === 'single' ? alone(number) : pictureOf(description.shown.length === 3 ? description.shown : [1, 2, 3], statistics, description.shown.every(bytes) ? 'none' : 'cut'))}
      shown={<span className="truncate">{text.modes[mode]}</span>}
    >
      <DropdownMenuRadioItem value="composite">{text.modes.composite}</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="single">{text.modes.single}</DropdownMenuRadioItem>
    </Choice>
  ) : null;
  const lead = (more: React.ReactNode) => (several ? <div className="flex items-center justify-between gap-2 pb-3">{modes}{more}</div> : null);

  return (
    <ScrollableOverlay outerClassName="h-full min-h-0" className="flex flex-col p-3 typography-meta">
      {mode === 'composite' ? (
        <Picture description={description} statistics={statistics} look={picture} text={text} lead={lead} onLook={onLook} />
      ) : (
        <OneBand
          number={number}
          bytes={bytes(number)}
          statistics={statistics}
          // The classes the reader found are those of the band it draws by default, and it draws by them that band alone.
          classes={number === description.shown[0] ? (statistics.classes ?? null) : null}
          look={look}
          text={text}
          lead={lead(
            <Choice label={text.band} value={String(number)} onValue={(chosen) => onLook(alone(Number(chosen)))} shown={<span className="truncate">{text.band} {number}</span>}>
              {description.bands.map((_, index) => (
                <DropdownMenuRadioItem key={index} value={String(index + 1)}>{text.band} {index + 1}</DropdownMenuRadioItem>
              ))}
            </Choice>,
          )}
          onLook={onLook}
        />
      )}
    </ScrollableOverlay>
  );
};
