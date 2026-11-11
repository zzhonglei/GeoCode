import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { ContentLoadingState, ContentState } from '@/components/ui/content-state';
import { ArtifactMetaBar } from '@/components/views/files/previews/ArtifactMetaBar';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import type { MapView } from './GeoMap';
import { describeGeoData, type FoundFeature, type GeoDescription, type Target } from './previewClient';
import { previewText, unshownText, type PreviewText } from './previewText';

// Its own chunk: the map library is loaded when the first geographic file is opened.
const GeoMap = React.lazy(() => import('./GeoMap'));

/** What is known of the data a preview was last asked to show: its description, or the code it was refused with. */
type Known = { target: Target } & ({ description: GeoDescription } | { code: string });

const crsOf = (description: GeoDescription, text: PreviewText): string => {
  if (!description.crs) return text.noCrs;
  return description.crs.code ? `${description.crs.name} (${description.crs.code})` : description.crs.name;
};

/** The refusals of a tile that say the whole layer cannot be drawn, not that one tile failed. */
const WHOLE = new Set(['too-large', 'unopenable', 'missing', 'no-layer', 'not-ready']);

/** The line above the map: what the data is, in the numbers a user would otherwise have to ask for. */
const factsOf = (description: GeoDescription, text: PreviewText): string[] => {
  const locale = getCurrentIntlLocale();
  if (description.kind === 'vector') {
    return [text.features(description.features, description.features.toLocaleString(locale)), description.geometry ?? '', text.fields(description.fields.length), crsOf(description, text)];
  }
  const types = [...new Set(description.bands.map((band) => band.type))];
  return [
    `${description.width.toLocaleString(locale)} × ${description.height.toLocaleString(locale)}`,
    text.bands(description.bands.length),
    types.join(', '),
    description.bands.length > description.shown.length ? text.shown(description.shown.join(', ')) : '',
    crsOf(description, text),
  ];
};

/**
 * A geographic dataset shown as a map in a file tab. `revision` changes when the file does; `visible` is false while
 * the tab is hidden, when the map is let go: a window holds only so many maps at once. `download` is offered where the
 * file cannot be shown, as it is for any other file that cannot.
 */
export const GeoPreview: React.FC<{ path: string; revision: number; visible: boolean; download?: React.ReactNode }> = ({ path, revision, visible, download }) => {
  const { locale } = useI18n();
  const text = previewText(locale);
  const [layer, setLayer] = React.useState<string | undefined>(undefined);
  const [known, setKnown] = React.useState<Known | null>(null);
  const [picked, setPicked] = React.useState<FoundFeature | null>(null);
  const [mapFailed, setMapFailed] = React.useState(false);
  // The code a tile or a click was last refused with.
  const [refused, setRefused] = React.useState<string | null>(null);
  // Raised when the reader says the data is no longer what was described.
  const [changes, setChanges] = React.useState(0);
  const view = React.useRef<MapView | null>(null);
  const target = React.useMemo<Target>(() => (layer === undefined ? { path } : { path, layer }), [path, layer]);

  React.useEffect(() => {
    if (!visible) return;
    const leaving = new AbortController();
    void describeGeoData(target, leaving.signal).then((outcome) => {
      if (leaving.signal.aborted) return;
      // Whatever was refused is asked for again by the map this description draws.
      if (outcome.ok) setRefused(null);
      setKnown((before) => {
        const same = before !== null && before.target === target;
        if (outcome.ok) {
          // The same data keeps its map as it is.
          if (same && 'description' in before && before.description.stamp === outcome.value.stamp) return before;
          setPicked(null);
          return { target, description: outcome.value };
        }
        // A file half written reads as broken for a moment: what was shown stays until it reads again, or is gone.
        if (same && 'description' in before && outcome.code !== 'missing') return before;
        return { target, code: outcome.code };
      });
    });
    return () => leaving.abort();
  }, [target, revision, changes, visible]);

  const current = known !== null && known.target === target ? known : null;
  const description = current && 'description' in current ? current.description : null;
  const whole = refused !== null && WHOLE.has(refused) ? refused : null;
  const unshown = current && 'code' in current ? current.code : mapFailed ? 'no-map' : (description?.unplaced ?? whole);
  const bounds = description?.bounds;
  const name = path.split(/[/\\]/).pop() ?? path;

  const layers = description && description.layers.length > 1 ? description.layers : null;
  const layerPicker = layers ? (
    <label className="flex items-center gap-1 typography-meta text-muted-foreground">
      {text.layer}
      <select
        className="max-w-48 rounded border border-border bg-background px-1 py-0.5 typography-meta text-foreground"
        value={description?.layer ?? ''}
        onChange={(event) => {
          view.current = null;
          setLayer(event.target.value);
        }}
      >
        {layers.map((each) => (
          <option key={each.name} value={each.name}>{each.name}</option>
        ))}
      </select>
    </label>
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar items={description ? factsOf(description, text) : []} actions={layerPicker} />
      <div className="relative min-h-0 flex-1">
        {!current ? <ContentLoadingState label={text.reading} /> : null}
        {unshown ? (
          <ContentState icon={<FileTypeIcon filePath={path} className="size-10" />} title={name} description={unshownText(text, unshown)} actions={download} />
        ) : null}
        {description && bounds && !unshown && visible ? (
          <React.Suspense fallback={<ContentLoadingState label={text.reading} />}>
            <GeoMap
              key={description.stamp}
              target={target}
              description={description}
              bounds={bounds}
              view={view}
              onPick={setPicked}
              onRefused={(code) => (code === 'changed' ? setChanges((count) => count + 1) : setRefused(code))}
              onFailed={() => setMapFailed(true)}
            />
          </React.Suspense>
        ) : null}
        {refused && bounds && !unshown ? (
          <div role="alert" className="absolute bottom-2 start-2 flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 typography-meta text-muted-foreground shadow-md">
            {text.partly}
            <button type="button" aria-label={text.close} className="rounded p-0.5 hover:bg-[var(--surface-subtle)]" onClick={() => setRefused(null)}>
              <Icon name="close" className="size-3.5" />
            </button>
          </div>
        ) : null}
        {picked && bounds && !unshown ? (
          <div className="absolute end-2 top-2 flex max-h-[60%] w-72 flex-col rounded-md border border-border bg-background shadow-md">
            <div className="flex shrink-0 items-center justify-between border-b border-edge-muted px-2 py-1 typography-meta text-muted-foreground">
              {text.attributes}
              <button type="button" aria-label={text.close} className="rounded p-0.5 hover:bg-[var(--surface-subtle)]" onClick={() => setPicked(null)}>
                <Icon name="close" className="size-3.5" />
              </button>
            </div>
            <div className="min-h-0 overflow-auto p-2 typography-meta">
              {picked.attributes.length === 0 ? <div className="text-muted-foreground">{text.noAttributes}</div> : null}
              {picked.attributes.map(([field, value], index) => (
                <div key={`${index}:${field}`} className="flex gap-2 py-0.5">
                  <span className="shrink-0 text-muted-foreground">{field}</span>
                  <span className="min-w-0 break-words text-foreground">{value}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};
