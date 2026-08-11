import { faBoxesStacked, faPlus, faRotate } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Route, Routes, useNavigate, useSearchParams } from 'react-router';
import { httpErrorToHuman } from '@/api/axios.ts';
import Button from '@/elements/Button.tsx';
import { AdminCan } from '@/elements/Can.tsx';
import AdminContentContainer from '@/elements/containers/AdminContentContainer.tsx';
import Table from '@/elements/Table.tsx';
import AdminPermissionGuard from '@/routers/guards/AdminPermissionGuard.tsx';
import { listNodes } from '../api/client.ts';
import { dbevQueryKeys } from '../api/queryKeys.ts';
import type { NodeCredentials, NodeRecord } from '../api/types.ts';
import translations from '../translations.ts';
import ImageCatalogPage from './ImageCatalogPage.tsx';
import NodeCreateOrUpdate from './NodeCreateOrUpdate.tsx';
import NodeCredentialsModal from './NodeCredentialsModal.tsx';
import NodeEditPage from './NodeEditPage.tsx';
import NodeTableRow from './NodeTableRow.tsx';
import NodeWorkspace from './NodeWorkspace.tsx';

function NodesContainer() {
  const { t } = translations.useTranslations();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [credentials, setCredentials] = useState<NodeCredentials | null>(null);
  const selectedId = searchParams.get('node');
  const queryKey = dbevQueryKeys.adminNodes();
  const query = useQuery({
    queryKey,
    queryFn: listNodes,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const selected = query.data?.find((node) => node.uuid === selectedId) ?? null;
  useEffect(() => {
    if (selectedId && query.data && !selected) {
      const next = new URLSearchParams(searchParams);
      next.delete('node');
      setSearchParams(next, { replace: true });
    }
  }, [selectedId, selected, query.data, searchParams, setSearchParams]);

  const filteredNodes = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return query.data ?? [];
    return (query.data ?? []).filter((node) =>
      [node.uuid, node.name, node.api_url, node.public_host].some((value) => value?.toLowerCase().includes(needle)),
    );
  }, [query.data, search]);

  const pagination = query.data
    ? {
        total: filteredNodes.length,
        perPage: Math.max(filteredNodes.length, 1),
        page: 1,
        data: filteredNodes,
      }
    : undefined;

  const selectNode = (node: NodeRecord | null) => {
    const next = new URLSearchParams(searchParams);
    if (node) next.set('node', node.uuid);
    else next.delete('node');
    setSearchParams(next);
  };

  return (
    <AdminContentContainer
      title={selected?.name || t('admin.title', {})}
      subtitle={selected ? selected.api_url : t('admin.subtitle', {})}
      search={selected ? undefined : search}
      setSearch={selected ? undefined : setSearch}
      contentRight={
        selected ? (
          <Group gap='xs'>
            <Button
              variant='default'
              loading={query.isFetching}
              leftSection={<FontAwesomeIcon icon={faRotate} />}
              onClick={() => void query.refetch()}
            >
              {t('common.refresh', {})}
            </Button>
            <Button variant='default' onClick={() => selectNode(null)}>
              {t('admin.backToNodes', {})}
            </Button>
            <Button
              variant='default'
              leftSection={<FontAwesomeIcon icon={faBoxesStacked} />}
              onClick={() => navigate(`/admin/databases-everywhere/images/${selected.uuid}`)}
            >
              {t('admin.imageCatalog.open', {})}
            </Button>
          </Group>
        ) : (
          <Group gap='xs'>
            <Button
              variant='default'
              loading={query.isFetching}
              leftSection={<FontAwesomeIcon icon={faRotate} />}
              onClick={() => void query.refetch()}
            >
              {t('common.refresh', {})}
            </Button>
            <Button
              variant='default'
              leftSection={<FontAwesomeIcon icon={faBoxesStacked} />}
              onClick={() => navigate('/admin/databases-everywhere/images')}
            >
              {t('admin.imageCatalog.open', {})}
            </Button>
            <AdminCan action='databases-everywhere-nodes.create'>
              <Button
                leftSection={<FontAwesomeIcon icon={faPlus} />}
                onClick={() => navigate('/admin/databases-everywhere/new')}
              >
                {t('admin.addNode', {})}
              </Button>
            </AdminCan>
          </Group>
        )
      }
    >
      {selected ? (
        <NodeWorkspace
          node={selected}
          onDeleted={() => {
            selectNode(null);
            query.refetch();
          }}
          onCredentials={setCredentials}
        />
      ) : (
        <Table
          columns={[
            t('admin.columns.name', {}),
            t('admin.columns.uuid', {}),
            t('admin.columns.status', {}),
            t('admin.columns.defaults', {}),
            t('admin.columns.lastSeen', {}),
          ]}
          loading={query.isPending}
          pagination={pagination}
          allowSelect={false}
          error={query.error ? httpErrorToHuman(query.error) : null}
        >
          {filteredNodes.map((node) => (
            <NodeTableRow node={node} key={node.uuid} />
          ))}
        </Table>
      )}

      <NodeCredentialsModal credentials={credentials} onClose={() => setCredentials(null)} />
    </AdminContentContainer>
  );
}

export default function NodesPage() {
  return (
    <Routes>
      <Route path='/' element={<NodesContainer />} />
      <Route path='/images' element={<ImageCatalogPage />} />
      <Route path='/images/:node' element={<ImageCatalogPage />} />
      <Route path='/images/:node/:protocol' element={<ImageCatalogPage />} />
      <Route element={<AdminPermissionGuard permission='databases-everywhere-nodes.create' />}>
        <Route path='/new' element={<NodeCreateOrUpdate />} />
      </Route>
      <Route element={<AdminPermissionGuard permission='databases-everywhere-nodes.update' />}>
        <Route path='/:node/edit' element={<NodeEditPage />} />
      </Route>
    </Routes>
  );
}
