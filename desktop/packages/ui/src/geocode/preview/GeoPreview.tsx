import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { ContentLoadingState, ContentState } from '@/components/ui/content-state';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { cancelWhenLayoutSettled, runWhenLayoutSettled } from '@/lib/layoutAnimation';
import { cn } from '@/lib/utils';
import type { MapView } from './GeoMap';
import { GeoPanel, type PanelTab } from './GeoPanel';
import { LookTab } from './GeoLook';
import { GeoTable } from './GeoTable';
import { FeatureTab, InfoTab, PixelTab } from './GeoTabs';
import { describeGeoData, findGeoFeature, FORMS, readGeoStatistics, type Form, type FoundFeature, type FoundPixel, type GeoBounds, type GeoDescription, type GeoLook, type GeoStatistics, type Target } from './previewClient';
import { placeText, previewText, unshownText, type PreviewText } from './previewText';
import { stilled } from './stilled';

// Its own chunk: the map library is loaded when the first geographic file is opened.
const GeoMap = React.lazy(() => import('./GeoMap'));

/** What is known of the data a preview was last asked to show: its description, or the code it was refused with. */
type Known = { target: Target } & ({ description: GeoDescription } | { code: string });

/** The refusals of a tile that say the whole layer cannot be drawn, not that one tile failed. */
const WHOLE = new Set(['too-large', 'unopenable', 'missing', 'no-layer', 'not-ready']);

// The panel goes beside the map from this width on, where the room is also wider than it is tall by this much: the
// app's side panel is mostly taller than wide, and a map with a panel beside it there would be a sliver.
const BESIDE_WIDTH = 720;
const BESIDE_RATIO = 1.25;

/** Those of points, lines and polygons a layer has features of, each with how many, where its type does not say. */
const formsOf = (description: GeoDescription | null): [Form, number][] => {
  const counted = description?.kind === 'vector' ? description.forms : null;
  return counted ? FORMS.flatMap((form): [Form, number][] => (counted[form] ? [[form, counted[form]]] : [])) : [];
};

/** The line above the map: the two or three facts that say what the data is; the rest is in the panel. */
const factsOf = (description: GeoDescription, text: PreviewText): string[] => {
  const locale = getCurrentIntlLocale();
  if (description.kind === 'vector') {
    const forms = formsOf(description);
    const geometry = description.forms ? forms.map(([form]) => text.forms[form]).join(' ') : (description.geometry ?? '');
    return [text.features(description.features, description.features.toLocaleString(locale)), geometry];
  }
  return [
    `${description.width.toLocaleString(locale)} × ${description.height.toLocaleString(locale)}`,
    text.bands(description.bands.length),
    [...new Set(description.bands.map((band) => band.type))].join(', '),
  ];
};

/** Where the pointer is over the map. Told apart from the preview, which a moving pointer would else draw again. */
const Pointer: React.FC<{ listen: (tell: (at: readonly [number, number] | null) => void) => () => void }> = ({ listen }) => {
  const [at, setAt] = React.useState<readonly [number, number] | null>(null);
  React.useEffect(() => listen(setAt), [listen]);
  return at ? <div className="shrink-0 tabular-nums text-muted-foreground">{placeText(at[0], at[1])}</div> : null;
};

/**
 * A geographic dataset shown as a map in a file tab, with a panel of what goes with it. `revision` changes when the
 * file does; `visible` is false while the tab is hidden, when the map is let go: a window holds only so many maps at
 * once. `download` is offered where the file cannot be shown, as it is for any other file that cannot.
 */
