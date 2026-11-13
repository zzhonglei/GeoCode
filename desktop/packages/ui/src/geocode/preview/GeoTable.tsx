import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { getCurrentIntlLocale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { MARK } from './geoColors';
import { Action, NoValue } from './GeoTabs';
import { readGeoRows, type FoundFeature, type GeoRows, type Target, type VectorDescription } from './previewClient';
import { unshownText, type PreviewText } from './previewText';

const ROW_HEIGHT = 25;
// The rows of no page: the same from one drawing to the next, as a page's are.
const NONE: GeoRows['rows'] = [];
// The widest and the narrowest a column is, in characters of the cells' font.
const LEAST = 4;
const MOST = 64;

/** How wide a value is in the cells' font, in its `ch`: a character of Chinese, Japanese or Korean takes two. */
const widthOf = (value: string): number => {
  let width = 0;
  for (const letter of value) width += (letter.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  return width;
};

/** Each column as wide as the longest value the page has in it. */
const widthsOf = (names: readonly string[], rows: GeoRows['rows']): number[] => {
  const widths = names.map(widthOf);
  for (const row of rows) {
    for (let column = 0; column < widths.length; column += 1) {
      const width = widthOf(row[column] ?? 'NULL');
      if (width > widths[column]) widths[column] = width;
    }
  }
  return widths.map((width) => Math.min(MOST, Math.max(LEAST, width)));
};

/**
 * A vector layer's attributes as a table, a page at a time, however many features the layer has. Drawn as the app
 * draws a CSV file, in TableArtifact: a header that stays, cells in a monospace font, columns as wide as their
 * values, and only the rows in view in the page. Unlike it, the rows are numbered in a column that stays, a field
 * without a value says so, and the row of the feature that is picked is marked as the map marks the feature.
 * `onPick` picks the feature of a row and `onReach` moves the map to the one that is picked, each where there is a
 * map to show it on; `onChanged` says the data is no longer what was described.
 */
export const GeoTable: React.FC<{
  target: Target;
  description: VectorDescription;
  picked: FoundFeature | null;
  text: PreviewText;
  onPick?: (fid: number) => void;
  onReach?: () => void;
  onChanged: () => void;
}> = ({ target, description, picked, text, onPick, onReach, onChanged }) => {
  // A row of the page that is wanted: the picked feature's to begin with.
  const [asked, setAsked] = React.useState(picked?.row ?? 0);
  const [page, setPage] = React.useState<GeoRows | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const scroller = React.useRef<HTMLElement>(null);
  const changed = React.useRef(onChanged);
  React.useEffect(() => {
    changed.current = onChanged;
  });

  // A feature picked since, on the map as well, brings its page.
  const [seen, setSeen] = React.useState(picked);
  if (picked !== seen) {
    setSeen(picked);
    if (picked && !(page && picked.row >= page.offset && picked.row < page.offset + page.rows.length)) setAsked(picked.row);
  }

  React.useEffect(() => {
    const leaving = new AbortController();
    void readGeoRows(target, description.stamp, asked, leaving.signal).then((outcome) => {
      if (leaving.signal.aborted) return;
      if (outcome.ok) {
        setFailed(null);
        return setPage(outcome.value);
      }
      if (outcome.code === 'changed') return changed.current();
      setFailed(outcome.code);
    });
    return () => leaving.abort();
  }, [target, description.stamp, asked]);

  const rows = page?.rows ?? NONE;
  const names = React.useMemo(() => description.fields.map((field) => field.name), [description.fields]);
  const widths = React.useMemo(() => widthsOf(names, rows), [names, rows]);
  // The numbers of the rows, as wide as the last of them.
  const numbered = String(description.features).length;
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_HEIGHT, overscan: 12 });

  // A page begins at its top: left to itself, the table stays as far down each page as it was scrolled in the last.
  const offset = page?.offset;
  React.useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [offset, virtualizer]);
  // Then the picked feature's row is brought into view, on the page that holds it.
  const marked = picked && page ? picked.row - page.offset : -1;
  React.useEffect(() => {
    if (marked >= 0 && marked < rows.length) virtualizer.scrollToIndex(marked, { align: 'auto' });
  }, [marked, rows.length, virtualizer]);

  if (failed) return <div className="p-3 typography-meta text-muted-foreground">{unshownText(text, failed)}</div>;
  if (!page) return <div className="p-3 typography-meta text-muted-foreground">{text.reading}</div>;
  if (description.features === 0) return <div className="p-3 typography-meta text-muted-foreground">{text.unshown.empty}</div>;

  const locale = getCurrentIntlLocale();
  const drawn = virtualizer.getVirtualItems();
  const above = drawn[0]?.start ?? 0;
  const below = drawn.length > 0 ? virtualizer.getTotalSize() - drawn[drawn.length - 1].end : 0;
  const cell = 'border-b border-e border-edge-muted px-2 py-1';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollableOverlay ref={scroller} outerClassName="min-h-0 flex-1">
        {/* A fixed layout only holds with a width of the table's own; without one a long value widens its column. */}
        <table
          className="min-w-full table-fixed border-separate border-spacing-0 font-mono typography-meta"
          style={{ width: `calc(${numbered + widths.reduce((sum, width) => sum + width, 0)}ch + ${widths.length + 1} * (1rem + 1px))` }}
        >
          <colgroup>
            <col style={{ width: `calc(${numbered}ch + 1rem + 1px)` }} />
            {widths.map((width, column) => (
              <col key={column} style={{ width: `calc(${width}ch + 1rem + 1px)` }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-20 bg-[var(--surface-subtle)]">
            <tr>
              <th scope="col" className={cn(cell, 'sticky start-0 bg-[var(--surface-subtle)] text-start font-medium text-muted-foreground')}>#</th>
              {names.map((name, column) => (
                <th key={column} scope="col" className={cn(cell, 'truncate text-start font-medium text-foreground last:border-e-0')} title={name}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {above > 0 ? <tr aria-hidden="true" style={{ height: above }} /> : null}
            {drawn.map((item) => {
              const row = rows[item.index] ?? [];
              const fid = page.fids[item.index];
              const current = item.index === marked;
              return (
                <tr
                  key={item.index}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  aria-selected={current}
                  // Opaque, each of them: the cell that stays takes its row's colour, and the rest pass under it.
                  className={cn(item.index % 2 === 0 ? 'bg-[var(--surface-background)]' : 'bg-[color-mix(in_srgb,var(--surface-subtle)_40%,var(--surface-background))]', onPick && 'cursor-pointer')}
                  style={current ? { backgroundColor: `color-mix(in srgb, ${MARK} 32%, var(--surface-background))` } : undefined}
                  onClick={onPick && fid !== undefined ? () => onPick(fid) : undefined}
                >
                  <td className={cn(cell, 'sticky start-0 z-10 bg-inherit tabular-nums text-muted-foreground')}>{page.offset + item.index + 1}</td>
                  {names.map((_, column) => {
                    const value = row[column] ?? null;
                    return (
                      <td key={column} className={cn(cell, 'truncate align-top text-foreground last:border-e-0')} title={value ?? undefined}>
                        {value === null ? <NoValue /> : value}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {below > 0 ? <tr aria-hidden="true" style={{ height: below }} /> : null}
          </tbody>
        </table>
      </ScrollableOverlay>
      <div className="flex h-[34px] shrink-0 items-center gap-1 border-t border-edge-muted pe-2 ps-3 typography-meta text-muted-foreground">
        <div className="min-w-0 flex-1 truncate">
          {text.rows((page.offset + 1).toLocaleString(locale), (page.offset + rows.length).toLocaleString(locale), description.features.toLocaleString(locale))}
        </div>
        {onReach ? <Action icon="zoom-in" label={text.reach} onClick={onReach} /> : null}
        <Action icon="arrow-left-s" label={text.previousPage} disabled={page.offset === 0} onClick={() => setAsked(page.offset - 1)} />
        <Action icon="arrow-right-s" label={text.nextPage} disabled={page.offset + rows.length >= description.features} onClick={() => setAsked(page.offset + rows.length)} />
      </div>
    </div>
  );
};
