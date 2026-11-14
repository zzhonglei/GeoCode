import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getCurrentIntlLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { FoundFeature, FoundPixel, GeoDescription, GeoLook, GeoStatistics, RasterDescription, VectorDescription } from './previewClient';
import { placeText, valueText, type PreviewText } from './previewText';
import { bandLook, CHANNEL_NAMES, CHANNELS, classColour, drawnColour, rampColours } from './rasterLook';

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex gap-3 border-b border-edge-muted py-1.5 last:border-b-0">
    <div className="w-20 shrink-0 text-muted-foreground">{label}</div>
    <div className="min-w-0 flex-1 break-words text-foreground">{children}</div>
  </div>
);

/** One of the panel's actions, as an icon alone: what it does is said by its label. */
export const Action: React.FC<{ icon: IconName; label: string; disabled?: boolean; onClick: () => void }> = ({ icon, label, disabled, onClick }) => (
  <Button variant="ghost" size="xs" className="size-[26px] px-0 text-muted-foreground" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
    <Icon name={icon} />
  </Button>
);

/** A field without a value, as GIS software writes it, in every language. */
export const NoValue: React.FC = () => <span className="italic text-muted-foreground">NULL</span>;

/**
 * The feature that is picked: which of the layer's `total` it is and its attributes, or what to do to pick one.
 * `onReach` moves the map to it, where there is a map and the feature has a place on it.
 */
export const FeatureTab: React.FC<{ picked: FoundFeature | null; total: number; text: PreviewText; onReach?: () => void }> = ({ picked, total, text, onReach }) => {
  if (!picked) return <div className="p-3 typography-meta text-muted-foreground">{text.pickHint}</div>;
  const locale = getCurrentIntlLocale();
  return (
    <div className="flex h-full min-h-0 flex-col typography-meta">
      <div className="flex shrink-0 items-center gap-2 pe-2 ps-3 pt-1.5">
        <div className="min-w-0 flex-1 truncate text-muted-foreground">{text.nth((picked.row + 1).toLocaleString(locale), total.toLocaleString(locale))}</div>
        {onReach ? <Action icon="zoom-in" label={text.reach} onClick={onReach} /> : null}
      </div>
      <ScrollableOverlay outerClassName="min-h-0 flex-1" className="px-3 pb-1.5">
        {picked.attributes.length === 0 ? <div className="py-1.5 text-muted-foreground">{text.noAttributes}</div> : null}
        {/* The names as wide as the longest of them, to under half the panel, past which a name wraps: a field name
            is often long, as OpenStreetMap's addr:housenumber is, and must not run under its value. */}
        <div className="grid grid-cols-[fit-content(45%)_minmax(0,1fr)] [&>*:nth-last-child(-n+2)]:border-b-0">
          {picked.attributes.map(([field, value], index) => (
            <React.Fragment key={`${index}:${field}`}>
              <div className="border-b border-edge-muted py-1.5 pe-3 text-muted-foreground [overflow-wrap:anywhere]">{field}</div>
              <div className="min-w-0 border-b border-edge-muted py-1.5 text-foreground [overflow-wrap:anywhere]">{value === null ? <NoValue /> : value}</div>
            </React.Fragment>
          ))}
        </div>
      </ScrollableOverlay>
    </div>
  );
};

/** A whole number of tens to a power at or past a value from none, to end a scale with: 5,000 for 4,210. */
const roundedPast = (value: number): number => {
  if (value <= 0) return 0;
  const step = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / step) * step;
};

// The spectral profile's drawing, in the units it is drawn in: its width and height, and the room left of it for the
// scale's values and under it for the bands' numbers.
const PROFILE = { width: 300, height: 118, left: 44, right: 8, top: 6, bottom: 18 };

/**
 * A pixel's values band after band as a line, broken at a band without data there, on a scale from none, or the
 * least of them where that is less, to the greatest; the bands drawn are marked as the map draws them, in red, green
 * and blue, or as the band drawn alone is marked in the table of bands.
 */
