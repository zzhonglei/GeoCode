import React from 'react';
import { SettingsCheckboxRow, SettingsInset, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { JevAccessNote } from '@/components/sections/classification/JevAccessNote';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { selectSafetyNetAvailable, useRoutingStore } from '@/stores/useRoutingStore';
import { Closed } from '@/geocode/Closed'; // GeoCode: see the auto-open row

/**
 * "In work": the sidebar block and the Track / Done actions, and whether Jev
 * moves sessions in on its own. Jev runs on the OpenChamber server, so VS Code
 * offers only the manual part.
 */
export const SessionWorkSettings: React.FC = () => {
  const { t } = useI18n();
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const enabled = useUIStore((state) => state.sessionWorkEnabled);
  const autoOpen = useUIStore((state) => state.sessionWorkAutoOpen);
  const setEnabled = useUIStore((state) => state.setSessionWorkEnabled);
  const setAutoOpen = useUIStore((state) => state.setSessionWorkAutoOpen);
  const jevAvailable = useRoutingStore(selectSafetyNetAvailable);

  return (
    <SettingsSection
      title={t('settings.openchamber.sessionWork.title')}
      info={t('settings.openchamber.sessionWork.info')}
      settingsItem="sessions.work"
    >
      <SettingsCheckboxRow
        settingsItem="sessions.work-enabled"
        checked={enabled}
        onChange={setEnabled}
        label={t('settings.openchamber.sessionWork.field.enabled')}
        ariaLabel={t('settings.openchamber.sessionWork.field.enabled')}
      />
      {/* --- GeoCode: sessions move in on their own only through Jev, which is off --- */}
      <Closed>
      {!isVSCode ? (
        <SettingsInset className="space-y-0">
          <SettingsCheckboxRow
            settingsItem="sessions.work-auto-open"
            checked={enabled && jevAvailable && autoOpen}
            onChange={setAutoOpen}
            disabled={!enabled || !jevAvailable}
            label={t('settings.openchamber.sessionWork.field.autoOpen')}
            ariaLabel={t('settings.openchamber.sessionWork.field.autoOpen')}
            info={t('settings.openchamber.sessionWork.field.autoOpenInfo')}
          />
          <JevAccessNote />
        </SettingsInset>
      ) : null}
      </Closed>
      {/* --- /GeoCode --- */}
    </SettingsSection>
  );
};
