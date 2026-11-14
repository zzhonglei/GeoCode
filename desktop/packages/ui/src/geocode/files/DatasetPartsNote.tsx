import React from 'react';

import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { datasetText } from './datasetText';
import { datasetParts, staleOfReplace } from './geoDatasets';

/** Under a delete's question, the sidecars that will be deleted with a dataset's main file, as QGIS lists them. */
export const DatasetPartsNote: React.FC<{ path: string }> = ({ path }) => {
  const { files } = useRuntimeAPIs();
  const { locale } = useI18n();
  const [parts, setParts] = React.useState<{ path: string; names: string[] } | null>(null);

  React.useEffect(() => {
    let current = true;
    // A listing that fails names nothing here; the delete reads the folder again and reports its own failure.
    void datasetParts(files, path).then((names) => {
      if (current) setParts({ path, names });
    }, () => undefined);
    return () => {
      current = false;
    };
  }, [files, path]);

  if (!parts || parts.path !== path || parts.names.length === 0) return null;
  return <span className="mt-2 block">{datasetText(locale).partsGoAlong(parts.names)}</span>;
};

/** Under an upload's replace question, the sidecars of the old data that replacing will delete. */
export const ReplacedPartsNote: React.FC<{ heldBack: readonly File[] }> = ({ heldBack }) => {
  const { locale } = useI18n();
  const parts = staleOfReplace(heldBack);
  if (parts.length === 0) return null;
  return <p className="typography-meta text-muted-foreground">{datasetText(locale).partsReplaced(parts)}</p>;
};