const Profile: React.FC<{ values: readonly (number | null)[]; drawn: readonly number[]; composite: boolean; text: PreviewText }> = ({ values, drawn, composite, text }) => {
  const locale = getCurrentIntlLocale();
  const known = values.filter((value) => value !== null);
  if (known.length === 0) return null;
  const { width, height, left, right, top, bottom } = PROFILE;
  const [least, most] = [-roundedPast(-Math.min(0, ...known)), roundedPast(Math.max(0, ...known))];
  const span = most - least || 1;
  const x = (index: number) => left + (index * (width - left - right)) / Math.max(1, values.length - 1);
  const y = (value: number) => top + (height - top - bottom) * (1 - (value - least) / span);
  // Its ends, and none between them where the values pass it, else halfway.
  const marks = [least, least < 0 && most > 0 ? 0 : (least + most) / 2, most];
  // A number under every band, or under every so many of a great many.
  const every = Math.ceil(values.length / 16);
  const line = values.map((value, index) => (value === null ? '' : `${index > 0 && values[index - 1] !== null ? 'L' : 'M'}${x(index)} ${y(value)}`)).join(' ');
  return (
    <svg role="img" aria-label={text.pixel.profile} viewBox={`0 0 ${width} ${height}`} className="block h-auto w-full max-w-[420px] overflow-visible font-mono">
      <g className="text-muted-foreground">
        {marks.map((value, index) => (
          <React.Fragment key={index}>
            <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="currentColor" strokeOpacity={0.25} strokeWidth={0.75} />
            <text x={left - 6} y={y(value) + 3.5} textAnchor="end" fontSize={10} fill="currentColor">{value.toLocaleString(locale, { maximumSignificantDigits: 3 })}</text>
          </React.Fragment>
        ))}
        {values.map((_, index) => (index % every === 0 ? <text key={index} x={x(index)} y={height - 4} textAnchor="middle" fontSize={10} fill="currentColor">{index + 1}</text> : null))}
      </g>
      <g className="text-foreground">
        <path d={line} fill="none" stroke="currentColor" strokeOpacity={0.7} strokeWidth={1.5} />
        {values.map((value, index) => {
          if (value === null) return null;
          const number = index + 1;
          const channel = composite ? drawn.indexOf(number) : -1;
          const alone = !composite && drawn[0] === number;
          const colour = channel >= 0 ? CHANNELS[channel] : alone ? 'var(--interactive-selection-foreground)' : null;
          return (
            <circle key={index} cx={x(index)} cy={y(value)} r={colour ? 3.5 : 2.5} fill={colour ?? 'var(--background)'} stroke={colour ?? 'currentColor'} strokeWidth={1.25}>
              <title>{`${text.band} ${number}: ${valueText(value, locale)}`}</title>
            </circle>
          );
        })}
      </g>
    </svg>
  );
};

/** A colour as a square of it, as a ramp's or a class's colours are shown. */
const Swatch: React.FC<{ colour: string; label: string }> = ({ colour, label }) => (
  <span role="img" aria-label={label} title={label} className="inline-block size-3.5 shrink-0 rounded-[3px] border border-edge-muted align-middle" style={{ backgroundColor: colour }} />
);

/**
 * The pixel that is clicked: where it is in the raster's grid and in the raster's own coordinates; its values band
 * after band as a line, where there are several; and each band's value as the file holds it, the bands drawn marked
 * as the map draws them, a band drawn alone by the colour its value is drawn in and the name of its class where it
 * has one. Or what to do to click one. `statistics` say what a band is drawn through, once measured; `look` is how
 * the preview has the raster drawn, none where that is left to the reader. In two columns where the panel is wide.
 */
