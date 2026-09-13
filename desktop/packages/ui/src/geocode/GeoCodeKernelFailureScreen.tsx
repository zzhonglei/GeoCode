/* --- GeoCode: the screen for a kernel that did not come up (docs/DESKTOP.md §5.1).
 *
 * The desktop shell has one host, this machine, so a boot that does not reach the main view
 * has one meaning: the embedded kernel failed to start. Upstream answers that case with its
 * recovery screens, which offer to install OpenCode or connect to another server; neither
 * applies. This shows what the main process recorded (geocode/kernel-failure.mjs): the error,
 * the kernel's last lines, and where the log is. Retry relaunches the app. The layout follows
 * upstream's recovery card with the app mark on top, as the About dialog does (the mark changes
 * with the rest of the branding, later); the strings live here because they are GeoCode's own
 * and the dictionaries demand every key in every language. --- */
import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { invokeDesktop } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';

export interface KernelFailure {
  message: string;
  output: string[];
  logPath: string | null;
  at: string;
}

interface Strings {
  title: string;
  description: string;
  errorLabel: string;
  outputLabel: string;
  logLabel: string;
  reveal: string;
  retry: string;
  retrying: string;
  unknown: string;
}

const STRINGS: Record<'en' | 'zh-CN' | 'zh-TW', Strings> = {
  en: {
    title: 'GeoCode could not start its kernel',
    description: 'The built-in kernel did not start, so the workspace cannot open. The details below and the log file say what went wrong.',
    errorLabel: 'Error',
    outputLabel: 'Last lines from the kernel',
    logLabel: 'Log file',
    reveal: 'Show in folder',
    retry: 'Retry',
    retrying: 'Restarting…',
    unknown: 'No details were recorded.',
  },
  'zh-CN': {
    title: 'GeoCode 内核未能启动',
    description: '内置内核没有启动，工作区无法打开。下面的错误信息与日志文件说明了原因。',
    errorLabel: '错误',
    outputLabel: '内核最后输出',
    logLabel: '日志文件',
    reveal: '在文件夹中显示',
    retry: '重试',
    retrying: '正在重新启动…',
    unknown: '没有记录到详细信息。',
  },
  'zh-TW': {
    title: 'GeoCode 核心未能啟動',
    description: '內建核心沒有啟動，工作區無法開啟。下面的錯誤資訊與記錄檔說明了原因。',
    errorLabel: '錯誤',
    outputLabel: '核心最後輸出',
    logLabel: '記錄檔',
    reveal: '在資料夾中顯示',
    retry: '重試',
    retrying: '正在重新啟動…',
    unknown: '沒有記錄到詳細資訊。',
  },
};

const stringsFor = (locale: string): Strings =>
  STRINGS[locale as keyof typeof STRINGS] ?? STRINGS.en;

interface GeoCodeKernelFailureScreenProps {
  onRetry: () => void | Promise<void>;
}

export const GeoCodeKernelFailureScreen: React.FC<GeoCodeKernelFailureScreenProps> = ({ onRetry }) => {
  const { locale } = useI18n();
  const s = stringsFor(locale);
  const [failure, setFailure] = React.useState<KernelFailure | null>(null);
  const [isRetrying, setIsRetrying] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const recorded = await invokeDesktop<KernelFailure | null>('geocode_kernel_failure').catch(() => null);
      if (!cancelled) setFailure(recorded ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRetry = React.useCallback(async () => {
    setIsRetrying(true);
    try {
      await onRetry();
    } finally {
      setIsRetrying(false);
    }
  }, [onRetry]);

  const handleReveal = React.useCallback(() => {
    if (!failure?.logPath) return;
    void invokeDesktop('desktop_reveal_path', { path: failure.logPath }).catch(() => null);
  }, [failure?.logPath]);

  return (
    <div className="flex flex-col items-center justify-center h-full p-8">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center space-y-3 text-center">
          <OpenChamberLogo width={64} height={64} />
          <h1 className="typography-ui-header text-xl font-semibold text-foreground">{s.title}</h1>
          <p className="text-muted-foreground text-sm max-w-sm">{s.description}</p>
        </div>

        <div className="rounded-lg border border-border bg-background/50 p-3">
          <div className="text-xs text-muted-foreground mb-1">{s.errorLabel}</div>
          <div className="font-mono text-sm text-foreground whitespace-pre-wrap break-words">
            {failure?.message || s.unknown}
          </div>
        </div>

        {failure && failure.output.length > 0 ? (
          <div className="rounded-lg border border-border bg-background/50 p-3">
            <div className="text-xs text-muted-foreground mb-1">{s.outputLabel}</div>
            <pre className="font-mono text-xs text-foreground whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {failure.output.join('\n')}
            </pre>
          </div>
        ) : null}

        {failure?.logPath ? (
          <div className="rounded-lg border border-border bg-background/50 p-3">
            <div className="text-xs text-muted-foreground mb-1">{s.logLabel}</div>
            <div className="flex items-center justify-between gap-3">
              <div className="font-mono text-sm text-foreground truncate">{failure.logPath}</div>
              <Button type="button" variant="ghost" size="xs" onClick={handleReveal} className="shrink-0">
                <Icon name="folder-open" className="h-4 w-4" />
                {s.reveal}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <Button type="button" onClick={() => { void handleRetry(); }} disabled={isRetrying}>
            <Icon name="refresh" className={isRetrying ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
            {isRetrying ? s.retrying : s.retry}
          </Button>
        </div>
      </div>
    </div>
  );
};
