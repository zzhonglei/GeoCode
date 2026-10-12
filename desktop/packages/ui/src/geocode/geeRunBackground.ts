import type { Metadata, ToolPart, ToolStateCompleted } from '@/lib/opencode/model';

type Completed = ToolPart & { state: ToolStateCompleted };

/**
 * Whether a call is a geerun run that went on in the background: its answer came once the script began, marked
 * running, which it stays; the run went on until the notification that ends it.
 */
export const isBackgroundGeeRun = (part: ToolPart): part is Completed =>
  part.tool === 'geerun' && part.state.status === 'completed' && part.state.metadata?.status === 'running';

/**
 * Whether the reducer takes progress for a call it holds as completed: the kernel tells a geerun run in the background
 * on its bus, marked running, as long as the run goes on.
 */
export const takesBackgroundProgress = (part: ToolPart, metadata: Metadata): part is Completed =>
  isBackgroundGeeRun(part) && metadata.status === 'running';
