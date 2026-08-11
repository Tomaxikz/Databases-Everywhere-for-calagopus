import { faArrowLeft, faCheck, faPlus, faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Button from '@/elements/Button.tsx';
import { AdminCan } from '@/elements/Can.tsx';
import Card from '@/elements/Card.tsx';
import Code from '@/elements/Code.tsx';
import AdminContentContainer from '@/elements/containers/AdminContentContainer.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import Table, { TableData, TableRow } from '@/elements/Table.tsx';
import { bytesToString } from '@/lib/size.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import { getNode, listNodes, listRegistryImages, updateNodeImages } from '../api/client.ts';
import { dbevQueryKeys } from '../api/queryKeys.ts';
import type { NodeRecord } from '../api/types.ts';
import { formatTimestamp } from '../components/common.tsx';
import ProtocolIcon from '../components/ProtocolIcon.tsx';
import { protocolLabels } from '../components/protocols.ts';
import translations from '../translations.ts';
import { initialNodeFormValues, type ProtocolKey, protocols } from './nodeForm.ts';

const adminPath = '/admin/databases-everywhere/images';

function NodesCatalog() {
  const { t } = translations.useTranslations();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: dbevQueryKeys.adminNodes(),
    queryFn: listNodes,
    staleTime: 30_000,
  });
  const nodes = query.data ?? [];
  const pagination = query.data
    ? { total: nodes.length, page: 1, perPage: Math.max(nodes.length, 1), data: nodes }
    : undefined;

  return (
    <AdminContentContainer
      title={t('admin.imageCatalog.title', {})}
      subtitle={t('admin.imageCatalog.subtitle', {})}
      contentRight={
        <Button
          variant='default'
          leftSection={<FontAwesomeIcon icon={faArrowLeft} />}
          onClick={() => navigate('/admin/databases-everywhere')}
        >
          {t('admin.backToNodes', {})}
        </Button>
      }
    >
      <Table
        columns={[
          t('admin.imageCatalog.node', {}),
          t('admin.imageCatalog.publicHost', {}),
          t('admin.imageCatalog.configuredTypes', {}),
          '',
        ]}
        loading={query.isPending}
        error={query.error ? httpErrorToHuman(query.error) : null}
        pagination={pagination}
        allowSelect={false}
      >
        {nodes.map((node) => {
          const values = initialNodeFormValues(node);
          const enabled = protocols.filter(([protocol]) => values.config.protocols[protocol].enabled).length;
          return (
            <TableRow key={node.uuid}>
              <TableData>
                <Text fw={600}>{node.name}</Text>
                <Code>{node.uuid}</Code>
              </TableData>
              <TableData>{node.public_host}</TableData>
              <TableData>{t('admin.imageCatalog.typeCount', { count: enabled })}</TableData>
              <TableData className='w-px'>
                <Button size='compact-sm' onClick={() => navigate(`${adminPath}/${node.uuid}`)}>
                  {t('admin.imageCatalog.manageImages', {})}
                </Button>
              </TableData>
            </TableRow>
          );
        })}
      </Table>
    </AdminContentContainer>
  );
}

