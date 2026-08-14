import { faClockRotateLeft, faFileArrowUp, faFolderOpen } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Button from '@/elements/Button.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import Tabs from '@/elements/Tabs.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { deleteStagedUpload } from '../../api/client.ts';
import type { DatabaseRecord, TemporaryUploadRecord } from '../../api/types.ts';
import TransferComposer, { type ImportPreset } from '../transfers/TransferComposer.tsx';
import TransferFiles from '../transfers/TransferFiles.tsx';
import TransferHistory from '../transfers/TransferHistory.tsx';
import { cancellationDeletesUpload } from '../transfers/uploadContracts.ts';

type TransferSection = 'transfer' | 'history' | 'files';

export default function TransfersTab({ server, database }: { server: string; database: DatabaseRecord }) {
  const { addToast } = useToast();
  const [section, setSection] = useState<TransferSection>('transfer');
  const [importPreset, setImportPreset] = useState<ImportPreset | null>(null);
  const [readyUpload, setReadyUpload] = useState<TemporaryUploadRecord | null>(null);
  const [pendingSection, setPendingSection] = useState<TransferSection | null>(null);
  const [discardingUpload, setDiscardingUpload] = useState(false);
  const readOnly = !database.mutations_allowed;

  const changeSection = (next: TransferSection) => {
    if (section === 'transfer' && next !== 'transfer' && readyUpload) {
      setPendingSection(next);
      return;
    }
    setSection(next);
  };

  if (readOnly) {
    return (
      <Stack mt='md'>
        <Alert color='yellow'>
          {database.mutation_block_reason ||
            'Import, export, download, retry, and file actions are disabled while this database host is in read-only compatibility mode.'}
        </Alert>
        <TransferHistory server={server} database={database} readOnly />
      </Stack>
    );
  }

  return (
    <Stack mt='md'>
      <Tabs
        value={section}
        onChange={(value) => changeSection((value || 'transfer') as TransferSection)}
        keepMounted={false}
      >
        <Tabs.List>
          <Tabs.Tab value='transfer' leftSection={<FontAwesomeIcon icon={faFileArrowUp} />}>
            Import & export
          </Tabs.Tab>
          <Tabs.Tab value='history' leftSection={<FontAwesomeIcon icon={faClockRotateLeft} />}>
            Transfer history
          </Tabs.Tab>
          <Tabs.Tab value='files' leftSection={<FontAwesomeIcon icon={faFolderOpen} />}>
            Files
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value='transfer' pt='md'>
          <TransferComposer
            server={server}
            database={database}
            preset={importPreset}
            onReadyUploadChange={setReadyUpload}
            onQueued={() => {
              setReadyUpload(null);
              setImportPreset(null);
              setSection('history');
            }}
          />
        </Tabs.Panel>
        <Tabs.Panel value='history' pt='md'>
          <TransferHistory server={server} database={database} />
        </Tabs.Panel>
        <Tabs.Panel value='files' pt='md'>
          <TransferFiles
            server={server}
            database={database}
            onImport={(id, kind) => {
              setImportPreset(kind === 'upload' ? null : { revision: Date.now(), id, kind });
              changeSection('transfer');
            }}
          />
        </Tabs.Panel>
      </Tabs>

      <Modal
        opened={pendingSection !== null}
        onClose={() => setPendingSection(null)}
        title='Keep this temporary upload?'
      >
        <Text>
          <strong>{readyUpload?.original_filename}</strong> is ready on the database host. Keep it so you can resume the
          import later, or discard it before leaving this page.
        </Text>
        <ModalFooter>
          <Button
            color='red'
            loading={discardingUpload}
            onClick={async () => {
              if (!readyUpload || !pendingSection || !cancellationDeletesUpload(readyUpload.state, false)) return;
              setDiscardingUpload(true);
              try {
                await deleteStagedUpload(server, database.uuid, readyUpload.upload_id);
                setReadyUpload(null);
                setSection(pendingSection);
                setPendingSection(null);
                addToast('Temporary upload discarded.', 'success');
              } catch (cause) {
                addToast(httpErrorToHuman(cause), 'error');
              } finally {
                setDiscardingUpload(false);
              }
            }}
          >
            Discard upload
          </Button>
          <Button
            variant='default'
            disabled={discardingUpload}
            onClick={() => {
              if (pendingSection) setSection(pendingSection);
              setPendingSection(null);
            }}
          >
            Keep and continue
          </Button>
        </ModalFooter>
      </Modal>
    </Stack>
  );
}
