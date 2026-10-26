import React from 'react';

import { cn } from '@/lib/utils';

/**
 * What a row opens to, sliding open and closed under it. Rendered from its first opening on, so the rows of a long
 * history cost nothing until they are opened, and a closing one still has its content to slide away.
 */
export const Slide: React.FC<{ open: boolean; children: React.ReactNode }> = ({ open, children }) => {
  const [opened, setOpened] = React.useState(open);
  if (open && !opened) setOpened(true);
  return (
    <div
      aria-hidden={!open}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
        open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
      )}
    >
      <div className="min-h-0 overflow-hidden">{opened ? children : null}</div>
    </div>
  );
};
