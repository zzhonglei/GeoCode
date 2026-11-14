import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getCurrentIntlLocale } from '@/lib/i18n';
import type { FoundFeature, FoundPixel, GeoDescription, VectorDescription } from './previewClient';
import { placeText, valueText, type PreviewText } from './previewText';

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
        {picked.attributes.map(([field, value], index) => (
          <Row key={`${index}:${field}`} label={field}>
            {value === null ? <NoValue /> : value}
          </Row>
        ))}
      </ScrollableOverlay>
    </div>
  );
};

/**
 * The pixel that is clicked: where it is in the raster's grid and in the raster's own coordinates, and each band's
 * value as the file holds it, or what to do to click one.
 */
export const PixelTab: React.FC<{ pixel: FoundPixel | null; text: PreviewText }> = ({ pixel, text }) => {
  if (!pixel) return <div className="p-3 typography-meta text-muted-foreground">{text.pixelHint}</div>;
  const locale = getCurrentIntlLocale();
  // As many decimals as tell neighbouring pixels apart, whether the coordinates are degrees or metres.
  const coordinate = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: Math.abs(value) < 1000 ? 6 : 2 });
  return (
    <ScrollableOverlay outerClassName="h-full min-h-0" className="px-3 py-1.5 typography-meta">
      <Row label={text.pixel.column}><span className="font-mono">{(pixel.column + 1).toLocaleString(locale)}</span></Row>
      <Row label={text.pixel.row}><span className="font-mono">{(pixel.row + 1).toLocaleString(locale)}</span></Row>
      {pixel.centre ? (
        <>
          <Row label="X"><span className="font-mono">{coordinate(pixel.centre[0])}</span></Row>
          <Row label="Y"><span className="font-mono">{coordinate(pixel.centre[1])}</span></Row>
        </>
      ) : null}
      {pixel.values.map((value, index) => (
        <Row key={index} label={`${text.band} ${index + 1}`}>
          {value === null ? <span className="italic text-muted-foreground">{text.pixel.noData}</span> : <span className="font-mono">{valueText(value, locale)}</span>}
        </Row>
      ))}
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

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="min-w-0">
    <h4 className="mb-1 font-medium text-muted-foreground">{title}</h4>
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
