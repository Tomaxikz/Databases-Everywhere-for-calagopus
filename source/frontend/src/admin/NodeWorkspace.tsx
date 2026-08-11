import { faRotate, faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Badge from '@/elements/Badge.tsx';
import Button from '@/elements/Button.tsx';
import { AdminCan } from '@/elements/Can.tsx';
import Card from '@/elements/Card.tsx';
import Code from '@/elements/Code.tsx';
import CopyOnClick from '@/elements/CopyOnClick.tsx';
import Select from '@/elements/input/Select.tsx';
import Switch from '@/elements/input/Switch.tsx';
import TextArea from '@/elements/input/TextArea.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import Tabs from '@/elements/Tabs.tsx';
import { useAdminCan } from '@/plugins/usePermissions.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import {
  deleteNode,
  getNodeConfiguration,
  nodeOperation,
  patchRemoteConfiguration,
  pullNodeImage,
  resetNodeCredentials,
} from '../api/client.ts';
import { normalizeDbevResourceReports } from '../api/normalizers.ts';
import { dbevQueryKeys } from '../api/queryKeys.ts';
import type { DatabaseProtocol, DbevConfigPatchResponse, NodeCredentials, NodeRecord } from '../api/types.ts';
import { formatTimestamp, JsonView, StatusBadge } from '../components/common.tsx';
import { protocolLabels } from '../components/protocols.ts';
import translations from '../translations.ts';
import ArtifactPolicyPanel from './ArtifactPolicyPanel.tsx';
import NodeResourceReports from './NodeResourceReports.tsx';
import NodeRuntimeOverview from './NodeRuntimeOverview.tsx';
import SchedulerPanel from './SchedulerPanel.tsx';

interface Props {
  node: NodeRecord;
  onDeleted: () => void;
  onCredentials: (credentials: NodeCredentials) => void;
}

