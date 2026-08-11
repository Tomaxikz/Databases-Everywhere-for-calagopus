import { faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Button from '@/elements/Button.tsx';
import { AdminCan } from '@/elements/Can.tsx';
import Code from '@/elements/Code.tsx';
import ConfirmationModal from '@/elements/modals/ConfirmationModal.tsx';
import { TableData, TableRow } from '@/elements/Table.tsx';
import FormattedTimestamp from '@/elements/time/FormattedTimestamp.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { removeHostFromLocation, removeHostFromPanelNode } from '../../api/client.ts';
import { dbevQueryKeys } from '../../api/queryKeys.ts';
import type { HostAssignment } from '../../api/types.ts';
import { StatusBadge } from '../../components/common.tsx';
import translations from '../../translations.ts';
import type { AssignmentTarget } from './types.ts';

interface Props {
  assignment: HostAssignment;
  target: AssignmentTarget;
  targetUuid: string;
  targetName: string;
}

export default function HostAssignmentRow({ assignment, target, targetUuid, targetName }: Props) {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const host = assignment.host;
  const status = !host.enabled ? 'disabled' : host.last_error ? 'failed' : 'healthy';

  const remove = async () => {
    try {
      if (target === 'panel-node') await removeHostFromPanelNode(targetUuid, host.uuid);
      else await removeHostFromLocation(targetUuid, host.uuid);
      await queryClient.invalidateQueries({
        queryKey:
          target === 'panel-node'
            ? dbevQueryKeys.panelNodeAssignments(targetUuid)
            : dbevQueryKeys.locationAssignments(targetUuid),
      });
      await queryClient.invalidateQueries({ queryKey: dbevQueryKeys.panelNodeAvailabilityRoot() });
      addToast(t('assignments.removed', {}), 'success');
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    }
  };

  return (
    <>
      <ConfirmationModal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title={t('assignments.removeTitle', {})}
        confirm={t('assignments.remove', {})}
        onConfirmed={remove}
      >
        {t('assignments.removeDescription', { host: host.name, target: targetName })}
      </ConfirmationModal>
      <TableRow>
        <TableData>
          <Text fw={500}>{host.name}</Text>
          <Text size='xs' c='dimmed'>
            {host.api_url}
          </Text>
        </TableData>
        <TableData>
          <Code>{host.uuid}</Code>
        </TableData>
        <TableData>{host.public_host}</TableData>
        <TableData>
          {host.default_cpu_cores} CPU · {host.default_memory_mib} MiB · {host.default_disk_mib} MiB
        </TableData>
        <TableData>
          <StatusBadge status={status} />
        </TableData>
        <TableData>
          <FormattedTimestamp timestamp={assignment.created} />
        </TableData>
        <TableData>
          <Group justify='flex-end'>
            <AdminCan action='databases-everywhere-nodes.assign'>
              <Button
                size='xs'
                variant='subtle'
                color='red'
                onClick={() => setConfirming(true)}
                leftSection={<FontAwesomeIcon icon={faTrash} />}
              >
                {t('assignments.remove', {})}
              </Button>
            </AdminCan>
          </Group>
        </TableData>
      </TableRow>
    </>
  );
}
