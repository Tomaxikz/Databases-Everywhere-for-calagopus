import { Stack, Text } from '@mantine/core';
import Button from '@/elements/Button.tsx';
import Code from '@/elements/Code.tsx';
import CopyOnClick from '@/elements/CopyOnClick.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import type { NodeCredentials } from '../api/types.ts';
import translations from '../translations.ts';

export default function NodeCredentialsModal({
  credentials,
  onClose,
}: {
  credentials: NodeCredentials | null;
  onClose: () => void;
}) {
  const { t } = translations.useTranslations();
  return (
    <Modal
      opened={Boolean(credentials)}
      onClose={onClose}
      title={t('admin.daemonConfig', {})}
      size='xl'
      closeOnClickOutside={false}
    >
      {credentials && (
        <Stack>
          <Text c='orange' size='sm'>
            {t('admin.credentialsWarning', {})}
          </Text>
          <Secret label='Daemon UUID' value={credentials.daemon_uuid} />
          <Secret label='Token ID' value={credentials.token_id} />
          <Secret label='API token' value={credentials.token} />
          <Secret label='JWT signing key' value={credentials.jwt_signing_key} />
          <Text fw={600}>config.yml</Text>
          <CopyOnClick content={credentials.configuration_yaml} className='w-full text-left'>
            <Code block className='whitespace-pre-wrap break-all max-h-96 overflow-auto'>
              {credentials.configuration_yaml}
            </Code>
          </CopyOnClick>
        </Stack>
      )}
      <ModalFooter>
        <Button onClick={onClose}>{t('common.close', {})}</Button>
      </ModalFooter>
    </Modal>
  );
}

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text size='xs' c='dimmed'>
        {label}
      </Text>
      <CopyOnClick content={value}>
        <Code className='break-all'>{value}</Code>
      </CopyOnClick>
    </div>
  );
}
