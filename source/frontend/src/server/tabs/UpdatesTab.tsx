import { faArrowsRotate, faRotate } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Accordion, Checkbox, Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Badge from '@/elements/Badge.tsx';
import Button from '@/elements/Button.tsx';
import Code from '@/elements/Code.tsx';
import PasswordInput from '@/elements/input/PasswordInput.tsx';
import Select from '@/elements/input/Select.tsx';
import Progress from '@/elements/Progress.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { databaseCapabilities } from '../../api/capabilities.ts';
import { getDatabaseRuntime, getDatabaseStatus, reconcileDatabase, updateDatabaseImage } from '../../api/client.ts';
import { type DbevMutationFailure, dbevMutationFailure } from '../../api/mutationErrors.ts';
import { dbevQueryKeys } from '../../api/queryKeys.ts';
import type { DatabaseInstallProgress, DatabaseRecord } from '../../api/types.ts';
import translations from '../../translations.ts';
import SectionCard from '../components/SectionCard.tsx';
import { databaseActionPolicy } from '../databaseActionPolicy.ts';
import { useDatabaseLiveOverview } from '../useDatabaseWebSockets.ts';

interface Props {
  server: string;
  database: DatabaseRecord;
  onChanged: () => void;
}

function progressMessage(progress: DatabaseInstallProgress): string {
  return progress.diagnostic?.message || progress.message || progress.stage || progress.status || 'Waiting for DBE';
}

function readableStage(stage?: string): string {
  if (!stage) return 'Pending';
  return stage.replaceAll('_', ' ').replace(/^./, (character) => character.toUpperCase());
}

