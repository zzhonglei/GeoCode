import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getDesktopHomeDirectory, invokeDesktop, restartDesktopApp } from '@/lib/desktop';
import { buildOpenCodeStatusReport } from '@/lib/openCodeStatus';
import type { StartupDiagnostics } from '@/lib/startupDiagnostics';
import { useConfigStore } from '@/stores/useConfigStore';
import { GEOCODE_ISSUES_URL } from './brand';
import { readStartupDiagnostics, startupCause, type StartupCause } from './kernelStart';

const DESCRIPTION = {
  kernel: 'The kernel did not start, so the workspace cannot open yet.',
  settings: 'The kernel started, but GeoCode could not read its settings.',
  service: 'The local service did not start, so the workspace cannot open.',
  install: 'The kernel is missing or cannot run. Install GeoCode again.',
} satisfies Record<StartupCause, string>;

// English only, like the error text the page shows.
const TEXT = {
  title: 'GeoCode could not start',
  installTitle: 'The GeoCode installation is incomplete',
  error: 'Error',
  log: 'Log',
  reveal: 'Show in folder',
  retry: 'Retry',
  retrying: 'Retrying…',
  restart: 'Restart app',
  copy: 'Copy diagnostics',
  copied: 'Diagnostics copied',
  report: 'Report a problem on GitHub',
};

const isWindows = (): boolean => /Windows NT/.test(navigator.userAgent);

// Where electron-log writes main.log for an app named GeoCode.
const logLocation = (home: string | null): { shown: string; path: string | null } =>
  isWindows()
    ? { shown: '%APPDATA%\\GeoCode\\logs\\main.log', path: home ? `${home}\\AppData\\Roaming\\GeoCode\\logs\\main.log` : null }
    : { shown: '~/Library/Logs/GeoCode/main.log', path: home ? `${home}/Library/Logs/GeoCode/main.log` : null };

type StartupFailureProps = {
  cause: StartupCause;
  error?: string | null;
  kernelVersion?: string | null;
  onRetry?: () => void;
  isRetrying?: boolean;
};

export const StartupFailure: React.FC<StartupFailureProps> = ({ cause, error, kernelVersion, onRetry, isRetrying = false }) => {
  const { usesFramelessChrome, side } = useDesktopWindowControlsLayout();
  const [home, setHome] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [report, setReport] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void getDesktopHomeDirectory().then((value) => {
      if (!cancelled) setHome(value);
    });
    // Prepared ahead: with the kernel down the report takes a while, and a copy must follow the click at once.
    // It asks the local service; when that is what failed, the page's own facts still get copied.
    void buildOpenCodeStatusReport().then((value) => {
      if (!cancelled) setReport(value);
    }).catch(() => null);
    // Upstream's HTML splash stays up until the app initializes, which a failed start never does.
    document.getElementById('initial-loading')?.remove();
    return () => {
      cancelled = true;
    };
  }, []);

  const title = cause === 'install' ? TEXT.installTitle : TEXT.title;
  const log = logLocation(home);
  const detail = [error?.trim(), kernelVersion ? `Kernel version found: ${kernelVersion}` : null].filter(Boolean).join('\n');

  const handleCopy = async () => {
    const summary = [title, DESCRIPTION[cause], detail, `${TEXT.log}: ${log.shown}`].filter(Boolean).join('\n');
    const result = await copyTextToClipboard(report ? `${summary}\n\n${report}` : summary);
    setCopied(result.ok);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className={`app-region-drag flex h-12 shrink-0 items-center ${side === 'left' ? 'justify-start' : 'justify-end'}`}>
        <WindowsWindowControls visible={usesFramelessChrome} position={side} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-10">
        <div className="my-auto flex w-full max-w-md shrink-0 flex-col items-center gap-5 text-center">
          <OpenChamberLogo width={56} height={56} />
          <div className="space-y-2">
            <h1 className="typography-ui-header text-xl font-semibold">{title}</h1>
            <p className="typography-ui-label text-muted-foreground text-balance">{DESCRIPTION[cause]}</p>
          </div>

          {detail ? (
            <div className="w-full text-left">
              <div className="typography-meta mb-1 text-muted-foreground">{TEXT.error}</div>
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-[var(--surface-muted)] px-3 py-2 font-mono typography-meta select-text">
                {detail}
              </pre>
            </div>
          ) : null}

          <div className="flex w-full items-center justify-between gap-3 text-left">
            <div className="min-w-0">
              <div className="typography-meta text-muted-foreground">{TEXT.log}</div>
              <div className="truncate font-mono typography-meta select-text">{log.shown}</div>
            </div>
            {log.path ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="shrink-0"
                onClick={() => { void invokeDesktop('desktop_reveal_path', { path: log.path }).catch(() => null); }}
              >
                <Icon name="folder-open" className="size-3.5" />
                {TEXT.reveal}
              </Button>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            {onRetry ? (
              <Button type="button" onClick={onRetry} disabled={isRetrying}>
                <Icon name="refresh" className={isRetrying ? 'size-4 animate-spin' : 'size-4'} />
                {isRetrying ? TEXT.retrying : TEXT.retry}
              </Button>
            ) : null}
            <Button type="button" variant={onRetry ? 'ghost' : 'default'} onClick={() => { void restartDesktopApp(); }}>
              {TEXT.restart}
            </Button>
            <Button type="button" variant="ghost" onClick={() => { void handleCopy(); }}>
              {copied ? TEXT.copied : TEXT.copy}
            </Button>
          </div>

          <a
            href={GEOCODE_ISSUES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 typography-meta text-muted-foreground transition-colors hover:text-foreground"
          >
            {TEXT.report}
            <Icon name="external-link" className="size-3" />
          </a>
        </div>
      </div>
    </div>
  );
};

type KernelStartupFailureProps = {
  onRetry: () => void;
  isRetrying: boolean;
};

/** The kernel did not become ready: what the local service reports outranks what the interface guessed. */
export const KernelStartupFailure: React.FC<KernelStartupFailureProps> = ({ onRetry, isRetrying }) => {
  const failure = useConfigStore((state) => state.lastInitFailure);
  const [reported, setReported] = React.useState<StartupDiagnostics | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    void readStartupDiagnostics(controller.signal).then((diagnostics) => {
      if (!controller.signal.aborted) setReported(diagnostics);
    });
    return () => controller.abort();
  }, []);

  const cause = startupCause(failure?.step, reported);
  // Retrying cannot find a kernel that is not there.
  if (cause === 'install') return <StartupFailure cause={cause} error={reported?.error} />;
  return <StartupFailure cause={cause} error={reported?.error ?? failure?.message} onRetry={onRetry} isRetrying={isRetrying} />;
};
