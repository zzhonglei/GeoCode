/* --- GeoCode: the desktop section of the general settings page (docs/DESKTOP.md §7.3).
 *
 * Upstream's DesktopNetworkSettings pairs the machine options with LAN access and the UI
 * password that guards it. GeoCode listens on loopback only (§6.1), so this component keeps
 * the four machine options, with upstream's IPC calls, search ids and strings, and leaves the
 * network half out. The menu bar option still saves through the settings file and restarts,
 * as upstream's does, because the tray is created once at start-up. OpenChamberPage mounts
 * this in place of the upstream section in the desktop shell. --- */
import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  getDesktopKeepAwake,
  getDesktopLaunchAtLogin,
  getDesktopMinimizeToTray,
  isDesktopLocalOriginActive,
  isDesktopShell,
  restartDesktopApp,
  setDesktopKeepAwake,
  setDesktopLaunchAtLogin,
  setDesktopMinimizeToTray,
} from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  SettingsSection,
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';

export const GeoCodeDesktopSettings: React.FC = () => {
  const { t } = useI18n();
  const isLocalDesktop = isDesktopShell() && isDesktopLocalOriginActive();
  const isMacDesktop = isLocalDesktop
    && typeof window !== 'undefined'
    && window.__OPENCHAMBER_PLATFORM__ === 'darwin';
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [launchAtLoginSupported, setLaunchAtLoginSupported] = React.useState(false);
  const [launchAtLoginEnabled, setLaunchAtLoginEnabled] = React.useState(false);
  const [isSavingLaunchAtLogin, setIsSavingLaunchAtLogin] = React.useState(false);
  const [minimizeToTraySupported, setMinimizeToTraySupported] = React.useState(false);
  const [minimizeToTrayEnabled, setMinimizeToTrayEnabled] = React.useState(false);
  const [isSavingMinimizeToTray, setIsSavingMinimizeToTray] = React.useState(false);
  const [savedMacMenuBarEnabled, setSavedMacMenuBarEnabled] = React.useState(true);
  const [draftMacMenuBarEnabled, setDraftMacMenuBarEnabled] = React.useState(true);
  const [keepAwakeSupported, setKeepAwakeSupported] = React.useState(false);
  const [keepAwakeEnabled, setKeepAwakeEnabled] = React.useState(false);
  const [isSavingKeepAwake, setIsSavingKeepAwake] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!isMacDesktop) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await runtimeFetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(t('settings.openchamber.desktopNetwork.error.loadFailed'));
        }

        const data = (await response.json().catch(() => null)) as null | {
          desktopMacMenuBarEnabled?: unknown;
        };
        if (cancelled) {
          return;
        }

        const macMenuBarEnabled = data?.desktopMacMenuBarEnabled !== false;
        setSavedMacMenuBarEnabled(macMenuBarEnabled);
        setDraftMacMenuBarEnabled(macMenuBarEnabled);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.loadFailed'));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isMacDesktop, t]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setLaunchAtLoginSupported(false);
      setMinimizeToTraySupported(false);
      setKeepAwakeSupported(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      const [launchAtLogin, minimizeToTray, keepAwake] = await Promise.all([
        getDesktopLaunchAtLogin(),
        getDesktopMinimizeToTray(),
        getDesktopKeepAwake(),
      ]);
      if (cancelled) {
        return;
      }
      setLaunchAtLoginSupported(launchAtLogin?.supported === true);
      setLaunchAtLoginEnabled(launchAtLogin?.enabled === true);
      setMinimizeToTraySupported(minimizeToTray?.supported === true);
      setMinimizeToTrayEnabled(minimizeToTray?.enabled === true);
      setKeepAwakeSupported(keepAwake?.supported === true);
      setKeepAwakeEnabled(keepAwake?.enabled === true);
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop]);

  const isDirty = draftMacMenuBarEnabled !== savedMacMenuBarEnabled;
  const saveDisabled = isLoading || isSaving || !isDirty;

  const handleLaunchAtLoginToggle = React.useCallback(async () => {
    if (!launchAtLoginSupported || isSavingLaunchAtLogin) {
      return;
    }

    const nextValue = !launchAtLoginEnabled;
    setLaunchAtLoginEnabled(nextValue);
    setIsSavingLaunchAtLogin(true);
    setError(null);

    try {
      const status = await setDesktopLaunchAtLogin(nextValue);
      if (!status?.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.launchAtLoginUnsupported'));
      }
      setLaunchAtLoginEnabled(status.enabled);
    } catch (cause) {
      setLaunchAtLoginEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.launchAtLoginSaveFailed'));
    } finally {
      setIsSavingLaunchAtLogin(false);
    }
  }, [isSavingLaunchAtLogin, launchAtLoginEnabled, launchAtLoginSupported, t]);

  const handleMinimizeToTrayToggle = React.useCallback(async () => {
    if (!minimizeToTraySupported || isSavingMinimizeToTray) {
      return;
    }

    const nextValue = !minimizeToTrayEnabled;
    setMinimizeToTrayEnabled(nextValue);
    setIsSavingMinimizeToTray(true);
    setError(null);

    try {
      const status = await setDesktopMinimizeToTray(nextValue);
      if (!status) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.minimizeToTraySaveFailed'));
      }
      if (!status.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.minimizeToTrayUnsupported'));
      }
      setMinimizeToTrayEnabled(status.enabled);
    } catch (cause) {
      setMinimizeToTrayEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.minimizeToTraySaveFailed'));
    } finally {
      setIsSavingMinimizeToTray(false);
    }
  }, [isSavingMinimizeToTray, minimizeToTrayEnabled, minimizeToTraySupported, t]);

  const handleKeepAwakeToggle = React.useCallback(async () => {
    if (!keepAwakeSupported || isSavingKeepAwake) {
      return;
    }

    const nextValue = !keepAwakeEnabled;
    setKeepAwakeEnabled(nextValue);
    setIsSavingKeepAwake(true);
    setError(null);

    try {
      const status = await setDesktopKeepAwake(nextValue);
      if (!status?.supported) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.keepAwakeUnsupported'));
      }
      setKeepAwakeEnabled(status.enabled);
    } catch (cause) {
      setKeepAwakeEnabled(!nextValue);
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.keepAwakeSaveFailed'));
    } finally {
      setIsSavingKeepAwake(false);
    }
  }, [isSavingKeepAwake, keepAwakeEnabled, keepAwakeSupported, t]);

  const handleSaveAndRestart = React.useCallback(async () => {
    if (!isDirty) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const response = await runtimeFetch('/api/config/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          desktopMacMenuBarEnabled: draftMacMenuBarEnabled,
        }),
      });

      if (!response.ok) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.saveFailed'));
      }

      setSavedMacMenuBarEnabled(draftMacMenuBarEnabled);

      const restarted = await restartDesktopApp();
      if (!restarted) {
        throw new Error(t('settings.openchamber.desktopNetwork.error.savedRestartFailed'));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopNetwork.error.saveFailed'));
      setIsSaving(false);
    }
  }, [draftMacMenuBarEnabled, isDirty, t]);

  if (!isLocalDesktop) {
    return null;
  }

  return (
    <SettingsSection title={t('settings.openchamber.desktopNetwork.title')}>
      <div className="space-y-3">
        {(launchAtLoginSupported || isMacDesktop || minimizeToTraySupported || keepAwakeSupported) ? (
          <div className={SETTINGS_OPTION_STACK_CLASS}>
            {launchAtLoginSupported ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-launch-at-login"
                checked={launchAtLoginEnabled}
                onChange={(checked) => {
                  if (checked === launchAtLoginEnabled) return;
                  void handleLaunchAtLoginToggle();
                }}
                disabled={isSavingLaunchAtLogin}
                label={t('settings.openchamber.desktopNetwork.field.launchAtLogin')}
                info={t('settings.openchamber.desktopNetwork.field.launchAtLoginDescription')}
                ariaLabel={t('settings.openchamber.desktopNetwork.field.launchAtLoginAria')}
              />
            ) : null}

            {isMacDesktop ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-mac-menu-bar"
                checked={draftMacMenuBarEnabled}
                onChange={setDraftMacMenuBarEnabled}
                disabled={isLoading || isSaving}
                label={t('settings.openchamber.desktopNetwork.field.macMenuBar')}
                info={t('settings.openchamber.desktopNetwork.field.macMenuBarDescription')}
                ariaLabel={t('settings.openchamber.desktopNetwork.field.macMenuBarAria')}
              />
            ) : null}

            {minimizeToTraySupported ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-minimize-to-tray"
                checked={minimizeToTrayEnabled}
                onChange={(checked) => {
                  if (checked === minimizeToTrayEnabled) return;
                  void handleMinimizeToTrayToggle();
                }}
                disabled={isSavingMinimizeToTray}
                label={t('settings.openchamber.desktopNetwork.field.minimizeToTray')}
                info={t('settings.openchamber.desktopNetwork.field.minimizeToTrayDescription')}
                ariaLabel={t('settings.openchamber.desktopNetwork.field.minimizeToTrayAria')}
              />
            ) : null}

            {keepAwakeSupported ? (
              <SettingsCheckboxRow
                settingsItem="sessions.desktop-keep-awake"
                checked={keepAwakeEnabled}
                onChange={(checked) => {
                  if (checked === keepAwakeEnabled) return;
                  void handleKeepAwakeToggle();
                }}
                disabled={isSavingKeepAwake}
                label={t('settings.openchamber.desktopNetwork.field.keepAwake')}
                info={t('settings.openchamber.desktopNetwork.field.keepAwakeDescription')}
                ariaLabel={t('settings.openchamber.desktopNetwork.field.keepAwakeAria')}
              />
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div className="typography-micro text-[var(--status-error)]">{error}</div>
        ) : null}

        {isMacDesktop ? (
          <div className="flex justify-start py-1.5">
            <Button
              type="button"
              size="xs"
              onClick={handleSaveAndRestart}
              disabled={saveDisabled}
              className="shrink-0 !font-normal"
            >
              {isSaving ? t('settings.common.actions.saving') : t('settings.openchamber.desktopNetwork.actions.saveAndRestart')}
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
};
