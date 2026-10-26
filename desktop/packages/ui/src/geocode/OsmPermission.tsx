import React from 'react';
import { z } from 'zod';

import { useI18nStore, type Locale } from '@/lib/i18n';
import type { Message } from '@/lib/opencode/model';
import { formatPathForDisplay } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionMessagesSelector } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import type { PermissionRequest } from '@/types/permission';

import { geoCardText } from './geoTools';
import { osmText, type OsmText } from './osmText';
import { isOsmId, osmArea, osmNames } from './osmView';
import { Labelled, Warning } from './QgisRunPermission';

const filled = z.string().trim().min(1).optional().catch(undefined);
const list = z.array(z.string()).min(1).optional().catch(undefined);

/**
 * What the kernel tells an OSM tool's card in its asking's metadata: the call's input, and for a download the output
 * and the directories outside the project it writes in.
 */
const asking = z.object({
  description: filled,
  name: filled,
  context: filled,
  category: filled,
  term: filled,
  tags: list,
  keys: list,
  area: filled,
  ids: list,
  geometry: filled,
  output: filled,
  external: z.array(z.string()).catch([]),
});

type Names = Readonly<Record<string, string>>;

/** A place: an OSM id with the name the session's searches found for it, or a point as written. */
const Place: React.FC<{ place: string; names: Names }> = ({ place, names }) => {
  if (!isOsmId(place)) return place;
  // As the tools read it, and the searches found it: r123 is R123.
  const written = place.toUpperCase();
  const name = names[written];
  const id = <span className={name ? 'ms-1 font-mono text-muted-foreground' : 'font-mono'}>{written}</span>;
  return name ? (
    <>
      {name}
      {id}
    </>
  ) : (
    id
  );
};

const Places: React.FC<{ places: readonly string[]; names: Names; words: OsmText['card'] }> = ({
  places,
  names,
  words,
}) =>
  places.map((place, index) => (
    <React.Fragment key={place}>
      {index > 0 ? words.separator : null}
      <Place place={place} names={names} />
    </React.Fragment>
  ));

/** Where a call looks, worded for the user. */
const Area: React.FC<{ area: string; names: Names; words: OsmText['card']; home: string }> = ({
  area,
  names,
  words,
  home,
}) => {
  const parsed = osmArea(area);
  if (parsed.kind === 'objects') return <Places places={parsed.places} names={names} words={words} />;
  if (parsed.kind === 'box') return words.box(parsed.from, parsed.to);
  if (parsed.kind === 'file') return words.file(formatPathForDisplay(parsed.path, home), parsed.layer);
  if (parsed.kind === 'text') return parsed.text;
  const [before, after] = words.around(parsed.meters);
  return (
    <>
      {before}
      <Places places={parsed.places} names={names} words={words} />
      {after}
    </>
  );
};

/**
 * An OSM tool's permission card, line by line (docs/OSM.md, section 8). A download's says why GeoAgent asks, warns of a
 * write outside the project, then what it downloads and where it writes; a search's and a look's say in a line what
 * they look for and where.
 */
export const OsmPermissionBody: React.FC<{
  permission: PermissionRequest;
  names: Names;
  locale: Locale;
  home: string;
}> = ({ permission, names, locale, home }) => {
  const parsed = asking.safeParse(permission.metadata ?? {});
  if (!parsed.success) return null;
  const call = parsed.data;
  const text = geoCardText(locale);
  const all = osmText(locale);
  const words = all.card;
  const label = (name: string) => `${name}${text.colon}`;
  const area = call.area ? (
    <Labelled label={label(words.area)}>
      <Area area={call.area} names={names} words={words} home={home} />
    </Labelled>
  ) : null;

  if (permission.action === 'osmsearch') {
    return (
      <div className="flex min-w-0 flex-col gap-1 px-2 py-2">
        <Labelled label={label(words.search)}>
          {call.name}
          {call.context ? (
            <>
              {' · '}
              <Place place={call.context} names={names} />
            </>
          ) : null}
          {call.category ? ` · ${words.only(call.category)}` : null}
        </Labelled>
      </div>
    );
  }

  if (permission.action === 'osmprobe') {
    const [before, after] = words.counts;
    return (
      <div className="flex min-w-0 flex-col gap-1 px-2 py-2">
        <Labelled label={label(words.look)}>
          {call.term ? words.term(call.term) : null}
          {call.tags ? (
            <>
              {before}
              <span className="font-mono">{call.tags.join(', ')}</span>
              {after}
            </>
          ) : null}
          {call.keys ? all.values(call.keys.join(', ')) : null}
        </Labelled>
        {area}
      </div>
    );
  }

  const outside = call.external.length > 0;
  return (
    <div className="flex min-w-0 flex-col gap-1 px-2 py-2">
      {call.description ? <Labelled label={label(text.reason)}>{call.description}</Labelled> : null}
      {call.external.map((directory) => (
        <Warning key={directory}>{text.outside(formatPathForDisplay(directory, home))}</Warning>
      ))}
      {call.ids ? (
        <Labelled label={label(words.objects)}>
          <Places places={call.ids} names={names} words={words} />
        </Labelled>
      ) : null}
      {call.tags ? (
        <Labelled label={words.tags} mono>
          {call.tags.join(', ')}
        </Labelled>
      ) : null}
      {area}
      {call.geometry === 'point' ? <Labelled label={label(words.geometry)}>{words.point}</Labelled> : null}
      {call.output ? (
        <Labelled label={text.output} mono wrap>
          <span className={outside ? 'text-[var(--status-warning)]' : undefined}>
            {formatPathForDisplay(call.output, home)}
          </span>
        </Labelled>
      ) : null}
    </div>
  );
};

const sameNames = (left: Names, right: Names) => {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
};

const namesIn = (messages: Message[], state: State) =>
  osmNames(messages.flatMap((message) => state.part[message.id] ?? []));

/** An OSM tool's permission card, the objects it names called by what the session's searches found them to be. */
export const OsmPermission: React.FC<{ permission: PermissionRequest }> = ({ permission }) => {
  // Subscribed so the card follows a change of language.
  const locale = useI18nStore((state) => state.locale);
  const home = useDirectoryStore((state) => state.homeDirectory);
  const names = useSessionMessagesSelector(permission.sessionID, undefined, namesIn, sameNames, true);
  return <OsmPermissionBody permission={permission} names={names} locale={locale} home={home} />;
};
