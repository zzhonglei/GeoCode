import React from 'react';

import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { getDesktopAppVersion } from '@/lib/desktopNative';
import { useI18n } from '@/lib/i18n';
import { GEOCODE_REPOSITORY_URL } from './brand';

interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const AboutDialog: React.FC<AboutDialogProps> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const [version, setVersion] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getDesktopAppVersion().then((value) => {
      if (!cancelled) setVersion(value);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xs p-8">
        <div className="flex flex-col items-center text-center space-y-5">
          <OpenChamberLogo width={96} height={96} className="-my-3" />

          <div className="space-y-1">
            <h2 className="text-lg font-semibold">GeoCode</h2>
            {version && (
              <p className="typography-meta text-muted-foreground">{t('aboutDialog.versionLabel', { version })}</p>
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
