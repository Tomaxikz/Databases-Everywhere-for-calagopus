import { Text } from '@mantine/core';
import type { UseFormReturnType } from '@mantine/form';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Divider from '@/elements/Divider.tsx';
import { insertFieldsAfter } from '@/elements/form-engine/index.ts';
import type { FieldDef } from '@/elements/form-engine/types.ts';
import NumberInput from '@/elements/input/NumberInput.tsx';
import { getPanelNodeHostAvailability } from '../api/client.ts';
import { dbevQueryKeys } from '../api/queryKeys.ts';
import translations from '../translations.ts';

type FormValues = Record<string, unknown>;
type Mode = 'create' | 'update';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function initialFlag(form: UseFormReturnType<FormValues>, key: string) {
  return record(form.getValues().featureLimits)[key] === true;
}

function ServerDatabaseLimits({ form, mode }: { form: UseFormReturnType<FormValues>; mode: Mode }) {
  const { t } = translations.useTranslations();
  const [nodeUuid, setNodeUuid] = useState(() => {
    const value = form.getValues().nodeUuid;
    return typeof value === 'string' ? value : '';
  });
  const [available, setAvailable] = useState(() => initialFlag(form, 'databasesEverywhereAvailable'));
  const [inUse, setInUse] = useState(() => initialFlag(form, 'databasesEverywhereInUse'));

  form.watch('nodeUuid', ({ value }) => {
    const next = typeof value === 'string' ? value : '';
    setNodeUuid(next);
    if (mode === 'create') setAvailable(false);
  });
  form.watch('featureLimits.databasesEverywhereAvailable', ({ value }) => setAvailable(value === true));
  form.watch('featureLimits.databasesEverywhereInUse', ({ value }) => setInUse(value === true));

  const validNodeUuid = z.uuid().safeParse(nodeUuid).success;
  const eligibility = useQuery({
    queryKey: dbevQueryKeys.panelNodeAvailability(nodeUuid),
    queryFn: () => getPanelNodeHostAvailability(nodeUuid),
    enabled: mode === 'create' && validNodeUuid,
  });

  useEffect(() => {
    if (mode !== 'create' || !eligibility.data) return;
    setAvailable(eligibility.data.available);
    if (initialFlag(form, 'databasesEverywhereAvailable') !== eligibility.data.available) {
      form.setFieldValue('featureLimits.databasesEverywhereAvailable', eligibility.data.available);
    }
    if (!eligibility.data.available) {
      const limits = record(form.getValues().featureLimits);
      for (const key of ['databaseCpuCores', 'databaseMemoryMib', 'databaseDiskMib', 'databaseBackups']) {
        if (limits[key] !== 0) form.setFieldValue(`featureLimits.${key}`, 0);
      }
    }
  }, [eligibility.data?.available, mode]);

  if (mode === 'create' && validNodeUuid && eligibility.error) {
    return <Alert color='red'>{httpErrorToHuman(eligibility.error)}</Alert>;
  }

  const visible =
    mode === 'create'
      ? eligibility.data?.available === true
      : available ||
        inUse ||
        initialFlag(form, 'databasesEverywhereAvailable') ||
        initialFlag(form, 'databasesEverywhereInUse');
  if (!visible) return null;

  const numberField = (name: string) => ({
    key: form.key(name),
    ...form.getInputProps(name),
  });

  return (
    <div>
      <Divider label={t('forms.section', {})} labelPosition='left' />
      <Text size='xs' c='dimmed' mt='xs'>
        {t('forms.sectionDescription', {})}
      </Text>
      <div className='grid grid-cols-1 md:grid-cols-2 gap-4 mt-4'>
        <NumberInput
          label={t('forms.cpu', {})}
          description={t('forms.inheritDescription', {})}
          min={0}
          max={1024}
          decimalScale={2}
          step={0.25}
          {...numberField('featureLimits.databaseCpuCores')}
        />
        <NumberInput
          label={t('forms.memory', {})}
          description={t('forms.inheritDescription', {})}
          min={0}
          max={1_048_576}
          step={128}
          {...numberField('featureLimits.databaseMemoryMib')}
        />
        <NumberInput
          label={t('forms.disk', {})}
          description={t('forms.inheritDescription', {})}
          min={0}
          step={256}
          {...numberField('featureLimits.databaseDiskMib')}
        />
        <NumberInput
          label={t('forms.backups', {})}
          description={t('forms.backupsDescription', {})}
          min={0}
          step={1}
          {...numberField('featureLimits.databaseBackups')}
        />
      </div>
    </div>
  );
}

const slot = (mode: Mode) => ({
  zodShape: {
    featureLimits: z.looseObject({
      databasesEverywhereAvailable: z.boolean(),
      databasesEverywhereInUse: z.boolean(),
      databaseCpuCores: z.number().min(0).max(1024),
      databaseMemoryMib: z.number().int().min(0).max(1_048_576),
      databaseDiskMib: z.number().int().min(0),
      databaseBackups: z.number().int().min(0),
    }),
  },
  initialValues: {
    featureLimits: {
      databasesEverywhereAvailable: false,
      databasesEverywhereInUse: false,
      databaseCpuCores: 0,
      databaseMemoryMib: 0,
      databaseDiskMib: 0,
      databaseBackups: 0,
    },
  },
  transform: (current: FieldDef<FormValues>[]) =>
    insertFieldsAfter(current, 'featureLimits.databases', {
      type: 'custom',
      name: 'featureLimits.databasesEverywhereSection',
      colSpan: 'full',
      render: (form) => <ServerDatabaseLimits form={form} mode={mode} />,
    }),
});

export const createServerLimitsFormSlot = slot('create');
export const updateServerLimitsFormSlot = slot('update');
