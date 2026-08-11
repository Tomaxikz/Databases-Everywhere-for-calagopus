import { Group, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Button from '@/elements/Button.tsx';
import { AdminCan } from '@/elements/Can.tsx';
import Card from '@/elements/Card.tsx';
import NumberInput from '@/elements/input/NumberInput.tsx';
import Switch from '@/elements/input/Switch.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import Spinner from '@/elements/Spinner.tsx';
import { useAdminCan } from '@/plugins/usePermissions.ts';
import { useToast } from '@/providers/ToastProvider.tsx';
import { getExtensionSettings, updateExtensionSettings } from '../api/client.ts';
import type { ExtensionSettings } from '../api/types.ts';
import { StatusBadge } from '../components/common.tsx';
import translations from '../translations.ts';

const settingsKey = ['dbev', 'admin', 'settings'] as const;

export function SettingsCard() {
  const { t } = translations.useTranslations();
  const query = useQuery({ queryKey: settingsKey, queryFn: getExtensionSettings, staleTime: 30_000 });

  return (
    <Stack gap='xs'>
      <Group justify='space-between'>
        <Text size='sm' c='dimmed'>
          {t('settings.cardSummary', {})}
        </Text>
        {!query.isPending && !query.error && <StatusBadge status={query.data?.enabled ? 'enabled' : 'paused'} />}
      </Group>
      {query.error && (
        <Text size='xs' c='red'>
          {httpErrorToHuman(query.error)}
        </Text>
      )}
    </Stack>
  );
}

export default function SettingsPage() {
  const { t } = translations.useTranslations();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: settingsKey, queryFn: getExtensionSettings });
  const [form, setForm] = useState<ExtensionSettings | null>(null);
  const canManage = useAdminCan('extensions.manage');

  useEffect(() => {
    if (query.data) setForm(query.data);
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: updateExtensionSettings,
    onSuccess: (settings) => {
      setForm(settings);
      queryClient.setQueryData(settingsKey, settings);
      addToast(t('settings.saved', {}), 'success');
    },
    onError: (error) => addToast(httpErrorToHuman(error), 'error'),
  });

  if (query.isPending || !form) return <Spinner.Centered />;
  if (query.error) return <Alert color='red'>{httpErrorToHuman(query.error)}</Alert>;

  const set = <K extends keyof ExtensionSettings>(key: K, value: ExtensionSettings[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  return (
    <Stack>
      <div>
        <Title order={3}>{t('settings.title', {})}</Title>
        <Text c='dimmed' size='sm'>
          {t('settings.subtitle', {})}
        </Text>
      </div>

      <Card>
        <Group justify='space-between' align='flex-start' wrap='nowrap'>
          <Switch
            disabled={!canManage}
            checked={form.enabled}
            onChange={(event) => set('enabled', event.currentTarget.checked)}
            label={t('settings.enabled', {})}
            description={t('settings.enabledDescription', {})}
          />
          <StatusBadge status={form.enabled ? 'enabled' : 'paused'} />
        </Group>
      </Card>

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card>
          <Stack>
            <Title order={4}>Daemon callbacks</Title>
            <TextInput
              disabled={!canManage}
              label={t('settings.panelUrl', {})}
              description={t('settings.panelUrlDescription', {})}
              placeholder='https://panel.example.com'
              value={form.panel_url}
              onChange={(event) => set('panel_url', event.currentTarget.value)}
            />
            <NumberInput
              disabled={!canManage}
              label={t('settings.healthInterval', {})}
              description={t('settings.healthIntervalDescription', {})}
              min={60}
              max={3600}
              value={form.node_health_interval_seconds}
              onChange={(value) => set('node_health_interval_seconds', Number(value) || 300)}
            />
          </Stack>
        </Card>

        <Card>
          <Stack>
            <Title order={4}>{t('settings.console', {})}</Title>
            <Switch
              disabled={!canManage}
              checked={form.raw_console_enabled}
              onChange={(event) => set('raw_console_enabled', event.currentTarget.checked)}
              label={t('settings.rawConsole', {})}
            />
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <NumberInput
                disabled={!canManage}
                label={t('settings.queryTimeout', {})}
                min={1}
                max={300}
                value={form.query_timeout_seconds}
                onChange={(value) => set('query_timeout_seconds', Number(value) || 1)}
              />
              <NumberInput
                disabled={!canManage}
                label={t('settings.maxRows', {})}
                min={1}
                max={5000}
                value={form.max_console_rows}
                onChange={(value) => set('max_console_rows', Number(value) || 1)}
              />
            </SimpleGrid>
          </Stack>
        </Card>
      </SimpleGrid>

      <Group justify='flex-end'>
        <AdminCan action='extensions.manage' cantSave>
          <Button loading={mutation.isPending} onClick={() => mutation.mutate(form)}>
            {t('common.save', {})}
          </Button>
        </AdminCan>
      </Group>
    </Stack>
  );
}
