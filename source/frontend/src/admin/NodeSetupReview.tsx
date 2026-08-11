import Badge from '@/elements/Badge.tsx';
import Card from '@/elements/Card.tsx';
import Code from '@/elements/Code.tsx';
import Group from '@/elements/Group.tsx';
import Stack from '@/elements/Stack.tsx';
import Text from '@/elements/Text.tsx';
import Title from '@/elements/Title.tsx';
import ProtocolIcon from '../components/ProtocolIcon.tsx';
import translations from '../translations.ts';
import type { NodeFormValues } from './nodeForm.ts';
import { protocols } from './nodeForm.ts';

function SummaryValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Text size='xs' c='dimmed'>
        {label}
      </Text>
      <Text size='sm' fw={500} className='break-all'>
        {children}
      </Text>
    </div>
  );
}

export default function NodeSetupReview({
  values,
  showArtifactPolicy = true,
}: {
  values: NodeFormValues;
  showArtifactPolicy?: boolean;
}) {
  const { t } = translations.useTranslations();
  const enabledProtocols = protocols.filter(([protocol]) => values.config.protocols[protocol].enabled);

  return (
    <Stack gap='md'>
      <Card p='md'>
        <Group justify='space-between' align='flex-start' mb='md'>
          <Title order={4}>{t('admin.wizard.reviewConnection', {})}</Title>
          <Badge color={values.enabled ? 'green' : 'gray'}>
            {values.enabled ? t('admin.wizard.schedulingEnabled', {}) : t('admin.wizard.schedulingDisabled', {})}
          </Badge>
        </Group>
        <div className='grid grid-cols-1 gap-4 md:grid-cols-3'>
          <SummaryValue label={t('admin.nodeName', {})}>{values.name || '—'}</SummaryValue>
          <SummaryValue label={t('admin.apiUrl', {})}>{values.apiUrl || '—'}</SummaryValue>
          <SummaryValue label={t('admin.publicHost', {})}>{values.publicHost || '—'}</SummaryValue>
        </div>
      </Card>

      <Card p='md'>
        <Title order={4} mb='md'>
          {t('admin.wizard.reviewRuntime', {})}
        </Title>
        <div className='grid grid-cols-2 gap-4 lg:grid-cols-4'>
          <SummaryValue label={t('admin.nodeConfig.containerEngine', {})}>
            {values.config.daemon.engine === 'podman' ? 'Podman' : 'Docker'}
          </SummaryValue>
          <SummaryValue label={t('admin.cpu', {})}>{values.defaultCpuCores}</SummaryValue>
          <SummaryValue label={t('admin.memory', {})}>{values.defaultMemoryMib} MiB</SummaryValue>
          <SummaryValue label={t('admin.disk', {})}>{values.defaultDiskMib} MiB</SummaryValue>
        </div>
      </Card>

      <Card p='md'>
        <Group justify='space-between' mb='md'>
          <Title order={4}>{t('admin.wizard.reviewGateways', {})}</Title>
          <Badge>{t('admin.wizard.gatewayCount', { count: enabledProtocols.length })}</Badge>
        </Group>
        <Stack gap='xs'>
          {enabledProtocols.map(([protocol, label]) => {
            const gateway = values.config.protocols[protocol];
            return (
              <Group key={protocol} justify='space-between' wrap='wrap' gap='sm'>
                <Group gap='sm'>
                  <ProtocolIcon protocol={protocol} size={26} />
                  <Text size='sm' fw={600}>
                    {label}
                  </Text>
                  <Badge size='xs' color={gateway.tls ? 'green' : 'gray'}>
                    {gateway.tls ? 'TLS' : t('admin.wizard.plaintext', {})}
                  </Badge>
                </Group>
                <Code>{`${values.publicHost || t('admin.nodeConfig.gatewayExampleHost', {})}:${gateway.port}`}</Code>
              </Group>
            );
          })}
          {enabledProtocols.length === 0 && (
            <Text size='sm' c='dimmed'>
              {t('admin.wizard.noGateways', {})}
            </Text>
          )}
        </Stack>
      </Card>

      <Card p='md'>
        <Title order={4} mb='md'>
          {t('admin.wizard.reviewBackups', {})}
        </Title>
        <div className='grid grid-cols-1 gap-4 md:grid-cols-3'>
          <SummaryValue label={t('admin.nodeConfig.automatedBackups', {})}>
            {values.config.backups.enabled ? t('admin.wizard.yes', {}) : t('admin.wizard.no', {})}
          </SummaryValue>
          <SummaryValue label={t('admin.nodeConfig.backupStorageDriver', {})}>
            {values.config.backups.storageDriver.toUpperCase()}
          </SummaryValue>
          <SummaryValue label={t('admin.nodeConfig.backupInterval', {})}>
            {values.config.backups.intervalMinutes}
          </SummaryValue>
          {showArtifactPolicy && (
            <>
              <SummaryValue label={t('admin.nodeConfig.streamExportsOnly', {})}>
                {values.config.artifacts.streamExportsOnly ? t('admin.wizard.yes', {}) : t('admin.wizard.no', {})}
              </SummaryValue>
              <SummaryValue label={t('admin.nodeConfig.maxArtifactsPerInstance', {})}>
                {values.config.artifacts.maxArtifactsPerInstance}
              </SummaryValue>
            </>
          )}
        </div>
      </Card>

      <Text size='sm' c='dimmed'>
        {t('admin.wizard.reviewHint', {})}
      </Text>
    </Stack>
  );
}
