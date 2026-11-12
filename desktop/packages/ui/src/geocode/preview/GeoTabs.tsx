import React from 'react';

import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getCurrentIntlLocale } from '@/lib/i18n';
import type { FoundFeature, GeoDescription } from './previewClient';
import { placeText, type PreviewText } from './previewText';

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex gap-3 border-b border-edge-muted py-1.5 last:border-b-0">
    <div className="w-20 shrink-0 text-muted-foreground">{label}</div>
    <div className="min-w-0 flex-1 break-words text-foreground">{children}</div>
  </div>
);

/** The attributes of the feature last clicked, or what to do to see some. */
export const FeatureTab: React.FC<{ picked: FoundFeature | null; text: PreviewText }> = ({ picked, text }) => {
  if (!picked) return <div className="p-3 typography-meta text-muted-foreground">{text.pickHint}</div>;
  return (
    <ScrollableOverlay outerClassName="h-full min-h-0" className="px-3 py-1.5 typography-meta">
      {picked.attributes.length === 0 ? <div className="py-1.5 text-muted-foreground">{text.noAttributes}</div> : null}
      {picked.attributes.map(([field, value], index) => (
        <Row key={`${index}:${field}`} label={field}>
          {/* As GIS software writes a field without a value, in every language. */}
          {value === null ? <span className="italic text-muted-foreground">NULL</span> : value}
        </Row>
      ))}
    </ScrollableOverlay>
  );
};

/** What the data is, at more length than the line above the map has room for. */
export const InfoTab: React.FC<{ description: GeoDescription; text: PreviewText }> = ({ description, text }) => {
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
            {description.bands.length > description.shown.length ? <div className="text-muted-foreground">{text.shown(description.shown.join(', '))}</div> : null}
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
