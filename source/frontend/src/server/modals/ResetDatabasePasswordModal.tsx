import { faWandMagicSparkles } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group, Stack, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Button from '@/elements/Button.tsx';
import PasswordInput from '@/elements/input/PasswordInput.tsx';
import { Modal, ModalFooter } from '@/elements/modals/Modal.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { getDatabase, getDatabaseStatus, resetDatabasePassword } from '../../api/client.ts';
import { type DbevMutationFailure, dbevMutationFailure } from '../../api/mutationErrors.ts';
import type { DatabaseRecord } from '../../api/types.ts';
import translations from '../../translations.ts';
import generateStrongCredential from '../generateStrongCredential.ts';

export default function ResetDatabasePasswordModal({
  server,
  database,
  opened,
  onClose,
  onReset,
  onRefresh,
}: {
  server: string;
  database: DatabaseRecord;
  opened: boolean;
  onClose: () => void;
  onReset: (database: DatabaseRecord) => void;
  onRefresh: () => void | Promise<unknown>;
}) {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<DbevMutationFailure | null>(null);
  const [checkingState, setCheckingState] = useState(false);
  const running = database.status === 'running';
  const qdrant = database.protocol === 'qdrant';
  const forbiddenCharacters = /[\0\r\n]/.test(password);
  const validLength = password.length >= 1 && Array.from(password).length <= 4096;
  const matches = password === confirmation;
  const valid = running && validLength && !forbiddenCharacters && matches;

  const generateCredential = () => {
    try {
      const generated = generateStrongCredential();
      setPassword(generated);
      setConfirmation(generated);
      setError(null);
    } catch {
      setError({
        message: t('server.credentialGenerationFailed', {}),
        retryable: false,
        status: null,
        code: null,
        errorId: null,
      });
    }
  };

  useEffect(() => {
    if (!opened) {
      setPassword('');
      setConfirmation('');
      setError(null);
      setSubmitting(false);
      setCheckingState(false);
    }
  }, [opened]);

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const outcome = await resetDatabasePassword(server, database.uuid, password);
      // Credential disclosure stays on the existing permission-gated database
      // response. The reset response itself never carries the plaintext value.
      const refreshed = await getDatabase(server, database.uuid);
      addToast(
        outcome.restarted ? t('server.passwordResetRestarted', {}) : t('server.passwordResetLive', {}),
        'success',
      );
      onReset(refreshed);
      await Promise.resolve(onRefresh()).catch(() => undefined);
    } catch (cause) {
      setError(dbevMutationFailure(cause, httpErrorToHuman(cause)));
      await getDatabaseStatus(server, database.uuid).catch(() => undefined);
      await Promise.resolve(onRefresh()).catch(() => undefined);
    } finally {
      // A failed request can still have reached DBEV. Never retain the secret
      // while the user checks authoritative state before a manual retry.
      setPassword('');
      setConfirmation('');
      setSubmitting(false);
    }
  };

  const checkStateBeforeRetry = async () => {
    setCheckingState(true);
    try {
      await getDatabaseStatus(server, database.uuid);
      await onRefresh();
      setError(null);
      addToast(t('server.databaseStateRefreshed', {}), 'success');
    } catch (cause) {
      setError(dbevMutationFailure(cause, httpErrorToHuman(cause)));
    } finally {
      setCheckingState(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title={qdrant ? t('server.resetApiKey', {}) : t('server.resetPassword', {})}
      closeOnClickOutside={!submitting}
      closeOnEscape={!submitting}
    >
      <Stack>
        <Alert color='blue' title={t('server.credentialRotation', {})}>
          {t('server.passwordResetWarning', {})}
        </Alert>
        {!running && <Alert color='red'>{t('server.passwordResetRequiresRunning', {})}</Alert>}
        {error && (
          <Alert color={error.retryable ? 'yellow' : 'red'}>
            <Stack gap='xs'>
              <Text size='sm'>{error.message}</Text>
              {error.retryable && (
                <Group justify='flex-end'>
                  <Button
                    size='compact-xs'
                    variant='default'
                    loading={checkingState}
                    onClick={() => void checkStateBeforeRetry()}
                  >
                    {t('server.checkStateBeforeRetry', {})}
                  </Button>
                </Group>
              )}
            </Stack>
          </Alert>
        )}
        <Text size='sm' c='dimmed'>
          {qdrant ? t('server.resetApiKeyDescription', {}) : t('server.resetPasswordDescription', {})}
        </Text>
        <Group justify='flex-end'>
          <Button
            variant='default'
            size='compact-sm'
            leftSection={<FontAwesomeIcon icon={faWandMagicSparkles} />}
            disabled={submitting || !running}
            onClick={generateCredential}
          >
            {qdrant ? t('server.generateApiKey', {}) : t('server.generatePassword', {})}
          </Button>
        </Group>
        <PasswordInput
          label={qdrant ? t('server.newApiKey', {}) : t('server.newPassword', {})}
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
          maxLength={4096}
          disabled={submitting || !running}
          error={
            password && forbiddenCharacters
              ? t('server.passwordForbiddenCharacters', {})
              : password && !validLength
                ? t('server.passwordLength', {})
                : undefined
          }
          autoComplete='new-password'
        />
        <PasswordInput
          label={qdrant ? t('server.confirmApiKey', {}) : t('server.confirmPassword', {})}
          value={confirmation}
          onChange={(event) => setConfirmation(event.currentTarget.value)}
          maxLength={4096}
          disabled={submitting || !running}
          error={confirmation && !matches ? t('server.passwordsDoNotMatch', {}) : undefined}
          autoComplete='new-password'
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
        <ModalFooter>
          <Button loading={submitting} disabled={!valid} onClick={() => void submit()}>
            {submitting
              ? t('server.rotatingPassword', {})
              : qdrant
                ? t('server.resetApiKey', {})
                : t('server.resetPassword', {})}
          </Button>
          <Button variant='default' disabled={submitting} onClick={onClose}>
            {t('common.cancel', {})}
          </Button>
        </ModalFooter>
      </Stack>
    </Modal>
  );
}
