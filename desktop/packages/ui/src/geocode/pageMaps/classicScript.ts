// MapLibre's build ending in this one export list; it names each export `local as name`.
const EXPORTS = /export\s*\{([^}]*)\}\s*;?\s*(?:\/\/# sourceMappingURL=\S*\s*)?$/;

/**
 * MapLibre's module build as a classic script that sets the global `maplibregl`: it ships as a module only, and a
 * page's scripts, which run as they are parsed, need it in place before them. Its import.meta.url only names where its
 * worker would be, which the kit sets itself. Throws when the build no longer ends as this reads it.
 */
export const asClassicScript = (source: string): string => {
  const exported = EXPORTS.exec(source);
  if (!exported) throw new Error('MapLibre no longer ends in the export list this reads');
  const names = exported[1]!.split(',').map((pair) => {
    const [local, , name] = pair.trim().split(/\s+/);
    return `${JSON.stringify(name ?? local)}:${local}`;
  });
  const body = source.slice(0, exported.index).replaceAll('import.meta.url', '""');
  return `(function(){${body}\nself.maplibregl={${names.join(',')}};})();`;
};
