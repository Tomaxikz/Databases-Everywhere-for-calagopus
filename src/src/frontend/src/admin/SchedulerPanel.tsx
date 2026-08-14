import { Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Badge from '@/elements/Badge.tsx';
import Button from '@/elements/Button.tsx';
import Card from '@/elements/Card.tsx';
import NumberInput from '@/elements/input/NumberInput.tsx';
import Select from '@/elements/input/Select.tsx';
import Switch from '@/elements/input/Switch.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { versionAtLeast } from '../api/capabilities.ts';
import { getSchedulerRecommendation, patchRemoteConfiguration } from '../api/client.ts';
import { dbevQueryKeys } from '../api/queryKeys.ts';
import type {
  DatabaseProtocol,
  ImportExportSchedulerConfiguration,
  NodeRecord,
  SchedulerRecommendationRequest,
} from '../api/types.ts';
import { formatBytes } from '../components/common.tsx';
import { protocolLabels } from '../components/protocols.ts';
import {
  applySchedulerRecommendation,
  configuredImportUploadMaxBytes,
  recommendationPresentation,
  schedulerConfiguration,
  schedulerConfigurationError,
  schedulerConfigurationPatch,
  schedulerRecommendationDefaults,
} from './schedulerContracts.ts';

const PHYSICAL_COMPRESSED = new Set<DatabaseProtocol>(['mongodb', 'redis', 'valkey', 'qdrant']);

export default function SchedulerPanel({
  node,
  recommendationsAllowed,
  disabled = false,
}: {
  node: NodeRecord;
  recommendationsAllowed: boolean;
  disabled?: boolean;
}) {
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [configuration, setConfiguration] = useState(() => storedSchedulerConfiguration(node));
  const [saving, setSaving] = useState(false);
  const [confirmRecommendation, setConfirmRecommendation] = useState(false);
  const [request, setRequest] = useState<SchedulerRecommendationRequest>(() =>
    schedulerRecommendationDefaults(configuredImportUploadMaxBytes(node.configuration)),
  );
  const [debouncedRequest, setDebouncedRequest] = useState(request);
  const supported = versionAtLeast(node.cached_system?.api_version, [0, 12, 0]);
  const configuredUploadMaximum = configuredImportUploadMaxBytes(node.configuration);

  useEffect(() => setConfiguration(storedSchedulerConfiguration(node)), [node.configuration, node.uuid]);
  useEffect(() => {
    setRequest(schedulerRecommendationDefaults(configuredUploadMaximum));
  }, [configuredUploadMaximum, node.uuid]);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedRequest(request), 350);
    return () => window.clearTimeout(timeout);
  }, [request]);

  const recommendation = useQuery({
    queryKey: [...dbevQueryKeys.adminNode(node.uuid), 'scheduler-recommendation', debouncedRequest],
    queryFn: ({ signal }) => getSchedulerRecommendation(node.uuid, debouncedRequest, signal),
    enabled: supported && recommendationsAllowed,
    retry: false,
    refetchInterval: supported && recommendationsAllowed ? 15_000 : false,
    refetchOnWindowFocus: false,
  });
  const presentation = recommendationPresentation(recommendation.data);
  const validationError = schedulerConfigurationError(configuration);
  const compressedLocked = PHYSICAL_COMPRESSED.has(request.protocol);

  const setNumber = (key: keyof ImportExportSchedulerConfiguration, value: string | number) => {
    const parsed = typeof value === 'number' ? value : Number(value);
    setConfiguration((current) => ({ ...current, [key]: Number.isFinite(parsed) ? parsed : 0 }));
  };

  const save = async () => {
    if (validationError || saving || disabled) return;
    setSaving(true);
    try {
      await patchRemoteConfiguration(node.uuid, schedulerConfigurationPatch(configuration));
      await queryClient.invalidateQueries({ queryKey: dbevQueryKeys.adminNodes() });
      addToast('Scheduler configuration saved. Restart the DBEV daemon before relying on the new limits.', 'success');
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap='md'>
      <Card>
        <Group justify='space-between' align='flex-start' mb='md'>
          <div>
            <Title order={4}>Import/export scheduler configuration</Title>
            <Text size='xs' c='dimmed'>
              Memory is the hard safety gate. CPU and I/O are concurrency weights; zero uses automatic live detection.
            </Text>
          </div>
          <Badge color={configuration.dynamic_limiter_enabled ? 'blue' : 'gray'}>
            {configuration.dynamic_limiter_enabled ? 'Dynamic mode' : 'Manual mode'}
          </Badge>
        </Group>
        <Stack gap='md'>
          <Switch
            checked={configuration.dynamic_limiter_enabled}
            onChange={(event) =>
              setConfiguration((current) => ({ ...current, dynamic_limiter_enabled: event.currentTarget.checked }))
            }
            label='Dynamic limiter'
            description='Changing this switch is explicit; applying a recommendation never changes the mode.'
          />
          <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }}>
            <NumberInput
              label='Maximum queued jobs'
              min={64}
              max={8_192}
              value={configuration.max_queued_jobs}
              onChange={(value) => setNumber('max_queued_jobs', value)}
            />
            <NumberInput
              label='Queued jobs per database'
              min={1}
              max={256}
              value={configuration.max_queued_jobs_per_instance}
              onChange={(value) => setNumber('max_queued_jobs_per_instance', value)}
            />
            <NumberInput
              label='Manual active-job limit'
              description='Actual limit in manual mode.'
              min={1}
              max={1_024}
              value={configuration.manual_max_active_jobs}
              onChange={(value) => setNumber('manual_max_active_jobs', value)}
            />
            <NumberInput
              label='Dynamic active-job ceiling'
              min={1}
              max={1_024}
              value={configuration.dynamic_max_active_jobs}
              onChange={(value) => setNumber('dynamic_max_active_jobs', value)}
            />
            <NumberInput
              label='Dynamic memory budget (MiB)'
              description='0 = automatic; otherwise 128–16,777,216.'
              min={0}
              max={16_777_216}
              value={configuration.dynamic_memory_budget_mib}
              onChange={(value) => setNumber('dynamic_memory_budget_mib', value)}
            />
            <NumberInput
              label='Dynamic I/O budget (MiB)'
              description='0 = automatic; otherwise 256–67,108,864.'
              min={0}
              max={67_108_864}
              value={configuration.dynamic_io_budget_mib}
              onChange={(value) => setNumber('dynamic_io_budget_mib', value)}
            />
            <NumberInput
              label='Dynamic CPU units'
              description='0 = automatic.'
              min={0}
              max={65_536}
              value={configuration.dynamic_cpu_units}
              onChange={(value) => setNumber('dynamic_cpu_units', value)}
            />
            <NumberInput
              label='Starvation timeout (seconds)'
              min={1}
              max={3_600}
              value={configuration.starvation_timeout_seconds}
              onChange={(value) => setNumber('starvation_timeout_seconds', value)}
            />
            <NumberInput
              label='Maximum queue bypasses'
              min={0}
              max={1_024}
              value={configuration.max_bypass}
              onChange={(value) => setNumber('max_bypass', value)}
            />
          </SimpleGrid>
          {validationError && <Alert color='red'>{validationError}</Alert>}
          <Alert color='yellow'>
            Saving writes config.yml, but the live scheduler does not change until DBEV restarts.
          </Alert>
          <Text size='xs' c='dimmed'>
            Automatic memory and CPU budgets follow live host or cgroup limits. Automatic I/O follows staging and
            physical-restore capacity. A job waiting for automatic memory headroom is rejected after the starvation
            timeout. Manual mode still keeps queue bounds, per-database serialization, archive limits, and disk
            reservations.
          </Text>
          <Group justify='flex-end'>
            <Button loading={saving} disabled={disabled || Boolean(validationError)} onClick={() => void save()}>
              Save scheduler configuration
            </Button>
          </Group>
        </Stack>
      </Card>

      <Card>
        <Group justify='space-between' align='flex-start' mb='md'>
          <div>
            <Title order={4}>Live scheduler recommendation</Title>
            <Text size='xs' c='dimmed'>
              Conservative model from the running daemon. It refreshes only while this scheduler view is open.
            </Text>
          </div>
          <Button
            variant='default'
            loading={recommendation.isFetching}
            disabled={!supported || !recommendationsAllowed}
            onClick={() => void recommendation.refetch()}
          >
            Refresh
          </Button>
        </Group>
        {!recommendationsAllowed ? (
          <Alert color='yellow'>Your role cannot read live DBEV scheduler recommendations.</Alert>
        ) : !supported ? (
          <Alert color='yellow'>Run a node health check with DBEV API 0.12.0 or newer to use recommendations.</Alert>
        ) : (
          <Stack gap='md'>
            <SimpleGrid cols={{ base: 1, md: 2, xl: 3 }}>
              <Select
                label='Protocol'
                value={request.protocol}
                data={Object.entries(protocolLabels).map(([value, label]) => ({ value, label }))}
                onChange={(value) => {
                  if (!value) return;
                  const protocol = value as DatabaseProtocol;
                  setRequest((current) => ({
                    ...current,
                    protocol,
                    compressed: PHYSICAL_COMPRESSED.has(protocol) || current.compressed,
                  }));
                }}
              />
              <Select
                label='Action'
                value={request.action}
                data={[
                  { value: 'import', label: 'Import' },
                  { value: 'export', label: 'Export' },
                ]}
                onChange={(value) =>
                  value &&
                  setRequest((current) => ({
                    ...current,
                    action: value as 'import' | 'export',
                    mode: value === 'export' ? 'merge' : current.mode,
                  }))
                }
              />
              <Select
                label='Import mode'
                value={request.mode}
                disabled={request.action === 'export'}
                data={[
                  { value: 'merge', label: 'Merge' },
                  { value: 'wipe', label: 'Wipe then import' },
                ]}
                onChange={(value) =>
                  value && setRequest((current) => ({ ...current, mode: value as 'merge' | 'wipe' }))
                }
              />
              <NumberInput
                label='Input size (bytes)'
                min={1}
                max={68_719_476_736}
                value={request.size_bytes}
                onChange={(value) => {
                  const size = Math.max(1, Number(value) || 1);
                  setRequest((current) => ({
                    ...current,
                    size_bytes: size,
                    target_disk_mib: Math.max(1, Math.ceil(size / 1_048_576)),
                  }));
                }}
              />
              <NumberInput
                label='Target disk (MiB)'
                min={1}
                value={request.target_disk_mib}
                onChange={(value) =>
                  setRequest((current) => ({ ...current, target_disk_mib: Math.max(1, Number(value) || 1) }))
                }
              />
              <Switch
                mt='xl'
                checked={compressedLocked || request.compressed}
                disabled={compressedLocked}
                onChange={(event) => setRequest((current) => ({ ...current, compressed: event.currentTarget.checked }))}
                label='Compressed input'
                description={
                  compressedLocked ? 'This protocol always uses a compressed/native archive model.' : undefined
                }
              />
            </SimpleGrid>

            {recommendation.error && <Alert color='red'>{httpErrorToHuman(recommendation.error)}</Alert>}
            {recommendation.data && (
              <>
                {!recommendation.data.scheduler.accepting && (
                  <Alert color='yellow'>
                    The scheduler is draining or shutting down and is not accepting new work.
                  </Alert>
                )}
                {presentation.insufficientMemory && (
                  <Alert color='red' title='Insufficient live memory/headroom'>
                    This modeled job does not safely fit right now. A recommendation of zero is intentional and was not
                    clamped to one.
                  </Alert>
                )}
                {presentation.isolated && (
                  <Alert color='blue' title='Isolated weighted execution'>
                    The job is memory-safe but exceeds the shared CPU or I/O weight. It may run alone and cannot overlap
                    another weighted job.
                  </Alert>
                )}
                <SimpleGrid cols={{ base: 2, lg: 4 }}>
                  <Metric label='Recommended active jobs' value={String(recommendation.data.recommended_active_jobs)} />
                  <Metric label='Admitted operations' value={String(recommendation.data.admitted_jobs)} />
                  <Metric
                    label='Mode / live limit'
                    value={`${recommendation.data.scheduler.capacity.mode} / ${recommendation.data.scheduler.capacity.max_active_jobs}`}
                  />
                  <Metric label='Modeled input' value={formatBytes(recommendation.data.estimate.input_size_bytes)} />
                  <Metric label='Modeled memory' value={`${recommendation.data.estimate.memory_mib} MiB`} />
                  <Metric label='I/O weight' value={`${recommendation.data.estimate.io_mib} MiB`} />
                  <Metric label='CPU weight' value={String(recommendation.data.estimate.cpu_units)} />
                  <Metric
                    label='Weighted active / waiting'
                    value={`${recommendation.data.scheduler.active_jobs} / ${recommendation.data.scheduler.waiting_jobs}`}
                  />
                </SimpleGrid>
                <Text size='xs' c='dimmed'>
                  Admitted operations include durable and synchronous work, including jobs waiting on an instance lock.
                  Active and waiting counts describe weighted admission, not the full durable queue. Recommendations are
                  models, not throughput guarantees.
                </Text>
                <Group justify='flex-end'>
                  <Button
                    disabled={recommendation.data.recommended_active_jobs === 0}
                    onClick={() => setConfirmRecommendation(true)}
                  >
                    Use recommendation
                  </Button>
                </Group>
              </>
            )}
          </Stack>
        )}
      </Card>

      <Modal
        opened={confirmRecommendation}
        onClose={() => setConfirmRecommendation(false)}
        title='Use this live recommendation?'
      >
        <Text>
          This copies <strong>{recommendation.data?.recommended_active_jobs ?? 0}</strong> into the{' '}
          {configuration.dynamic_limiter_enabled ? 'dynamic ceiling' : 'manual active-job limit'}. It does not change
          scheduler mode and is not sent to DBEV until you save.
        </Text>
        <ModalFooter>
          <Button
            disabled={!recommendation.data || recommendation.data.recommended_active_jobs === 0}
            onClick={() => {
              if (recommendation.data) {
                setConfiguration((current) =>
                  applySchedulerRecommendation(current, recommendation.data.recommended_active_jobs),
                );
              }
              setConfirmRecommendation(false);
            }}
          >
            Use recommendation
          </Button>
          <Button variant='default' onClick={() => setConfirmRecommendation(false)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </Stack>
  );
}

function storedSchedulerConfiguration(node: NodeRecord): ImportExportSchedulerConfiguration {
  const artifacts =
    node.configuration.artifacts &&
    typeof node.configuration.artifacts === 'object' &&
    !Array.isArray(node.configuration.artifacts)
      ? (node.configuration.artifacts as Record<string, unknown>)
      : {};
  return schedulerConfiguration(artifacts.import_export_scheduler);
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card p='sm'>
      <Text size='xs' c='dimmed'>
        {label}
      </Text>
      <Text fw={700}>{value}</Text>
    </Card>
  );
}
