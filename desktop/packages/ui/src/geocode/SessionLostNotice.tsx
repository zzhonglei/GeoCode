import React from 'react';
import { Button } from '@/components/ui/button';
import { restartDesktopApp } from '@/lib/desktop';
import { useI18n, type Locale } from '@/lib/i18n';

type Messages = { title: string; description: string; restart: string };

const MESSAGES: { en: Messages } & Partial<Record<Locale, Messages>> = {
  en: {
    title: 'Restart required',
    description: 'This window lost its connection to the local service. Restart the app to continue.',
    restart: 'Restart app',
  },
  'zh-CN': {
    title: '需要重启应用',
    description: '此窗口与本地服务的连接已失效，重启应用后即可继续。',
    restart: '重启应用',
  },
  'zh-TW': {
    title: '需要重新啟動應用程式',
    description: '此視窗與本機服務的連線已失效，重新啟動應用程式後即可繼續。',
    restart: '重新啟動應用程式',
  },
};

export const SessionLostNotice: React.FC = () => {
  const { locale } = useI18n();
  const messages = MESSAGES[locale] ?? MESSAGES.en;

  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className="space-y-2">
        <h1 className="typography-ui-header font-semibold text-destructive">{messages.title}</h1>
        <p className="typography-meta text-muted-foreground max-w-xs">{messages.description}</p>
      </div>
      <Button type="button" onClick={() => void restartDesktopApp()} className="w-full max-w-xs">
        {messages.restart}
      </Button>
    </div>
  );
};
