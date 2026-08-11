import { Group, Stack, Text } from '@mantine/core';
import Alert from '@/elements/Alert.tsx';
import Button from '@/elements/Button.tsx';
import type { DbevMutationFailure } from '../../api/mutationErrors.ts';
import translations from '../../translations.ts';

export default function MutationFailureAlert({
  failure,
  checking,
  onCheck,
}: {
  failure: DbevMutationFailure | null;
  checking?: boolean;
  onCheck?: () => void;
}) {
  const { t } = translations.useTranslations();
  if (!failure) return null;

  return (
    <Alert color={failure.retryable ? 'yellow' : 'red'}>
      <Stack gap='xs'>
        <Text size='sm'>{failure.message}</Text>
        {failure.errorId && (
          <Text size='xs' c='dimmed' ff='monospace'>
            Support reference: {failure.errorId}
          </Text>
        )}
        {(failure.retryable || failure.requiresReconciliation) && onCheck && (
          <Group justify='flex-end'>
            <Button size='compact-xs' variant='default' loading={checking} onClick={onCheck}>
              {t('server.checkStateBeforeRetry', {})}
            </Button>
          </Group>
        )}
      </Stack>
    </Alert>
  );
}