export const GeoPreview: React.FC<{ path: string; revision: number; visible: boolean; download?: React.ReactNode }> = ({ path, revision, visible, download }) => {
  const { locale } = useI18n();
  const text = previewText(locale);
  const [layer, setLayer] = React.useState<string | undefined>(undefined);
  // Those of the layer's points, lines and polygons that are not drawn.
  const [hidden, setHidden] = React.useState<readonly Form[]>([]);
  const [known, setKnown] = React.useState<Known | null>(null);
  const [picked, setPicked] = React.useState<FoundFeature | null>(null);
  // The pixel of a raster that was last clicked.
  const [pixel, setPixel] = React.useState<FoundPixel | null>(null);
  // How a raster is drawn, once the preview says and until its data is another's: none leaves it to the reader.
  const [look, setLook] = React.useState<GeoLook | null>(null);
  // What was measured of the raster under a stamp, or the code that was refused with.
  const [measured, setMeasured] = React.useState<{ target: Target; stamp: string; outcome: { statistics: GeoStatistics } | { code: string } } | null>(null);
  const [mapFailed, setMapFailed] = React.useState(false);
  // The code a tile or a click was last refused with, and whether it was a click.
  const [refused, setRefused] = React.useState<{ code: string; clicked: boolean } | null>(null);
  // Raised when the reader says the data is no longer what was described.
  const [changes, setChanges] = React.useState(0);
  const [tab, setTab] = React.useState('feature');
  const [open, setOpen] = React.useState(false);
  // The room the map and the panel share.
  const [room, setRoom] = React.useState({ width: 0, height: 0 });
  const view = React.useRef<MapView | null>(null);
  const reach = React.useRef<((to: GeoBounds) => void) | null>(null);
  // Counts what is picked, on the map and in the table: an answer to one that is no longer the last says nothing.
  const picks = React.useRef(0);
  const shared = React.useRef<HTMLDivElement>(null);
  // The layer the file opens with, which is asked for by no name: asked for by its name, it would be another reader's
  // and be read again.
  const opened = React.useRef<string | null>(null);
  const target = React.useMemo<Target>(() => (layer === undefined ? { path } : { path, layer }), [path, layer]);

  const pointers = React.useRef(new Set<(at: readonly [number, number] | null) => void>());
  const listen = React.useCallback((tell: (at: readonly [number, number] | null) => void) => {
    pointers.current.add(tell);
    return () => {
      pointers.current.delete(tell);
    };
  }, []);
  const onPointer = React.useCallback((at: readonly [number, number] | null) => pointers.current.forEach((tell) => tell(at)), []);

  React.useEffect(() => {
    const element = shared.current;
    if (!element) return;
    // Not while the tab is hidden, when it has no size: the panel would be laid out for none as the tab comes back.
    const measure = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0) setRoom({ width: element.clientWidth, height: element.clientHeight });
    };
    measure();
    // Once it has stopped changing, not on every frame of a panel sliding.
    const measuring = stilled(measure);
    const watching = new ResizeObserver(() => runWhenLayoutSettled(measuring.ask));
    watching.observe(element);
    return () => {
      watching.disconnect();
      cancelWhenLayoutSettled(measuring.ask);
      measuring.drop();
    };
  }, []);

  // Another layer of the file is looked at where the one before it was: a file's layers mostly lie in the same
  // place, and the button on the map leads to those that do not. What showed there was the whole of the layer
  // before, not of this one. In an effect, which runs after the map that is leaving has written down where it was.
  React.useEffect(() => {
    if (view.current) view.current = { ...view.current, whole: false };
  }, [target]);

  // Changed, the file may open with another layer. Until the preview has opened it as it is, every layer is asked for
  // by its name.
  React.useEffect(() => {
    opened.current = null;
  }, [revision, changes]);

  React.useEffect(() => {
    if (!visible) return;
    const leaving = new AbortController();
    void describeGeoData(target, leaving.signal).then((outcome) => {
      if (leaving.signal.aborted) return;
      if (outcome.ok && target.layer === undefined) opened.current = outcome.value.layer;
      // Whatever was refused is asked for again by the map this description draws.
      if (outcome.ok) setRefused(null);
      setKnown((before) => {
        const same = before !== null && before.target === target;
        if (outcome.ok) {
          // The same data keeps its map as it is.
          if (same && 'description' in before && before.description.stamp === outcome.value.stamp) return before;
          setPicked(null);
          setPixel(null);
          setLook(null);
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
  const whole = refused !== null && WHOLE.has(refused.code) ? refused.code : null;
  const unshown = current && 'code' in current ? current.code : mapFailed ? 'no-map' : (description?.unplaced ?? whole);
  const bounds = description?.bounds;
  const name = path.split(/[/\\]/).pop() ?? path;
  const beside = room.width >= BESIDE_WIDTH && room.width > room.height * BESIDE_RATIO;

  // A raster is measured: the numbers go under its histogram and into the table of its bands, and name what it is
  // offered to be drawn by.
  const gauged = description?.kind === 'raster' && !description.unplaced ? description.stamp : null;
  React.useEffect(() => {
    if (gauged === null || !visible) return;
    const leaving = new AbortController();
    void readGeoStatistics(target, gauged, leaving.signal).then((outcome) => {
      if (leaving.signal.aborted) return;
      if (!outcome.ok && outcome.code === 'changed') return setChanges((count) => count + 1);
      setMeasured({ target, stamp: gauged, outcome: outcome.ok ? { statistics: outcome.value } : { code: outcome.code } });
    });
    return () => leaving.abort();
  }, [target, gauged, visible]);

  const forms = formsOf(description);
  const several = forms.length > 1;
  // Hidden only while there is a way to show it again: a file may come to hold one form alone.
  const shown = React.useMemo<readonly Form[]>(() => (several ? FORMS.filter((form) => !hidden.includes(form)) : FORMS), [hidden, several]);

  // The file's layers and, of a layer of several forms, which of them are drawn.
  const layerMenu = description && (description.layers.length > 1 || several) ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild nativeButton={false}>
        <div className={cn(dropdownTriggerVariants(), 'w-fit min-w-0 max-w-40 shrink-0')} title={text.layer}>
          <span className="truncate">{description.layer}</span>
          <Icon name="arrow-down-s" />
        </div>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={description.layer}
          onValueChange={(chosen) => {
            setHidden([]);
            setLayer(chosen === opened.current ? undefined : String(chosen));
          }}
        >
          {description.layers.map((each) => (
            <DropdownMenuRadioItem key={each.name} value={each.name}>{each.name}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {several ? <DropdownMenuSeparator /> : null}
        {several ? forms.map(([form, count]) => (
          <DropdownMenuItem
            key={form}
            closeOnClick={false}
            onSelect={() => {
              setPicked(null);
              setHidden(hidden.includes(form) ? hidden.filter((each) => each !== form) : [...hidden, form]);
            }}
          >
            <span className="flex-1">{text.forms[form]}</span>
            <span className="tabular-nums text-muted-foreground">{count.toLocaleString(getCurrentIntlLocale())}</span>
            <Icon name="check" className={cn('size-3', hidden.includes(form) && 'invisible')} />
          </DropdownMenuItem>
        )) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  // What picks a feature and moves the map to it, where there is a map to show it on.
  const mapped = Boolean(description && bounds && !unshown);
  const stamp = description?.stamp;
  const pick = mapped && stamp !== undefined ? (fid: number) => {
    const mine = (picks.current += 1);
    void findGeoFeature(target, stamp, fid).then((outcome) => {
      if (mine !== picks.current) return;
      if (outcome.ok) return setPicked(outcome.value);
      if (outcome.code === 'changed') return setChanges((count) => count + 1);
      setRefused({ code: outcome.code, clicked: true });
    });
  } : undefined;
  const lies = picked?.bounds;
  const reachPicked = mapped && lies ? () => reach.current?.(lies) : undefined;

  const tabs: PanelTab[] = !description ? [] : [
    ...(description.kind === 'vector' ? [
      { id: 'feature', label: text.tabs.feature, content: <FeatureTab picked={picked} total={description.features} text={text} onReach={reachPicked} /> },
      {
        id: 'table',
        label: text.tabs.table,
        // Made anew for other data, from its first row.
        content: <GeoTable key={`${description.layer}\n${description.stamp}`} target={target} description={description} picked={picked} text={text} onPick={pick} onReach={reachPicked} onChanged={() => setChanges((count) => count + 1)} />,
      },
    ] : []),
    ...(description.kind === 'raster' && gauged !== null ? [
      {
        id: 'look',
        label: text.tabs.look,
        content: <LookTab description={description} measured={measured && measured.target === target && measured.stamp === gauged ? measured.outcome : null} look={look} text={text} onLook={setLook} />,
      },
    ] : []),
    ...(description.kind === 'raster' && gauged !== null ? [{ id: 'pixel', label: text.tabs.pixel, content: <PixelTab pixel={pixel} text={text} /> }] : []),
    { id: 'info', label: text.tabs.info, content: <InfoTab description={description} text={text} drawn={look?.bands} /> },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {description ? (
        <div className="flex min-h-9 shrink-0 items-center gap-2.5 border-b border-edge-muted bg-[var(--surface-subtle)] px-3 py-1 typography-meta">
          {layerMenu}
          <div className="min-w-0 flex-1 truncate text-muted-foreground">{factsOf(description, text).filter(Boolean).join(' · ')}</div>
          <Pointer listen={listen} />
        </div>
      ) : null}
      <div ref={shared} className={cn('flex min-h-0 flex-1', beside ? 'flex-row' : 'flex-col')}>
        <div className="relative min-h-0 min-w-0 flex-1">
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
                shown={shown}
                marked={picked?.fid ?? null}
                look={look}
                pixel={pixel}
                onPixel={(found) => {
                  setPixel(found);
                  if (!found) return;
                  setTab('pixel');
                  setOpen(true);
                }}
                view={view}
                reach={reach}
                onPick={(found) => {
                  picks.current += 1;
                  setPicked(found);
                  if (!found) return;
                  // Shown where it is being looked for: in the table when that is open, by its attributes otherwise.
                  if (!open || tab !== 'table') setTab('feature');
                  setOpen(true);
                }}
                onPointer={onPointer}
                onRefused={(code) => (code === 'changed' ? setChanges((count) => count + 1) : setRefused({ code, clicked: false }))}
                onMissed={(code) => (code === 'changed' ? setChanges((count) => count + 1) : setRefused({ code, clicked: true }))}
                onFailed={() => setMapFailed(true)}
              />
            </React.Suspense>
          ) : null}
          {refused && bounds && !unshown ? (
            <div role="alert" className="absolute bottom-2 start-2 flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 typography-meta text-muted-foreground shadow-md">
              {refused.clicked ? text.missed : text.partly}
              <button type="button" aria-label={text.close} title={text.close} className="rounded p-0.5 hover:bg-interactive-hover" onClick={() => setRefused(null)}>
                <Icon name="close" className="size-3.5" />
              </button>
            </div>
          ) : null}
          {beside && !open && tabs.length > 0 ? (
            <button
              type="button"
              className="absolute end-1.5 top-1.5 flex size-7 items-center justify-center text-foreground opacity-80 hover:opacity-100 [filter:drop-shadow(0_0_1.5px_var(--surface-background))_drop-shadow(0_0_1px_var(--surface-background))]"
              aria-label={text.openPanel}
              title={text.openPanel}
              onClick={() => setOpen(true)}
            >
              <Icon name="arrow-left-s" className="size-4" />
            </button>
          ) : null}
        </div>
        <GeoPanel tabs={tabs} active={tab} open={open} beside={beside} room={room.height} text={text} onActive={setTab} onOpen={setOpen} />
      </div>
    </div>
  );
};