export default function NodeWorkspace({ node, onDeleted, onCredentials }: Props) {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [liveResult, setLiveResult] = useState<unknown>(null);
  const [liveResultKind, setLiveResultKind] = useState<string | null>(null);
  const [configPatch, setConfigPatch] = useState('{}');
  const [protocol, setProtocol] = useState<DatabaseProtocol>('postgres');
  const [image, setImage] = useState('');
  const [restartRequired, setRestartRequired] = useState(false);
  const [allocationGuards, setAllocationGuards] = useState(() => desiredAllocationGuards(node));
  const canUpdate = useAdminCan('databases-everywhere-nodes.update');
  const canUseCredentials = useAdminCan('databases-everywhere-nodes.credentials');
  const canRunOperations = useAdminCan('databases-everywhere-nodes.operations');

  useEffect(() => {
    setAllocationGuards(desiredAllocationGuards(node));
  }, [node.configuration, node.uuid]);

  useEffect(() => setRestartRequired(false), [node.uuid]);

  const configuration = useQuery({
    queryKey: dbevQueryKeys.adminNodeConfiguration(node.uuid),
    queryFn: () => getNodeConfiguration(node.uuid),
    enabled: canUseCredentials,
  });

  const run = async (name: string, operation: () => Promise<unknown>, refresh = false) => {
    setAction(name);
    try {
      const result = await operation();
      setLiveResult(result);
      setLiveResultKind(name);
      addToast(t('server.operationQueued', {}), 'success');
      if (refresh) await configuration.refetch();
      return result;
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
      return undefined;
    } finally {
      setAction(null);
    }
  };

  const applyPatch = async () => {
    let patch: Record<string, unknown>;
    try {
      const parsed = JSON.parse(configPatch);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      patch = parsed;
    } catch {
      addToast('The live configuration patch must be a JSON object.', 'error');
      return;
    }
    const result = await run('patch', () => patchRemoteConfiguration(node.uuid, patch));
    if (result) {
      if ((result as DbevConfigPatchResponse).restart_required) setRestartRequired(true);
      await queryClient.invalidateQueries({ queryKey: dbevQueryKeys.adminNodes() });
    }
  };

  const applyAllocationGuards = async () => {
    const result = await run('allocation-guards', () =>
      patchRemoteConfiguration(node.uuid, {
        allocation: {
          prevent_cpu_overallocation: allocationGuards.cpu,
          prevent_memory_overallocation: allocationGuards.memory,
          prevent_disk_overallocation: allocationGuards.disk,
        },
      }),
    );
    if (result) {
      if ((result as DbevConfigPatchResponse).restart_required) setRestartRequired(true);
      await queryClient.invalidateQueries({ queryKey: dbevQueryKeys.adminNodes() });
    }
  };

  const doDelete = async () => {
    if (confirmName !== node.name) return;
    setAction('delete');
    try {
      await deleteNode(node.uuid);
      addToast(t('admin.nodeDeleted', {}), 'success');
      onDeleted();
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setAction(null);
    }
  };

  return (
    <Stack>
      {node.last_error && (
        <Alert color='red' title='Last health error'>
          {node.last_error}
        </Alert>
      )}
      <Group justify='space-between'>
        <Group>
          <StatusBadge status={node.enabled ? (node.last_error ? 'failed' : 'healthy') : 'disabled'} />
          <Text size='sm' c='dimmed'>
            {node.api_url}
          </Text>
        </Group>
        <Group>
          <AdminCan action='databases-everywhere-nodes.update'>
            <Button variant='default' onClick={() => navigate(`/admin/databases-everywhere/${node.uuid}/edit`)}>
              {t('common.save', {})} settings
            </Button>
          </AdminCan>
          <AdminCan action='databases-everywhere-nodes.delete'>
            <Button
              color='red'
              variant='light'
              onClick={() => setDeleteOpen(true)}
              leftSection={<FontAwesomeIcon icon={faTrash} />}
            >
              {t('admin.deleteNode', {})}
            </Button>
          </AdminCan>
        </Group>
      </Group>

      <Tabs defaultValue='overview' keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value='overview'>{t('server.overview', {})}</Tabs.Tab>
          {(canUseCredentials || canUpdate) && <Tabs.Tab value='configuration'>{t('admin.daemonConfig', {})}</Tabs.Tab>}
          {canRunOperations && <Tabs.Tab value='operations'>{t('admin.health', {})}</Tabs.Tab>}
          {canRunOperations && <Tabs.Tab value='automation'>{t('admin.backupAutomation', {})}</Tabs.Tab>}
        </Tabs.List>

        <Tabs.Panel value='overview' pt='md'>
          <Stack>
            <SimpleGrid cols={{ base: 1, md: 2, xl: 4 }}>
              <InfoCard label={t('admin.assignments', {})} value={t('admin.assignmentsManagedElsewhere', {})} />
              <InfoCard
                label={t('admin.lastSeen', {})}
                value={node.last_seen ? formatTimestamp(node.last_seen) : t('admin.never', {})}
              />
              <InfoCard label={t('admin.publicHost', {})} value={node.public_host} />
              <InfoCard label='Daemon UUID' value={node.daemon_uuid} />
            </SimpleGrid>
            <Card>
              <Title order={4} mb='md'>
                {t('admin.defaults', {})}
              </Title>
              <SimpleGrid cols={3}>
                <Info label={t('admin.cpu', {})} value={`${node.default_cpu_cores} cores`} />
                <Info label={t('admin.memory', {})} value={`${node.default_memory_mib} MiB`} />
                <Info label={t('admin.disk', {})} value={`${node.default_disk_mib} MiB`} />
              </SimpleGrid>
            </Card>
            <Card>
              <Group justify='space-between' mb='md'>
                <div>
                  <Title order={4}>{t('admin.activeAllocationGuards', {})}</Title>
                  <Text size='xs' c='dimmed'>
                    {t('admin.activeAllocationGuardsDescription', {})}
                  </Text>
                </div>
                <Badge color={node.cached_system ? 'blue' : 'gray'}>
                  {node.cached_system ? `API ${node.cached_system.api_version}` : t('admin.notSampled', {})}
                </Badge>
              </Group>
              <SimpleGrid cols={{ base: 1, md: 3 }}>
                <AllocationGuardStatus
                  label={t('admin.nodeConfig.preventCpuOverallocation', {})}
                  value={node.cached_system?.prevent_cpu_overallocation}
                />
                <AllocationGuardStatus
                  label={t('admin.nodeConfig.preventMemoryOverallocation', {})}
                  value={node.cached_system?.prevent_memory_overallocation}
                />
                <AllocationGuardStatus
                  label={t('admin.nodeConfig.preventDiskOverallocation', {})}
                  value={node.cached_system?.prevent_disk_overallocation}
                />
              </SimpleGrid>
            </Card>
            <NodeRuntimeOverview system={node.cached_system} resources={node.cached_resources} />
          </Stack>
        </Tabs.Panel>

        {(canUseCredentials || canUpdate) && (
          <Tabs.Panel value='configuration' pt='md'>
            <Stack>
              {restartRequired && (
                <Alert color='yellow' title={t('admin.restartRequired', {})}>
                  {t('admin.restartRequiredDescription', {})}
                </Alert>
              )}
              {canUseCredentials && (
                <Card>
                  <Group justify='space-between' mb='md'>
                    <Title order={4}>config.yml</Title>
                    <Group>
                      <Button
                        size='xs'
                        variant='default'
                        onClick={async () => {
                          await configuration.refetch();
                        }}
                      >
                        {t('common.refresh', {})}
                      </Button>
                      <Button
                        size='xs'
                        color='orange'
                        loading={action === 'rotate'}
                        onClick={async () => {
                          const result = await run('rotate', () => resetNodeCredentials(node.uuid), true);
                          if (result) onCredentials(result as NodeCredentials);
                        }}
                        leftSection={<FontAwesomeIcon icon={faRotate} />}
                      >
                        {t('admin.rotateCredentials', {})}
                      </Button>
                    </Group>
                  </Group>
                  {configuration.isPending ? (
                    <Text c='dimmed'>{t('common.loading', {})}</Text>
                  ) : configuration.error ? (
                    <Alert color='red'>{httpErrorToHuman(configuration.error)}</Alert>
                  ) : (
                    <CopyOnClick content={configuration.data || ''} className='block w-full text-left'>
                      <Code block className='whitespace-pre-wrap break-all max-h-[520px] overflow-auto'>
                        {configuration.data}
                      </Code>
                    </CopyOnClick>
                  )}
                </Card>
              )}
              {canUpdate && (
                <Card>
                  <Title order={4}>{t('admin.nodeConfig.sections.allocationGuards', {})}</Title>
                  <Text size='xs' c='dimmed' mb='md'>
                    {t('admin.allocationGuardPatchDescription', {})}
                  </Text>
                  {(!allocationGuards.cpu || !allocationGuards.memory || !allocationGuards.disk) && (
                    <Alert color='red' title={t('admin.nodeConfig.allocationGuardWarningTitle', {})} mb='md'>
                      {t('admin.nodeConfig.allocationGuardWarning', {})}
                    </Alert>
                  )}
                  <Stack gap='md'>
                    <Switch
                      checked={allocationGuards.cpu}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setAllocationGuards((current) => ({ ...current, cpu: checked }));
                      }}
                      label={t('admin.nodeConfig.preventCpuOverallocation', {})}
                      description={t('admin.nodeConfig.preventCpuOverallocationDescription', {})}
                    />
                    <Switch
                      checked={allocationGuards.memory}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setAllocationGuards((current) => ({ ...current, memory: checked }));
                      }}
                      label={t('admin.nodeConfig.preventMemoryOverallocation', {})}
                      description={t('admin.nodeConfig.preventMemoryOverallocationDescription', {})}
                    />
                    <Switch
                      checked={allocationGuards.disk}
                      onChange={(event) => {
                        const checked = event.currentTarget.checked;
                        setAllocationGuards((current) => ({ ...current, disk: checked }));
                      }}
                      label={t('admin.nodeConfig.preventDiskOverallocation', {})}
                      description={t('admin.nodeConfig.preventDiskOverallocationDescription', {})}
                    />
                  </Stack>
                  <Group justify='flex-end' mt='md'>
                    <Button loading={action === 'allocation-guards'} onClick={applyAllocationGuards}>
                      {t('admin.applyAllocationGuards', {})}
                    </Button>
                  </Group>
                </Card>
              )}
              {canUpdate && <ArtifactPolicyPanel node={node} onRestartRequired={() => setRestartRequired(true)} />}
              {canUpdate && (
                <SchedulerPanel
                  node={node}
                  recommendationsAllowed={canRunOperations}
                  onRestartRequired={() => setRestartRequired(true)}
                />
              )}
              {canUpdate && (
                <Card>
                  <Title order={4} mb='md'>
                    {t('admin.remoteConfig', {})}
                  </Title>
                  <TextArea
                    autosize
                    minRows={8}
                    maxRows={20}
                    value={configPatch}
                    onChange={(event) => setConfigPatch(event.currentTarget.value)}
                    styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                  />
                  <Group justify='flex-end' mt='md'>
                    <Button loading={action === 'patch'} onClick={() => void applyPatch()}>
                      {t('common.save', {})}
                    </Button>
                  </Group>
                </Card>
              )}
            </Stack>
          </Tabs.Panel>
        )}

        {canRunOperations && (
          <Tabs.Panel value='operations' pt='md'>
            <Stack>
              <Card>
                <Group justify='space-between'>
                  <div>
                    <Title order={4}>{t('admin.health', {})}</Title>
                    <Text size='xs' c='dimmed'>
                      Heartbeat, identity, enabled protocols, and scheduler summary.
                    </Text>
                  </div>
                  <Group>
                    <Button
                      loading={action === 'test'}
                      onClick={async () => {
                        const result = await run('test', () => nodeOperation(node.uuid, 'test'));
                        if (result) {
                          await queryClient.invalidateQueries({ queryKey: dbevQueryKeys.adminNodes() });
                        }
                      }}
                    >
                      {t('admin.testConnection', {})}
                    </Button>
                    <Button
                      variant='default'
                      loading={action === 'resources'}
                      onClick={async () => {
                        await run('resources', () => nodeOperation(node.uuid, 'resources'));
                      }}
                    >
                      {t('admin.resources', {})}
                    </Button>
                  </Group>
                </Group>
              </Card>
              <Card>
                <Title order={4} mb='md'>
                  {t('admin.images', {})}
                </Title>
                <Group align='flex-end'>
                  <Select
                    label={t('server.protocol', {})}
                    value={protocol}
                    onChange={(value) => value && setProtocol(value as DatabaseProtocol)}
                    data={Object.entries(protocolLabels).map(([value, label]) => ({ value, label }))}
                  />
                  <TextInput
                    className='flex-1'
                    label={t('server.image', {})}
                    value={image}
                    onChange={(event) => setImage(event.currentTarget.value)}
                    description='Leave blank to pull the configured default.'
                  />
                  <Button
                    loading={action === 'pull'}
                    onClick={async () => {
                      await run('pull', () => pullNodeImage(node.uuid, protocol, image.trim() || undefined));
                    }}
                  >
                    Pull image
                  </Button>
                </Group>
              </Card>
              {liveResult !== null && (
                <Card>
                  <Group justify='space-between' mb='md'>
                    <Title order={4}>{t('common.rawResponse', {})}</Title>
                    <Button
                      size='xs'
                      variant='default'
                      onClick={() => {
                        setLiveResult(null);
                        setLiveResultKind(null);
                      }}
                    >
                      {t('common.close', {})}
                    </Button>
                  </Group>
                  {liveResultKind === 'resources' ? (
                    <NodeResourceReports reports={normalizeDbevResourceReports(liveResult)} />
                  ) : (
                    <JsonView value={liveResult} maxHeight={500} />
                  )}
                </Card>
              )}
            </Stack>
          </Tabs.Panel>
        )}

        {canRunOperations && (
          <Tabs.Panel value='automation' pt='md'>
            <Stack>
              <Card>
                <Group justify='space-between'>
                  <div>
                    <Title order={4}>{t('admin.backupAutomation', {})}</Title>
                    <Text size='xs' c='dimmed'>
                      View the daemon schedule, retention, browsing, and storage driver settings.
                    </Text>
                  </div>
                  <Group>
                    <Button
                      variant='default'
                      loading={action === 'backup-status'}
                      onClick={async () => {
                        await run('backup-status', () => nodeOperation(node.uuid, 'backup-status'));
                      }}
                    >
                      View status
                    </Button>
                    <Button
                      loading={action === 'backup-run'}
                      onClick={async () => {
                        await run('backup-run', () => nodeOperation(node.uuid, 'backup-run', 'post'));
                      }}
                    >
                      {t('admin.runAllBackups', {})}
                    </Button>
                  </Group>
                </Group>
              </Card>
              {liveResult !== null && (
                <Card>
                  <JsonView value={liveResult} maxHeight={520} />
                </Card>
              )}
            </Stack>
          </Tabs.Panel>
        )}
      </Tabs>

      <Modal opened={deleteOpen} onClose={() => setDeleteOpen(false)} title={t('admin.deleteNode', {})}>
        <Stack>
          <Alert color='red'>The node can only be deleted after all of its databases are removed or migrated.</Alert>
          <TextInput
            label={`Type “${node.name}” to confirm`}
            value={confirmName}
            onChange={(event) => setConfirmName(event.currentTarget.value)}
          />
        </Stack>
        <ModalFooter>
          <Button color='red' loading={action === 'delete'} disabled={confirmName !== node.name} onClick={doDelete}>
            {t('common.delete', {})}
          </Button>
          <Button variant='default' onClick={() => setDeleteOpen(false)}>
            {t('common.cancel', {})}
          </Button>
        </ModalFooter>
      </Modal>
    </Stack>
  );
}

