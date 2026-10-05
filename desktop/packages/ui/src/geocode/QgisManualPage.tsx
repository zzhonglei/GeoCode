import React from 'react';

import { readEventPayload } from '@/components/browser/useWebviewNavigation';
import { isElectronShell } from '@/lib/desktop';

/** The browser panel's session, hardened in the main process; must match BROWSER_PANEL_PARTITION in electron/main.mjs. */
const PARTITION = 'persist:geocode-browser';

/** Taken from the start, so the card does not change height when the page replaces the text. */
const HEIGHT = 400;

/** How long a page may take before the text stands for it. */
const LOAD_TIMEOUT_MS = 15_000;

// The page's own zoom: the webview's is shared per site with the browser panel. Zooming moves the linked section.
const SMALLER = `
document.documentElement.style.zoom = '0.7';
document.getElementById(location.hash.slice(1))?.scrollIntoView();
`;

type Load = 'loading' | 'shown' | 'failed';

/**
 * A page of the QGIS manual as the manual draws it, at the section its link names. The text webfetch returned
 * stands in while the page loads, and stays when it cannot: offline, an error page, or no webview outside the app.
 */
export const QgisManualPage: React.FC<{
  url: string;
  /** Told once the page shows in place of the text. */
  onShown: () => void;
  children: React.ReactNode;
}> = ({ url, onShown, children }) => {
  const [load, setLoad] = React.useState<Load>(isElectronShell() ? 'loading' : 'failed');

  // Listening from the moment the element is attached: a cached page is ready before an effect would run.
  const attach = React.useCallback((webview: WebviewElement | null) => {
    if (!webview) return;
    // Once shown, the page is the user's to browse; a later failure there is not the manual failing to load.
    const fail = () => setLoad((current) => (current === 'loading' ? 'failed' : current));
    const onFailLoad = (event: Event) => {
      const detail = readEventPayload<{ errorCode?: number; isMainFrame?: boolean }>(event);
      // Superseded navigations and sub-resources are not the page failing.
      if (detail.isMainFrame === false || detail.errorCode === -3) return;
      fail();
    };
    const onNavigate = (event: Event) => {
      const status = readEventPayload<{ httpResponseCode?: number }>(event).httpResponseCode ?? 0;
      if (status >= 400) fail();
    };
    // Shown once the document is there and zoomed, without waiting for every image of the page.
    const onDomReady = () =>
      webview.executeJavaScript(SMALLER).then(
        () => setLoad((current) => (current === 'loading' ? 'shown' : current)),
        fail,
      );
    const timer = setTimeout(fail, LOAD_TIMEOUT_MS);
    webview.addEventListener('did-fail-load', onFailLoad);
    webview.addEventListener('did-navigate', onNavigate);
    webview.addEventListener('dom-ready', onDomReady);
    return () => {
      clearTimeout(timer);
      webview.removeEventListener('did-fail-load', onFailLoad);
      webview.removeEventListener('did-navigate', onNavigate);
      webview.removeEventListener('dom-ready', onDomReady);
    };
  }, []);

  React.useEffect(() => {
    if (load === 'shown') onShown();
  }, [load, onShown]);

  if (load === 'failed') return <>{children}</>;
  const shown = load === 'shown';
  return (
    <div className="relative overflow-hidden rounded-lg border border-border/30" style={{ height: HEIGHT }}>
      <div className={shown ? 'h-full' : 'pointer-events-none invisible h-full'}>
        <webview ref={attach} src={url} partition={PARTITION} style={{ width: '100%', height: '100%', border: 'none' }} />
      </div>
      {shown ? null : <div className="absolute inset-0 overflow-auto">{children}</div>}
    </div>
  );
};
