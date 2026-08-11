import { Group, Stack, Text, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Button from '@/elements/Button.tsx';
import Card from '@/elements/Card.tsx';
import NumberInput from '@/elements/input/NumberInput.tsx';
import Switch from '@/elements/input/Switch.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { patchRemoteConfiguration } from '../api/client.ts';
import { dbevQueryKeys } from '../api/queryKeys.ts';
import type { NodeRecord } from '../api/types.ts';
import translations from '../translations.ts';
import {
  artifactPolicyError,
  artifactPolicyFromConfiguration,
  artifactPolicyPatch,
  MAX_ARTIFACTS_PER_INSTANCE,
  MIN_ARTIFACTS_PER_INSTANCE,
  nodeSupportsArtifactPolicy,
} from './artifactPolicy.ts';

export default function ArtifactPolicyPanel({
  node,
  onRestartRequired,
}: {
  node: NodeRecord;
  onRestartRequired: () => void;
}) {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [configuration, setConfiguration] = useState(() => artifactPolicyFromConfiguration(node.configuration));
  const [saving, setSaving] = useState(false);
  const supported = nodeSupportsArtifactPolicy(node);
  const validationError = artifactPolicyError(configuration);

  useEffect(() => {
    setConfiguration(artifactPolicyFromConfiguration(node.configuration));
  }, [node.configuration, node.uuid]);

  if (!supported) return null;

  const save = async () => {
    if (saving || validationError) return;
    setSaving(true);
    try {
      const result = await patchRemoteConfiguration(node.uuid, artifactPolicyPatch(configuration));
      if (result.restart_required) onRestartRequired();
      await queryClient.invalidateQueries({ queryKey: dbevQueryKeys.adminNodes() });
      addToast(t('admin.nodeConfig.artifactPolicySaved', {}), 'success');
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <Title order={4}>{t('admin.nodeConfig.artifactPolicyTitle', {})}</Title>
      <Text size='xs' c='dimmed' mb='md'>
        {t('admin.nodeConfig.artifactPolicyDescription', {})}
      </Text>
      <Stack gap='md'>
        <Switch
          checked={configuration.stream_exports_only}
          onChange={(event) =>
            setConfiguration((current) => ({ ...current, stream_exports_only: event.currentTarget.checked }))
          }
          label={t('admin.nodeConfig.streamExportsOnly', {})}
          description={t('admin.nodeConfig.streamExportsOnlyDescription', {})}
        />
        <NumberInput
          label={t('admin.nodeConfig.maxArtifactsPerInstance', {})}
          description={t('admin.nodeConfig.maxArtifactsPerInstanceDescription', {})}
          min={MIN_ARTIFACTS_PER_INSTANCE}
          max={MAX_ARTIFACTS_PER_INSTANCE}
          value={configuration.max_artifacts_per_instance}
          error={validationError ?? undefined}
          onChange={(value) =>
            setConfiguration((current) => ({
              ...current,
              max_artifacts_per_instance: typeof value === 'number' ? value : Number(value),
            }))
          }
        />
        {configuration.stream_exports_only && (
          <Alert color='yellow' title={t('admin.nodeConfig.streamExportsOnlyWarningTitle', {})}>
            {t('admin.nodeConfig.streamExportsOnlyWarning', {})}
          </Alert>
        )}
        <Alert color='yellow'>{t('admin.restartRequiredDescription', {})}</Alert>
        <Group justify='flex-end'>
          <Button loading={saving} disabled={Boolean(validationError)} onClick={() => void save()}>
            {t('common.save', {})}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}