export default function UpdatesTab({ server, database, onChanged }: Props) {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const [action, setAction] = useState<'image' | 'reconcile' | null>(null);
  const [image, setImage] = useState(database.image || '');
  const [majorUpgrade, setMajorUpgrade] = useState(false);
  const [legacyPassword, setLegacyPassword] = useState('');
  const [failure, setFailure] = useState<DbevMutationFailure | null>(null);
  const [checkingState, setCheckingState] = useState(false);
  const live = useDatabaseLiveOverview({ server, database: database.uuid, logsEnabled: false });
  const runtimeQuery = useQuery({
    queryKey: dbevQueryKeys.databaseRuntime(server, database.uuid),
    queryFn: () => getDatabaseRuntime(server, database.uuid),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const runtime = runtimeQuery.data;
  const currentImage = runtime?.image?.current || database.image || t('server.unknown', {});
  const configuredImage = runtime?.image?.configured || database.image || t('server.unknown', {});
  const databaseVersion = runtime?.database_version?.current || t('server.unknown', {});
  const updateAvailable = runtime?.image?.update_available === true;
  const progress = live.progress;
  const imageProgress = progress && ['image_update', 'major_upgrade'].includes(progress.action || '') ? progress : null;
  const progressRunning = imageProgress?.status === 'running';
  const progressFailed = imageProgress?.status === 'failed';
  const progressValue = progressRunning
    ? typeof imageProgress?.percent === 'number'
      ? imageProgress.percent
      : Number.NaN
    : imageProgress?.status === 'completed'
      ? 100
      : 0;
  const supportsMajorUpgrade = !['redis', 'valkey', 'qdrant'].includes(database.protocol);
  const status = live.instance?.status || database.status;
  const policy = databaseActionPolicy(status);
  const capabilities = databaseCapabilities(database.metadata);
  const allowedImages = Array.from(
    new Set([database.default_image, ...(database.allowed_images ?? [])].filter(Boolean)),
  ) as string[];
  const imageAllowed = allowedImages.includes(image);
  const imageChoices = [
    ...allowedImages.map((value) => ({ value, label: value })),
    ...(!image || imageAllowed
      ? []
      : [{ value: image, label: t('server.imageNoLongerAllowed', { image }), disabled: true }]),
  ];

  useEffect(() => {
    if (runtime?.image?.configured) setImage(runtime.image.configured);
  }, [runtime?.image?.configured]);

  const run = async (name: 'image' | 'reconcile', operation: () => Promise<unknown>, success: string) => {
    setAction(name);
    setFailure(null);
    try {
      await operation();
      addToast(success, 'success');
      await runtimeQuery.refetch();
      onChanged();
    } catch (error) {
      const nextFailure = dbevMutationFailure(error, httpErrorToHuman(error));
      setFailure(nextFailure);
      if (name === 'image' && nextFailure.status === 500) {
        await Promise.allSettled([
          getDatabaseStatus(server, database.uuid),
          runtimeQuery.refetch(),
          Promise.resolve(onChanged()),
        ]);
      }
      if (!nextFailure.retryable) addToast(nextFailure.message, 'error');
    } finally {
      if (name === 'image') setLegacyPassword('');
      setAction(null);
    }
  };

  const checkStateBeforeRetry = async () => {
    setCheckingState(true);
    try {
      await getDatabaseStatus(server, database.uuid);
      await runtimeQuery.refetch();
      await onChanged();
      setFailure(null);
      addToast(t('server.databaseStateRefreshed', {}), 'success');
    } catch (error) {
      setFailure(dbevMutationFailure(error, httpErrorToHuman(error)));
    } finally {
      setCheckingState(false);
    }
  };

  return (
    <Stack mt='md'>
      {runtimeQuery.error && <Alert color='red'>{httpErrorToHuman(runtimeQuery.error)}</Alert>}
      {live.monitoring.error && (
        <Alert color='yellow' title={t('server.liveUpdateReconnecting', {})}>
          {live.monitoring.error}
        </Alert>
      )}
      {live.monitoring.state === 'reconnecting' && !live.monitoring.error && (
        <Alert color='blue'>{t('server.agentReconnecting', {})}</Alert>
      )}
      {status === 'stopped' && <Alert color='yellow'>{t('server.imageUpdateRequiresRunning', {})}</Alert>}
      {status === 'quarantined' && (
        <Alert color='red' title={t('server.quarantinedTitle', {})}>
          {t('server.quarantinedDescription', {})}
        </Alert>
      )}
      {failure && (
        <Alert color={failure.retryable ? 'yellow' : 'red'}>
          <Stack gap='xs'>
            <Text size='sm'>{failure.message}</Text>
            {failure.retryable && (
              <Group justify='flex-end'>
                <Button
                  size='compact-xs'
                  variant='default'
                  loading={checkingState}
                  onClick={() => void checkStateBeforeRetry()}
                >
                  {t('server.checkStateBeforeRetry', {})}
                </Button>
              </Group>
            )}
          </Stack>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <SectionCard
          heading={
            <div>
              <Title order={4}>{t('server.imageUpdate', {})}</Title>
              <Text size='sm' c='dimmed'>
                {t('server.imageUpdateDescription', {})}
              </Text>
            </div>
          }
          headerRight={
            <Badge color={updateAvailable ? 'yellow' : 'green'}>
              {updateAvailable ? t('server.updateAvailable', {}) : t('server.upToDate', {})}
            </Badge>
          }
        >
          <SimpleGrid cols={{ base: 1, sm: 3 }} mb='lg'>
            <ImageDetail label={t('server.currentImage', {})} value={currentImage} />
            <ImageDetail label={t('server.configuredImage', {})} value={configuredImage} />
            <ImageDetail label={t('server.databaseVersion', {})} value={databaseVersion} />
          </SimpleGrid>

          <Stack>
            <Select
              value={image}
              onChange={(value) => value && setImage(value)}
              label={t('server.image', {})}
              description={t('server.imageDescription', {})}
              data={imageChoices}
              searchable
            />
            <Checkbox
              checked={majorUpgrade}
              disabled={!supportsMajorUpgrade || action !== null || progressRunning}
              onChange={(event) => setMajorUpgrade(event.currentTarget.checked)}
              label={t('server.majorUpgrade', {})}
              description={
                supportsMajorUpgrade ? t('server.majorUpgradeDescription', {}) : t('server.majorUpgradeUnsupported', {})
              }
            />
            <Accordion variant='contained'>
              <Accordion.Item value='legacy-password'>
                <Accordion.Control>{t('server.legacyAgentCompatibility', {})}</Accordion.Control>
                <Accordion.Panel>
                  <PasswordInput
                    value={legacyPassword}
                    onChange={(event) => setLegacyPassword(event.currentTarget.value)}
                    label={t('server.legacyImagePassword', {})}
                    description={
                      capabilities.storedTenantCredentials
                        ? t('server.legacyImagePasswordModernDescription', {})
                        : t('server.legacyImagePasswordOldDescription', {})
                    }
                    disabled={action !== null || progressRunning || !policy.updateImage}
                    maxLength={4096}
                    autoComplete='current-password'
                  />
                </Accordion.Panel>
              </Accordion.Item>
            </Accordion>
            <Group justify='flex-end'>
              <Button
                variant='default'
                loading={action === 'reconcile'}
                disabled={action !== null || progressRunning || !policy.reconcile}
                onClick={() =>
                  run('reconcile', () => reconcileDatabase(server, database.uuid), t('server.reconciled', {}))
                }
                leftSection={<FontAwesomeIcon icon={faRotate} />}
              >
                {t('server.reconcile', {})}
              </Button>
              <Button
                loading={action === 'image'}
                disabled={action !== null || progressRunning || !image.trim() || !imageAllowed || !policy.updateImage}
                onClick={() =>
                  run(
                    'image',
                    () =>
                      updateDatabaseImage(
                        server,
                        database.uuid,
                        image.trim(),
                        majorUpgrade,
                        legacyPassword || undefined,
                      ),
                    t('server.imageUpdated', {}),
                  )
                }
                leftSection={<FontAwesomeIcon icon={faArrowsRotate} />}
              >
                {t('server.updateDatabase', {})}
              </Button>
            </Group>
          </Stack>
        </SectionCard>

        <SectionCard
          heading={
            <div>
              <Title order={4}>{t('server.updateProgress', {})}</Title>
              <Text size='sm' c='dimmed'>
                {t('server.updateProgressDescription', {})}
              </Text>
            </div>
          }
          headerRight={
            imageProgress ? (
              <Badge color={progressFailed ? 'red' : progressRunning ? 'blue' : 'green'}>
                {imageProgress.status || t('server.unknown', {})}
              </Badge>
            ) : undefined
          }
        >
          {imageProgress ? (
            <Stack>
              <Progress
                value={progressValue}
                indeterminate={progressRunning && !Number.isFinite(progressValue)}
                color={progressFailed ? 'red' : imageProgress.status === 'completed' ? 'green' : 'blue'}
              />
              <div>
                <Text size='xs' c='dimmed'>
                  {t('server.stage', {})}
                </Text>
                <Text fw={600}>{readableStage(imageProgress.stage)}</Text>
              </div>
              <Text size='sm'>{progressMessage(imageProgress)}</Text>
              {imageProgress.image && (
                <Text size='xs' c='dimmed'>
                  {t('server.targetImage', {})}: <Code>{imageProgress.image}</Code>
                </Text>
              )}
              {imageProgress.layer && (
                <Text size='xs' c='dimmed'>
                  {t('server.imageLayer', {})}: <Code>{imageProgress.layer}</Code>
                </Text>
              )}
            </Stack>
          ) : (
            <Stack align='center' justify='center' mih={180} gap='xs'>
              <FontAwesomeIcon icon={faArrowsRotate} className='text-3xl text-(--mantine-color-dimmed)' />
              <Text fw={600}>{t('server.noUpdateRunning', {})}</Text>
              <Text size='sm' c='dimmed' ta='center'>
                {t('server.noUpdateRunningDescription', {})}
              </Text>
            </Stack>
          )}
        </SectionCard>
      </SimpleGrid>
    </Stack>
  );
}

function ImageDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className='min-w-0'>
      <Text size='xs' c='dimmed'>
        {label}
      </Text>
      <Code className='block truncate'>{value}</Code>
    </div>
  );
}
