/* --- GeoCode: the desktop shell's About dialog, which App.tsx mounts in place of upstream's
 * (docs/DESKTOP.md §4.6). --- */
import React from 'react';

import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { useI18n } from '@/lib/i18n';

declare const __APP_VERSION__: string | undefined;

export const GEOCODE_REPOSITORY_URL = 'https://github.com/zzhonglei/GeoCode-Release';

interface GeoCodeAboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const GeoCodeAboutDialog: React.FC<GeoCodeAboutDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const version = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs p-8">
        <div className="flex flex-col items-center text-center space-y-5">
          <OpenChamberLogo width={64} height={64} />

          <div className="space-y-1">
            <h2 className="text-lg font-semibold">GeoCode</h2>
            {version && (
              <p className="typography-meta text-muted-foreground">
                {t('aboutDialog.versionLabel', { version })}
              </p>
            )}
          </div>

          <a
            href={GEOCODE_REPOSITORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 typography-meta text-muted-foreground hover:text-foreground transition-colors"
          >
            <Icon name="github-fill" className="h-4 w-4" />
            <span>GitHub</span>
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
};
