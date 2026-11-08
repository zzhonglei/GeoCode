import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { EnvironmentVariablesEditor } from '@/components/sections/shared/EnvironmentVariablesEditor';
import { fetchUserEnvironment, updateUserEnvironment, type EnvironmentVariablesPatch } from '@/lib/environmentApi';
import { reportSettingsSaveState } from '@/lib/persistence';
/* --- GeoCode: see handleRestart ---
import { restartOpenCodeWithFeedback } from '@/lib/restartOpenCode';
--- /GeoCode --- */
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useI18n } from '@/lib/i18n';
import { restartDesktopApp } from '@/lib/desktop'; // GeoCode: see handleRestart
import { restartAppLabel } from '@/geocode/brand'; // GeoCode: see handleRestart

type LoadState =
  | { state: 'loading' }
  | { state: 'ready'; names: string[] }
  | { state: 'failed' };

/**
 * Variables for everything OpenChamber starts: OpenCode, Git, the terminal and
 * project actions. OpenCode reads its environment once, at start, so a change
 * reaches it after a restart; Git and the terminal get it on their next run.
 */
export const EnvironmentVariablesSettings: React.FC = () => {
  const { t, locale } = useI18n(); // GeoCode: see the restart button
  const enterpriseMode = useEnterpriseMode();
  const [load, setLoad] = React.useState<LoadState>({ state: 'loading' });
  const [changed, setChanged] = React.useState(false);
  const [restarting, setRestarting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    fetchUserEnvironment()
      .then((environment) => {
        if (!cancelled) setLoad({ state: 'ready', names: environment.names });
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: 'failed' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = React.useCallback(async (patch: EnvironmentVariablesPatch): Promise<boolean> => {
    reportSettingsSaveState('saving');
    try {
      const environment = await updateUserEnvironment(patch);
      setLoad({ state: 'ready', names: environment.names });
      setChanged(true);
      reportSettingsSaveState('saved');
      return true;
    } catch {
      reportSettingsSaveState('error');
      toast.error(t('settings.environment.editor.saveFailed'));
      return false;
    }
  }, [t]);

  // --- GeoCode: the whole app restarts, since the geo engine reads the variables only as it starts. As the app's other
  // restart buttons do, the button stays at "Restarting…" until the app exits, and after a failure it stays to retry ---
  const handleRestart = React.useCallback(async () => {
    setRestarting(true);
    if (await restartDesktopApp()) return;
    setRestarting(false);
    toast.error(t('settings.openchamber.desktopNetwork.error.savedRestartFailed'));
  }, [t]);
  /*
  const handleRestart = React.useCallback(async () => {
    setRestarting(true);
    try {
      await restartOpenCodeWithFeedback(t);
      setChanged(false);
    } finally {
      setRestarting(false);
    }
  }, [t]);
  */
  // --- /GeoCode ---

  return (
    <SettingsSection
      title={t('settings.environment.user.title')}
      info={t('settings.environment.user.info')}
      settingsItem="general.environment-variables"
    >
      <div className="space-y-3">
        {enterpriseMode ? (
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.environment.user.enterpriseNote')}</p>
        ) : null}
        {load.state === 'failed' ? (
          <p className="typography-meta text-[var(--status-error)]">{t('settings.environment.editor.loadFailed')}</p>
        ) : (
          <EnvironmentVariablesEditor
            names={load.state === 'ready' ? load.names : []}
            disabled={load.state !== 'ready'}
            onSet={(name, value) => save({ [name]: value })}
            onRemove={(name) => save({ [name]: null })}
          />
        )}
        {changed && !enterpriseMode ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.environment.user.restartNote')}</p>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void handleRestart()}
              disabled={restarting}
              className="shrink-0 !font-normal"
            >
              {restarting
                ? t('settings.openchamber.visual.actions.restarting') // GeoCode: the whole app restarts
                : restartAppLabel(locale) /* GeoCode: the whole app restarts */}
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
};
