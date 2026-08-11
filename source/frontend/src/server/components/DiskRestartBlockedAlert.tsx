import Alert from '@/elements/Alert.tsx';
import { formatBytes } from '@/lib/chart.ts';
import type { DbevDiskResourceReport } from '../../api/types.ts';
import translations from '../../translations.ts';

export default function DiskRestartBlockedAlert({ disk }: { disk?: DbevDiskResourceReport | null }) {
  const { t } = translations.useTranslations();
  if (disk?.scanner_restart_blocked !== true) return null;

  const recoveryThreshold = optionalNumber(disk.scanner_recovery_threshold_bytes);

  return (
    <Alert color='red' title={t('server.diskEnforcement.restartBlockedTitle', {})}>
      {t('server.diskEnforcement.restartBlockedDescription', {
        threshold:
          recoveryThreshold === null
            ? t('server.diskEnforcement.recoveryThresholdUnknown', {})
            : formatBytes(recoveryThreshold),
      })}
    </Alert>
  );
}

function optionalNumber(value: unknown): number | null {
  return value !== undefined && value !== null && typeof value === 'number' && Number.isFinite(value) ? value : null;
}
