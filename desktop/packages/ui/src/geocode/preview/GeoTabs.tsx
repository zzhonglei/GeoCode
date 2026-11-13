import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getCurrentIntlLocale } from '@/lib/i18n';
import type { FoundFeature, FoundPixel, GeoDescription } from './previewClient';
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
 * What the data is, at more length than the line above the map has room for. `drawn` is the bands a raster is drawn
 * from, where the preview has chosen them.
 */
export const InfoTab: React.FC<{ description: GeoDescription; text: PreviewText; drawn?: readonly number[] }> = ({ description, text, drawn }) => {
  const locale = getCurrentIntlLocale();
  const crs = !description.crs ? text.noCrs : description.crs.code ? `${description.crs.name} (${description.crs.code})` : description.crs.name;
  const extent = description.bounds
    ? `${placeText(description.bounds[0], description.bounds[1])} – ${placeText(description.bounds[2], description.bounds[3])}`
    : null;
  return (
    <ScrollableOverlay outerClassName="h-full min-h-0" className="px-3 py-1.5 typography-meta">
      <Row label={text.info.layer}>{description.layer}</Row>
      {description.kind === 'vector' ? (
        <>
          {description.geometry ? <Row label={text.info.geometry}>{description.geometry}</Row> : null}
          <Row label={text.info.features}>{description.features.toLocaleString(locale)}</Row>
        </>
      ) : (
        <>
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
        </>
      )}
      <Row label={text.info.crs}>{crs}</Row>
      {extent ? <Row label={text.info.extent}>{extent}</Row> : null}
      {description.kind === 'vector' && description.fields.length > 0 ? (
        <Row label={text.info.fields}>
          {description.fields.map((field, index) => (
            <div key={`${index}:${field.name}`}>
              {field.name} <span className="text-muted-foreground">{field.type}</span>
            </div>
          ))}
        </Row>
      ) : null}
    </ScrollableOverlay>
  );
};
