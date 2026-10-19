import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/fonts';
import '@/styles/katex-css';
import '@/index.css';
import '@/lib/debug';
import { SessionAuthGate } from '@/components/auth/SessionAuthGate';
import { GeoEngineGate } from '@/geocode/GeoEngineGate'; // GeoCode: see renderElectronMiniChatApp
import { ThemeProvider } from '@/components/providers/ThemeProvider';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { I18nProvider } from '@/lib/i18n';
import { ElectronMiniChatApp } from './ElectronMiniChatApp';
import { initializeSharedPreferences } from './initializeSharedPreferences';

export function renderElectronMiniChatApp(apis: RuntimeAPIs) {
  initializeSharedPreferences({ logLabel: '[mini-chat-main]' });

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Root element not found');
  }

  createRoot(rootElement).render(
    <StrictMode>
      <I18nProvider>
        <ThemeSystemProvider>
          <ThemeProvider>
            <SessionAuthGate>
              {/* GeoCode: GeoEngine stopping means the app itself is broken, so this window says so too */}
              <GeoEngineGate><ElectronMiniChatApp apis={apis} /></GeoEngineGate>
            </SessionAuthGate>
          </ThemeProvider>
        </ThemeSystemProvider>
      </I18nProvider>
    </StrictMode>,
  );
}
