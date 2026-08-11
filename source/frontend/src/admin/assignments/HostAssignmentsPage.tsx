import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Button from '@/elements/Button.tsx';
import { AdminCan } from '@/elements/Can.tsx';
import AdminSubContentContainer from '@/elements/containers/AdminSubContentContainer.tsx';
import Table from '@/elements/Table.tsx';
import { listLocationHostAssignments, listPanelNodeHostAssignments } from '../../api/client.ts';
import { dbevQueryKeys } from '../../api/queryKeys.ts';
import translations from '../../translations.ts';
import AssignHostModal from './AssignHostModal.tsx';
import HostAssignmentRow from './HostAssignmentRow.tsx';
import type { AssignmentTarget } from './types.ts';

interface Props {
  target: AssignmentTarget;
  targetUuid: string;
  targetName: string;
}

export default function HostAssignmentsPage({ target, targetUuid, targetName }: Props) {
  const { t } = translations.useTranslations();
  const [search, setSearch] = useState('');
  const [assigning, setAssigning] = useState(false);
  const query = useQuery({
    queryKey:
      target === 'panel-node'
        ? dbevQueryKeys.panelNodeAssignments(targetUuid)
        : dbevQueryKeys.locationAssignments(targetUuid),
    queryFn: () =>
      target === 'panel-node' ? listPanelNodeHostAssignments(targetUuid) : listLocationHostAssignments(targetUuid),
  });
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return query.data ?? [];
    return (query.data ?? []).filter(({ host }) =>
      [host.uuid, host.name, host.api_url, host.public_host].some((value) => value.toLowerCase().includes(needle)),
    );
  }, [query.data, search]);
  const pagination = query.data
    ? { total: filtered.length, perPage: Math.max(filtered.length, 1), page: 1, data: filtered }
    : undefined;

  return (
    <AdminSubContentContainer
      title={t('assignments.title', {})}
      subtitle={
        target === 'panel-node' ? t('assignments.nodeDescription', {}) : t('assignments.locationDescription', {})
      }
      titleOrder={2}
      search={search}
      setSearch={setSearch}
      contentRight={
        <AdminCan action='databases-everywhere-nodes.assign'>
          <Button onClick={() => setAssigning(true)} leftSection={<FontAwesomeIcon icon={faPlus} />}>
            {t('assignments.add', {})}
          </Button>
        </AdminCan>
      }
    >
      <AssignHostModal
        target={target}
        targetUuid={targetUuid}
        assignedHostUuids={(query.data ?? []).map(({ host }) => host.uuid)}
        opened={assigning}
        onClose={() => setAssigning(false)}
      />
      <Table
        columns={[
          t('assignments.columns.host', {}),
          t('assignments.columns.uuid', {}),
          t('assignments.columns.publicHost', {}),
          t('assignments.columns.defaults', {}),
          t('assignments.columns.status', {}),
          t('assignments.columns.assigned', {}),
          '',
        ]}
        loading={query.isPending}
        error={query.error ? httpErrorToHuman(query.error) : null}
        pagination={pagination}
        allowSelect={false}
      >
        {filtered.map((assignment) => (
          <HostAssignmentRow
            key={assignment.host.uuid}
            assignment={assignment}
            target={target}
            targetUuid={targetUuid}
            targetName={targetName}
          />
        ))}
      </Table>
    </AdminSubContentContainer>
  );
}
