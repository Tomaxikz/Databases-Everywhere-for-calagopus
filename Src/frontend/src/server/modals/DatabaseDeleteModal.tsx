import { Stack } from '@mantine/core';
import { type FormEvent, useEffect, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Button from '@/elements/Button.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { deleteDatabase, getDatabaseStatus } from '../../api/client.ts';
import { type DbevMutationFailure, dbevMutationFailure } from '../../api/mutationErrors.ts';
import type { DatabaseRecord } from '../../api/types.ts';
import translations from '../../translations.ts';
import MutationFailureAlert from '../components/MutationFailureAlert.tsx';

export default function DatabaseDeleteModal({
  server,
  database,
  opened,
  onClose,
  onDeleted,
}: {
  server: string;
  database: DatabaseRecord;
  opened: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<DbevMutationFailure | null>(null);
  const [checkingState, setCheckingState] = useState(false);

  useEffect(() => {
    if (!opened) {
      setReason('');
      setFailure(null);
      setCheckingState(false);
    }
  }, [opened]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) return;
    setLoading(true);
    setFailure(null);
    try {
      const deferred = await deleteDatabase(server, database.uuid, reason.trim());
      addToast(deferred ? t('server.deferredDelete', {}) : t('server.deleted', {}), deferred ? 'warning' : 'success');
      onClose();
      onDeleted();
    } catch (error) {
      const nextFailure = dbevMutationFailure(error, httpErrorToHuman(error));
      setFailure(nextFailure);
      if (!nextFailure.retryable) addToast(nextFailure.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t('server.deleteDatabase', {})}>
      <form onSubmit={submit}>
        <Stack>
          <Alert color='red'>{t('server.deleteWarning', {})}</Alert>
          <MutationFailureAlert
            failure={failure}
            checking={checkingState}
            onCheck={() => {
              setCheckingState(true);
              void getDatabaseStatus(server, database.uuid)
                .then(() => {
                  setFailure(null);
                  addToast(t('server.databaseStateRefreshed', {}), 'success');
                })
                .catch((error) => setFailure(dbevMutationFailure(error, httpErrorToHuman(error))))
                .finally(() => setCheckingState(false));
            }}
          />
          <TextInput
            label={t('server.reason', {})}
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
            required
          />
        </Stack>
        <ModalFooter>
          <Button type='submit' color='red' loading={loading} disabled={!reason.trim()}>
            {t('common.delete', {})}
          </Button>
          <Button variant='default' onClick={onClose}>
            {t('common.cancel', {})}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