export const PixelTab: React.FC<{ pixel: FoundPixel | null; description: RasterDescription; statistics: GeoStatistics | null; look: GeoLook | null; text: PreviewText }> = ({ pixel, description, statistics, look, text }) => {
  if (!pixel) return <div className="p-3 typography-meta text-muted-foreground">{text.pixelHint}</div>;
  const locale = getCurrentIntlLocale();
  // As many decimals as tell neighbouring pixels apart, whether the coordinates are degrees or metres.
  const coordinate = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: Math.abs(value) < 1000 ? 6 : 2 });
  const drawn = look?.bands ?? description.shown;
  const composite = drawn.length > 1;
  // How the map shows a value of the band drawn alone: in the colour it is drawn in, and as its class where it has one.
  const shownAs = (number: number, value: number): React.ReactNode => {
    const band = statistics?.bands[number - 1];
    if (!statistics || !band) return null;
    const classes = number === description.shown[0] ? (statistics.classes ?? null) : null;
    const { ramp, classed, range } = bandLook(band, classes, look);
    if (!classed) return <Swatch colour={drawnColour(value, range, rampColours(statistics, ramp))} label={text.pixel.drawnAs} />;
    const found = classes?.find((each) => each.value === value);
    return found ? (
      <span className="flex min-w-0 items-center gap-2">
        <Swatch colour={classColour(found)} label={text.pixel.drawnAs} />
        {found.name ? <span className="min-w-0 truncate">{found.name}</span> : null}
      </span>
    ) : null;
  };
  const cell = 'border-b border-edge-muted py-1';

  return (
    <ScrollableOverlay outerClassName="h-full min-h-0" className="@container px-3 py-2 typography-meta">
      <div className="grid gap-x-6 gap-y-3 @[34rem]:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <Section title={text.pixel.place}>
            <Pairs
              pairs={[
                [text.pixel.column, <span className="font-mono">{(pixel.column + 1).toLocaleString(locale)}</span>],
                [text.pixel.row, <span className="font-mono">{(pixel.row + 1).toLocaleString(locale)}</span>],
                ...(pixel.centre
                  ? [['X', <span className="font-mono">{coordinate(pixel.centre[0])}</span>] as const, ['Y', <span className="font-mono">{coordinate(pixel.centre[1])}</span>] as const]
                  : []),
              ]}
            />
          </Section>
          {pixel.values.length > 1 ? (
            <Section title={text.pixel.profile}>
              <Profile values={pixel.values} drawn={drawn} composite={composite} text={text} />
            </Section>
          ) : null}
        </div>
        <Section title={text.pixel.values}>
          <table className="w-full border-collapse [&_tr:last-child>td]:border-b-0">
            <tbody>
              {pixel.values.map((value, index) => {
                const number = index + 1;
                const colour = description.bands[index]?.color;
                const channels = composite ? ([0, 1, 2] as const).filter((channel) => drawn[channel] === number) : [];
                return (
                  <tr key={number}>
                    <td className={cn(cell, 'pe-3 text-foreground')}>
                      <span className="font-mono">{number}</span>
                      {colour && colour !== 'Undefined' ? <span className="ms-1.5 text-muted-foreground">{colour}</span> : null}
                    </td>
                    <td className={cn(cell, 'text-end font-mono tabular-nums text-foreground')}>
                      {value === null ? <span className="font-sans italic text-muted-foreground">{text.pixel.noData}</span> : valueText(value, locale)}
                    </td>
                    <td className={cn(cell, 'w-1/2 max-w-0 ps-3 text-foreground')}>
                      {value === null ? null : composite ? (
                        <span className="flex gap-1">
                          {channels.map((channel) => (
                            <span key={channel} className="inline-flex size-4 items-center justify-center rounded font-mono text-[10px] font-semibold text-white" style={{ backgroundColor: CHANNELS[channel] }}>
                              {CHANNEL_NAMES[channel]}
                            </span>
                          ))}
                        </span>
                      ) : drawn[0] === number ? shownAs(number, value) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      </div>
    </ScrollableOverlay>
  );
};

/**
 * A field's type by GDAL's name for it, coloured as code is coloured by kind, so that the numbers stand out among the
 * text at a glance: text, whole numbers, other numbers and dates; any other type in grey.
 */
const TYPE_COLOURS = new Map([
  ['String', 'var(--syntax-string)'],
  ['Integer', 'var(--syntax-number)'],
  ['Integer64', 'var(--syntax-number)'],
  ['Real', 'var(--syntax-type)'],
  ['Date', 'var(--syntax-keyword)'],
  ['DateTime', 'var(--syntax-keyword)'],
  ['Time', 'var(--syntax-keyword)'],
]);

const FieldType: React.FC<{ type: string }> = ({ type }) => (
  <span
    className="inline-block rounded px-1.5 font-mono leading-[17px] bg-[color-mix(in_srgb,currentColor_12%,transparent)]"
    style={{ color: TYPE_COLOURS.get(type) ?? 'var(--muted-foreground)' }}
  >
    {type}
  </span>
);

/** A part of a tab under its title, and what is chosen in it at the title's end where it says so. */
export const Section: React.FC<{ title: string; aside?: React.ReactNode; children: React.ReactNode }> = ({ title, aside, children }) => (
  <section className="min-w-0">
    <h4 className="mb-1 flex justify-between gap-3 font-medium text-muted-foreground">
      <span className="min-w-0 truncate">{title}</span>
      {aside ? <span className="min-w-0 truncate text-foreground">{aside}</span> : null}
    </h4>
    {children}
  </section>
);

/** Labels and their values, a pair a line, a long value wrapping under itself. */
const Pairs: React.FC<{ pairs: readonly (readonly [string, React.ReactNode])[] }> = ({ pairs }) => (
  <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
    {pairs.map(([label, value]) => (
      <React.Fragment key={label}>
        <span className="text-muted-foreground">{label}</span>
        <span className="min-w-0 [overflow-wrap:anywhere] text-foreground">{value}</span>
      </React.Fragment>
    ))}
  </div>
);

/**
 * What a vector layer is: an overview, its coordinate system and extent, and its fields as a table, in two columns
 * where the panel is wide enough and one under the other where it is not.
 */
const VectorInfo: React.FC<{ description: VectorDescription; text: PreviewText }> = ({ description, text }) => {
  const locale = getCurrentIntlLocale();
  const forms = description.forms
    ? (['points', 'lines', 'polygons'] as const).flatMap((form) => (description.forms?.[form] ? [`${text.forms[form]} ${description.forms[form].toLocaleString(locale)}`] : [])).join(' · ')
    : null;
  const geometry = description.geometry ?? forms;
  const bounds = description.bounds;
  return (
    <ScrollableOverlay outerClassName="h-full min-h-0" className="@container px-3 py-2 typography-meta">
      <div className="grid gap-x-6 gap-y-3 @[34rem]:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <Section title={text.about.overview}>
            <Pairs
              pairs={[
                [text.info.layer, description.layer],
                ...(geometry ? [[text.info.geometry, geometry] as const] : []),
                [text.info.features, description.features.toLocaleString(locale)],
              ]}
            />
          </Section>
          <Section title={text.about.place}>
            {description.crs ? (
              <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className="text-foreground">{description.crs.name}</span>
                {description.crs.code ? <span className="rounded px-1.5 font-mono leading-[17px] bg-[color-mix(in_srgb,var(--foreground)_7%,transparent)]">{description.crs.code}</span> : null}
              </div>
            ) : (
              <div className="mb-1 text-muted-foreground">{text.noCrs}</div>
            )}
            {bounds ? (
              <Pairs
                pairs={[
                  [text.about.southwest, <span className="font-mono">{placeText(bounds[0], bounds[1])}</span>],
                  [text.about.northeast, <span className="font-mono">{placeText(bounds[2], bounds[3])}</span>],
                ]}
              />
            ) : null}
          </Section>
        </div>
        {description.fields.length > 0 ? (
          <Section title={`${text.info.fields} · ${description.fields.length.toLocaleString(locale)}`}>
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-muted-foreground">
                  <th scope="col" className="border-b border-edge-muted py-1 pe-3 text-start font-normal">{text.about.field}</th>
                  <th scope="col" className="border-b border-edge-muted py-1 text-start font-normal">{text.about.type}</th>
                </tr>
              </thead>
              <tbody>
                {description.fields.map((field, index) => (
                  <tr key={`${index}:${field.name}`}>
                    <td className="border-b border-edge-muted py-1 pe-3 font-mono [overflow-wrap:anywhere] text-foreground">{field.name}</td>
                    <td className="border-b border-edge-muted py-1"><FieldType type={field.type} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        ) : null}
      </div>
    </ScrollableOverlay>
  );
};

/**
 * What the data is, at more length than the line above the map has room for. `drawn` is the bands a raster is drawn
 * from, where the preview has chosen them.
 */
export const InfoTab: React.FC<{ description: GeoDescription; text: PreviewText; drawn?: readonly number[] }> = ({ description, text, drawn }) => {
  if (description.kind === 'vector') return <VectorInfo description={description} text={text} />;
  const locale = getCurrentIntlLocale();
  const crs = !description.crs ? text.noCrs : description.crs.code ? `${description.crs.name} (${description.crs.code})` : description.crs.name;
  const extent = description.bounds
    ? `${placeText(description.bounds[0], description.bounds[1])} – ${placeText(description.bounds[2], description.bounds[3])}`
    : null;
  return (
    <ScrollableOverlay outerClassName="h-full min-h-0" className="px-3 py-1.5 typography-meta">
      <Row label={text.info.layer}>{description.layer}</Row>
      <Row label={text.info.size}>{`${description.width.toLocaleString(locale)} × ${description.height.toLocaleString(locale)}`}</Row>
      <Row label={text.info.bands}>
        {description.bands.map((band, index) => (
          <div key={index}>
            {index + 1} · {band.type}
            {band.nodata === null ? '' : ` · ${text.info.nodata} ${band.nodata}`}
          </div>
        ))}
        {description.bands.length > (drawn ?? description.shown).length ? <div className="text-muted-foreground">{text.shown((drawn ?? description.shown).join(', '))}</div> : null}
      </Row>
      <Row label={text.info.crs}>{crs}</Row>
      {extent ? <Row label={text.info.extent}>{extent}</Row> : null}
    </ScrollableOverlay>
  );
};
