import { SimpleGrid, Stack, Text } from '@mantine/core';
import { type FormEvent, useEffect, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Button from '@/elements/Button.tsx';
import Select from '@/elements/input/Select.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { createDatabase } from '../api/client.ts';
import { type DbevMutationFailure, dbevMutationFailure } from '../api/mutationErrors.ts';
import type { DatabaseProtocol, DatabaseRecord } from '../api/types.ts';
import { protocolLabels } from '../components/protocols.ts';
import translations from '../translations.ts';
import MutationFailureAlert from './components/MutationFailureAlert.tsx';

interface Props {
  opened: boolean;
  server: string;
  protocols: DatabaseProtocol[];
  imageOptions?: Partial<Record<DatabaseProtocol, string[]>>;
  onClose: () => void;
  onCreated: (database: DatabaseRecord) => void;
  onCheck: () => void | Promise<unknown>;
}

export default function CreateDatabaseModal({
  opened,
  server,
  protocols,
  imageOptions,
  onClose,
  onCreated,
  onCheck,
}: Props) {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [protocol, setProtocol] = useState<DatabaseProtocol>('postgres');
  const [databaseName, setDatabaseName] = useState('');
  const [username, setUsername] = useState('');
  const [image, setImage] = useState('');
  const [failure, setFailure] = useState<DbevMutationFailure | null>(null);
  const [checkingState, setCheckingState] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setDisplayName('');
    setProtocol(protocols[0] ?? 'postgres');
    setDatabaseName('');
    setUsername('');
    setImage('');
    setFailure(null);
  }, [opened, protocols]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!displayName.trim()) return;
    setLoading(true);
    setFailure(null);
    try {
      const database = await createDatabase(server, {
        protocol,
        display_name: displayName.trim(),
        database_name: databaseName.trim() || undefined,
        username: username.trim() || undefined,
        image: image.trim() || undefined,
      });
      addToast(t('server.created', {}), 'success');
      onCreated(database);
      onClose();
    } catch (error) {
      const nextFailure = dbevMutationFailure(error, httpErrorToHuman(error));
      setFailure(nextFailure);
      if (!nextFailure.retryable) addToast(nextFailure.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={t('server.createTitle', {})} size='lg'>
      <form onSubmit={submit}>
        <Stack>
          <MutationFailureAlert
            failure={failure}
            checking={checkingState}
            onCheck={() => {
              setCheckingState(true);
              void Promise.resolve(onCheck())
                .then(() => {
                  setFailure(null);
                  addToast(t('server.databaseListRefreshed', {}), 'success');
                })
                .catch((error) => setFailure(dbevMutationFailure(error, httpErrorToHuman(error))))
                .finally(() => setCheckingState(false));
            }}
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label={t('server.displayName', {})}
              value={displayName}
              onChange={(event) => setDisplayName(event.currentTarget.value)}
              required
              maxLength={191}
            />
            <Select
              label={t('server.protocol', {})}
              value={protocol}
              onChange={(value) => {
                if (!value) return;
                setProtocol(value as DatabaseProtocol);
                setImage('');
              }}
              data={protocols.map((value) => ({ value, label: protocolLabels[value] }))}
            />
            <TextInput
              label={t('server.databaseName', {})}
              value={databaseName}
              onChange={(event) => setDatabaseName(event.currentTarget.value)}
              maxLength={63}
            />
            <TextInput
              label={t('server.username', {})}
              value={username}
              onChange={(event) => setUsername(event.currentTarget.value)}
              maxLength={63}
            />
          </SimpleGrid>
          <Select
            label={t('server.image', {})}
            description={t('server.imageDescription', {})}
            placeholder={t('server.nodeDefaultImage', {})}
            data={(imageOptions?.[protocol] ?? []).map((value) => ({ value, label: value }))}
            value={image || null}
            onChange={(value) => setImage(value || '')}
            searchable
            clearable
            allowDeselect
          />
          <Text size='xs' c='dimmed'>
            {t('server.placementDescription', {})}
          </Text>
        </Stack>
        <ModalFooter>
          <Button type='submit' loading={loading} disabled={!displayName.trim()}>
            {t('common.create', {})}
          </Button>
          <Button variant='default' onClick={onClose} disabled={loading}>
            {t('common.cancel', {})}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