function ProtocolCatalog({ node }: { node: string }) {
  const { t } = translations.useTranslations();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: dbevQueryKeys.adminNode(node),
    queryFn: () => getNode(node),
    enabled: Boolean(node),
  });
  const values = query.data ? initialNodeFormValues(query.data) : null;
  const pagination = values
    ? { total: protocols.length, page: 1, perPage: protocols.length, data: Array.from(protocols) }
    : undefined;

  return (
    <AdminContentContainer
      title={
        query.data ? t('admin.imageCatalog.nodeTitle', { node: query.data.name }) : t('admin.imageCatalog.title', {})
      }
      subtitle={t('admin.imageCatalog.nodeSubtitle', {})}
      contentRight={
        <Button
          variant='default'
          leftSection={<FontAwesomeIcon icon={faArrowLeft} />}
          onClick={() => navigate(adminPath)}
        >
          {t('admin.imageCatalog.backToCatalog', {})}
        </Button>
      }
    >
      <Table
        columns={[
          t('admin.imageCatalog.databaseType', {}),
          t('admin.imageCatalog.defaultImage', {}),
          t('admin.imageCatalog.allowedCount', {}),
          '',
        ]}
        loading={query.isPending}
        error={query.error ? httpErrorToHuman(query.error) : null}
        pagination={pagination}
        allowSelect={false}
      >
        {values &&
          protocols.map(([protocol]) => {
            const config = values.config.protocols[protocol];
            return (
              <TableRow key={protocol}>
                <TableData>
                  <Group gap='sm' wrap='nowrap'>
                    <ProtocolIcon protocol={protocol} size={28} />
                    <div>
                      <Text fw={600}>{protocolLabels[protocol]}</Text>
                      <Text size='xs' c={config.enabled ? 'green' : 'dimmed'}>
                        {config.enabled ? t('common.enabled', {}) : t('common.disabled', {})}
                      </Text>
                    </div>
                  </Group>
                </TableData>
                <TableData>
                  <Code>{config.image}</Code>
                </TableData>
                <TableData>{config.allowedImages.length}</TableData>
                <TableData className='w-px'>
                  <Button size='compact-sm' onClick={() => navigate(`${adminPath}/${node}/${protocol}`)}>
                    {t('admin.imageCatalog.browseImages', {})}
                  </Button>
                </TableData>
              </TableRow>
            );
          })}
      </Table>
    </AdminContentContainer>
  );
}

function validPinnedImage(image: string): boolean {
  const value = image.trim();
  const tail = value.split('/').at(-1) || '';
  const tag = tail.includes(':') ? tail.slice(tail.lastIndexOf(':') + 1) : '';
  return (
    value.length > 0 &&
    value.length <= 255 &&
    !/\s/.test(value) &&
    (value.includes('@sha256:') || (tag.length > 0 && tag.toLowerCase() !== 'latest'))
  );
}

