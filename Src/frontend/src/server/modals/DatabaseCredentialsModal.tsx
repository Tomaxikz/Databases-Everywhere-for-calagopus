import { faCopy } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group, Text } from '@mantine/core';
import Button from '@/elements/Button.tsx';
import PasswordInput from '@/elements/input/PasswordInput.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import Stack from '@/elements/Stack.tsx';
import { handleRawCopyToClipboard } from '@/lib/copy.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import type { DatabaseRecord } from '../../api/types.ts';
import translations from '../../translations.ts';

export default function DatabaseCredentialsModal({
  database,
  opened,
  onClose,
}: {
  database: DatabaseRecord;
  opened: boolean;
  onClose: () => void;
}) {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const endpoint = `${database.public_host}:${database.public_port}`;
  const qdrant = database.protocol === 'qdrant';

  return (
    <Modal opened={opened} onClose={onClose} title={t('server.credentials', {})}>
      <Stack>
        <Text size='sm' c='dimmed'>
          {t('server.credentialsDescription', {})}
        </Text>

        <CredentialField
          label={qdrant ? t('server.grpcEndpoint', {}) : t('server.endpoint', {})}
          value={endpoint}
          onCopy={(value) => handleRawCopyToClipboard(value, addToast)}
          copyLabel={t('common.copy', {})}
        />
        {!qdrant && (
          <CredentialField
            label={t('server.databaseName', {})}
            value={database.database_name}
            onCopy={(value) => handleRawCopyToClipboard(value, addToast)}
            copyLabel={t('common.copy', {})}
          />
        )}
        {!qdrant && (
          <CredentialField
            label={t('server.username', {})}
            value={database.username}
            onCopy={(value) => handleRawCopyToClipboard(value, addToast)}
            copyLabel={t('common.copy', {})}
          />
        )}
        <CredentialField
          label={qdrant ? t('server.apiKey', {}) : t('server.password', {})}
          value={database.password ?? ''}
          secret
          unavailable={!database.password}
          unavailableMessage={t('server.credentialUnavailable', {})}
          onCopy={(value) => handleRawCopyToClipboard(value, addToast)}
          copyLabel={t('common.copy', {})}
        />
        <CredentialField
          label={t('server.tls', {})}
          value={database.tls ? t('server.enabled', {}) : t('server.disabled', {})}
          copy={false}
          onCopy={(value) => handleRawCopyToClipboard(value, addToast)}
          copyLabel={t('common.copy', {})}
        />
        {database.connection_uri && (
          <CredentialField
            label={t('server.connectionUri', {})}
            value={database.connection_uri}
            secret
            onCopy={(value) => handleRawCopyToClipboard(value, addToast)}
            copyLabel={t('common.copy', {})}
          />
        )}

        <ModalFooter>
          <Button variant='default' onClick={onClose}>
            {t('common.close', {})}
          </Button>
        </ModalFooter>
      </Stack>
    </Modal>
  );
}

function CredentialField({
  label,
  value,
  secret = false,
  copy = true,
  unavailable = false,
  unavailableMessage,
  onCopy,
  copyLabel,
}: {
  label: string;
  value: string;
  secret?: boolean;
  copy?: boolean;
  unavailable?: boolean;
  unavailableMessage?: string;
  onCopy: (value: string) => void;
  copyLabel: string;
}) {
  const input = secret ? (
    <PasswordInput
      label={label}
      value={value}
      description={unavailable ? unavailableMessage : undefined}
      className='min-w-0 flex-1'
      readOnly
      disabled={unavailable}
    />
  ) : (
    <TextInput label={label} value={value} className='min-w-0 flex-1' readOnly />
  );

  return (
    <Group align='flex-end' gap='xs' wrap='nowrap'>
      {input}
      {copy && !unavailable && (
        <Button variant='default' px='sm' onClick={() => onCopy(value)} aria-label={`${copyLabel} ${label}`}>
          <FontAwesomeIcon icon={faCopy} />
        </Button>
      )}
    </Group>
  );
}