function desiredAllocationGuards(node: NodeRecord) {
  const allocation =
    node.configuration.allocation &&
    typeof node.configuration.allocation === 'object' &&
    !Array.isArray(node.configuration.allocation)
      ? (node.configuration.allocation as Record<string, unknown>)
      : {};
  return {
    cpu: typeof allocation.prevent_cpu_overallocation === 'boolean' ? allocation.prevent_cpu_overallocation : true,
    memory:
      typeof allocation.prevent_memory_overallocation === 'boolean' ? allocation.prevent_memory_overallocation : true,
    disk: typeof allocation.prevent_disk_overallocation === 'boolean' ? allocation.prevent_disk_overallocation : true,
  };
}

function AllocationGuardStatus({ label, value }: { label: string; value: boolean | undefined }) {
  const { t } = translations.getTranslations();
  return (
    <Group justify='space-between' wrap='nowrap'>
      <Text size='sm'>{label}</Text>
      <Badge color={value === undefined ? 'gray' : value ? 'green' : 'red'}>
        {value === undefined
          ? t('admin.guardUnknown', {})
          : value
            ? t('admin.guardEnforced', {})
            : t('admin.guardDisabled', {})}
      </Badge>
    </Group>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <Info label={label} value={value} />
    </Card>
  );
}
function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text size='xs' c='dimmed'>
        {label}
      </Text>
      <Text fw={600} className='break-all'>
        {value}
      </Text>
    </div>
  );
}