function RegistryCatalog({ node, protocol }: { node: string; protocol: ProtocolKey }) {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [manualImage, setManualImage] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const nodeQuery = useQuery({
    queryKey: dbevQueryKeys.adminNode(node),
    queryFn: () => getNode(node),
    enabled: Boolean(node),
  });
  const registryQuery = useQuery({
    queryKey: dbevQueryKeys.adminImageRegistry(protocol, page),
    queryFn: () => listRegistryImages(protocol, page, 50),
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
  });
  const values = nodeQuery.data ? initialNodeFormValues(nodeQuery.data) : null;
  const protocolConfig = values?.config.protocols[protocol];
  const defaultImage = protocolConfig?.image ?? '';
  const allowedImages = Array.from(new Set([defaultImage, ...(protocolConfig?.allowedImages ?? [])])).filter(Boolean);
  const needle = deferredSearch.trim().toLowerCase();
  const registryImages = useMemo(
    () =>
      (registryQuery.data?.images ?? []).filter(
        (image) =>
          !needle || image.tag.toLowerCase().includes(needle) || image.reference.toLowerCase().includes(needle),
      ),
    [needle, registryQuery.data?.images],
  );
  const registryPagination = registryQuery.data
    ? {
        total: registryImages.length,
        page: 1,
        perPage: Math.max(registryImages.length, 1),
        data: registryImages,
      }
    : undefined;

  const persist = async (nextImages: string[], changed: string, nextDefault = defaultImage) => {
    const nodeRecord = nodeQuery.data;
    if (!nodeRecord) return;
    if (nextImages.length > 100) {
      addToast(t('admin.imageCatalog.limitReached', {}), 'error');
      return;
    }
    setSaving(changed);
    try {
      const nextValues = initialNodeFormValues(nodeRecord);
      nextValues.config.protocols[protocol].image = nextDefault;
      nextValues.config.protocols[protocol].allowedImages = Array.from(new Set([nextDefault, ...nextImages]));
      const updated = await updateNodeImages(
        nodeRecord.uuid,
        protocol,
        nextValues.config.protocols[protocol].image,
        nextValues.config.protocols[protocol].allowedImages,
      );
      queryClient.setQueryData(dbevQueryKeys.adminNode(nodeRecord.uuid), updated);
      queryClient.setQueryData<NodeRecord[]>(dbevQueryKeys.adminNodes(), (current) =>
        current?.map((entry) => (entry.uuid === updated.uuid ? updated : entry)),
      );
      addToast(t('admin.imageCatalog.saved', {}), 'success');
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setSaving(null);
    }
  };

  const allowImage = (image: string) => {
    const value = image.trim();
    if (!validPinnedImage(value)) {
      addToast(t('admin.imageCatalog.invalidImage', {}), 'error');
      return;
    }
    if (allowedImages.includes(value)) return;
    void persist([...allowedImages, value], value).then(() => setManualImage(''));
  };

  return (
    <AdminContentContainer
      title={t('admin.imageCatalog.protocolTitle', { protocol: protocolLabels[protocol] })}
      subtitle={nodeQuery.data ? t('admin.imageCatalog.protocolSubtitle', { node: nodeQuery.data.name }) : undefined}
      contentRight={
        <Button
          variant='default'
          leftSection={<FontAwesomeIcon icon={faArrowLeft} />}
          onClick={() => navigate(`${adminPath}/${node}`)}
        >
          {t('admin.imageCatalog.backToTypes', {})}
        </Button>
      }
    >
      <Stack gap='md'>
        {nodeQuery.error && <Alert color='red'>{httpErrorToHuman(nodeQuery.error)}</Alert>}
        <Alert color='blue' title={t('admin.imageCatalog.restartTitle', {})}>
          {t('admin.imageCatalog.restartDescription', {})}
        </Alert>

        <Card>
          <Group justify='space-between' align='flex-start' mb='md'>
            <div>
              <Title order={4}>{t('admin.imageCatalog.allowedTitle', {})}</Title>
              <Text size='sm' c='dimmed'>
                {t('admin.imageCatalog.allowedDescription', {})}
              </Text>
            </div>
            <Text size='sm' c='dimmed'>
              {allowedImages.length}/100
            </Text>
          </Group>
          <Stack gap='xs'>
            {allowedImages.map((image) => (
              <Group key={image} justify='space-between' wrap='nowrap'>
                <Code className='min-w-0 truncate'>{image}</Code>
                {image === defaultImage ? (
                  <Text size='xs' c='dimmed'>
                    {t('admin.imageCatalog.defaultBadge', {})}
                  </Text>
                ) : (
                  <AdminCan action='databases-everywhere-nodes.update'>
                    <Group gap='xs' wrap='nowrap'>
                      <Button
                        size='compact-xs'
                        variant='default'
                        loading={saving === `default:${image}`}
                        disabled={saving !== null}
                        onClick={() => void persist(allowedImages, `default:${image}`, image)}
                      >
                        {t('admin.imageCatalog.setDefault', {})}
                      </Button>
                      <Button
                        size='compact-xs'
                        variant='subtle'
                        color='red'
                        loading={saving === image}
                        disabled={saving !== null}
                        leftSection={<FontAwesomeIcon icon={faTrash} />}
                        onClick={() =>
                          void persist(
                            allowedImages.filter((entry) => entry !== image),
                            image,
                          )
                        }
                      >
                        {t('common.delete', {})}
                      </Button>
                    </Group>
                  </AdminCan>
                )}
              </Group>
            ))}
          </Stack>
          <AdminCan action='databases-everywhere-nodes.update'>
            <Group mt='md' align='flex-end' wrap='nowrap'>
              <TextInput
                className='flex-1'
                label={t('admin.imageCatalog.manualImage', {})}
                description={t('admin.imageCatalog.manualImageDescription', {})}
                placeholder='registry.example.com/database:1.2.3'
                value={manualImage}
                onChange={(event) => setManualImage(event.currentTarget.value)}
                maxLength={255}
              />
              <Button
                disabled={saving !== null || !manualImage.trim()}
                loading={saving === manualImage.trim()}
                leftSection={<FontAwesomeIcon icon={faPlus} />}
                onClick={() => allowImage(manualImage)}
              >
                {t('admin.imageCatalog.allowImage', {})}
              </Button>
            </Group>
          </AdminCan>
        </Card>

        <Card p={0}>
          <Group justify='space-between' align='flex-end' className='px-4 py-3'>
            <div>
              <Title order={4}>{t('admin.imageCatalog.onlineTitle', {})}</Title>
              <Text size='sm' c='dimmed'>
                {registryQuery.data
                  ? t('admin.imageCatalog.onlineDescription', { repository: registryQuery.data.repository })
                  : t('admin.imageCatalog.loadingRegistry', {})}
              </Text>
            </div>
            <TextInput
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
              placeholder={t('admin.imageCatalog.searchTags', {})}
              w={{ base: 220, sm: 320 }}
            />
          </Group>
          <Table
            flush
            columns={[
              t('admin.imageCatalog.tag', {}),
              t('admin.imageCatalog.reference', {}),
              t('admin.imageCatalog.size', {}),
              t('admin.imageCatalog.updated', {}),
              '',
            ]}
            loading={registryQuery.isFetching && !registryQuery.data}
            error={registryQuery.error ? httpErrorToHuman(registryQuery.error) : null}
            pagination={registryPagination}
            allowSelect={false}
          >
            {registryImages.map((image) => {
              const allowed = allowedImages.includes(image.reference);
              return (
                <TableRow key={image.reference}>
                  <TableData>{image.tag}</TableData>
                  <TableData>
                    <Code>{image.reference}</Code>
                  </TableData>
                  <TableData>{image.size_bytes == null ? '—' : bytesToString(image.size_bytes)}</TableData>
                  <TableData>{image.last_updated ? formatTimestamp(image.last_updated) : '—'}</TableData>
                  <TableData className='w-px'>
                    <AdminCan action='databases-everywhere-nodes.update'>
                      <Button
                        size='compact-xs'
                        variant={allowed ? 'subtle' : 'default'}
                        disabled={allowed || saving !== null}
                        loading={saving === image.reference}
                        leftSection={<FontAwesomeIcon icon={allowed ? faCheck : faPlus} />}
                        onClick={() => allowImage(image.reference)}
                      >
                        {allowed ? t('admin.imageCatalog.allowed', {}) : t('admin.imageCatalog.allow', {})}
                      </Button>
                    </AdminCan>
                  </TableData>
                </TableRow>
              );
            })}
          </Table>
          <Group justify='space-between' className='border-t border-(--mantine-color-default-border) px-4 py-3'>
            <Text size='sm' c='dimmed'>
              {t('admin.imageCatalog.registryPage', { page, total: registryQuery.data?.total ?? 0 })}
            </Text>
            <Group gap='xs'>
              <Button
                size='compact-sm'
                variant='default'
                disabled={!registryQuery.data?.has_previous || registryQuery.isFetching}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                {t('admin.imageCatalog.previous', {})}
              </Button>
              <Button
                size='compact-sm'
                variant='default'
                disabled={!registryQuery.data?.has_next || registryQuery.isFetching}
                onClick={() => setPage((current) => current + 1)}
              >
                {t('admin.imageCatalog.next', {})}
              </Button>
            </Group>
          </Group>
        </Card>
      </Stack>
    </AdminContentContainer>
  );
}

export default function ImageCatalogPage() {
  const { node, protocol } = useParams<{ node?: string; protocol?: string }>();
  const supported = protocols.some(([candidate]) => candidate === protocol);
  if (node && protocol && supported) return <RegistryCatalog node={node} protocol={protocol as ProtocolKey} />;
  if (node) return <ProtocolCatalog node={node} />;
  return <NodesCatalog />;
}
