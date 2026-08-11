import type { ModalProps } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Button from '@/elements/Button.tsx';
import Select from '@/elements/input/Select.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import Stack from '@/elements/Stack.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { assignHostToLocation, assignHostToPanelNode, listNodes } from '../../api/client.ts';
import { dbevQueryKeys } from '../../api/queryKeys.ts';
import translations from '../../translations.ts';
import type { AssignmentTarget } from './types.ts';

interface Props extends ModalProps {
  target: AssignmentTarget;
  targetUuid: string;
  assignedHostUuids: string[];
}

export default function AssignHostModal({ target, targetUuid, assignedHostUuids, ...props }: Props) {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [hostUuid, setHostUuid] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const hosts = useQuery({ queryKey: dbevQueryKeys.adminNodes(), queryFn: listNodes, enabled: props.opened });
  const assigned = useMemo(() => new Set(assignedHostUuids), [assignedHostUuids]);
  const options = (hosts.data ?? [])
    .filter((host) => !assigned.has(host.uuid))
    .map((host) => ({ value: host.uuid, label: `${host.name} · ${host.public_host}` }));

  const assign = async () => {
    if (!hostUuid) return;
    setLoading(true);
    try {
      if (target === 'panel-node') await assignHostToPanelNode(targetUuid, hostUuid);
      else await assignHostToLocation(targetUuid, hostUuid);
      await queryClient.invalidateQueries({
        queryKey:
          target === 'panel-node'
            ? dbevQueryKeys.panelNodeAssignments(targetUuid)
            : dbevQueryKeys.locationAssignments(targetUuid),
      });
      await queryClient.invalidateQueries({ queryKey: dbevQueryKeys.panelNodeAvailabilityRoot() });
      addToast(t('assignments.assigned', {}), 'success');
      setHostUuid(null);
      props.onClose();
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title={t('assignments.addTitle', {})} {...props}>
      <Stack>
        <Select
          withAsterisk
          label={t('assignments.host', {})}
          description={t('assignments.hostDescription', {})}
          value={hostUuid}
          onChange={setHostUuid}
          data={options}
          searchable
          loading={hosts.isPending}
          nothingFoundMessage={t('assignments.noAvailableHosts', {})}
        />
        <ModalFooter>
          <Button onClick={assign} loading={loading} disabled={!hostUuid}>
            {t('assignments.assign', {})}
          </Button>
          <Button variant='default' onClick={props.onClose} disabled={loading}>
            {t('common.close', {})}
          </Button>
        </ModalFooter>
      </Stack>
    </Modal>
  );
}
