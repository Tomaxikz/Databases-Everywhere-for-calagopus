import type { UseFormReturnType } from '@mantine/form';
import { useState } from 'react';
import Alert from '@/elements/Alert.tsx';
import Button from '@/elements/Button.tsx';
import Card from '@/elements/Card.tsx';
import Code from '@/elements/Code.tsx';
import Group from '@/elements/Group.tsx';
import MultiSelect from '@/elements/input/MultiSelect.tsx';
import NumberInput from '@/elements/input/NumberInput.tsx';
import Select from '@/elements/input/Select.tsx';
import Switch from '@/elements/input/Switch.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import Stack from '@/elements/Stack.tsx';
import Text from '@/elements/Text.tsx';
import ProtocolIcon from '../components/ProtocolIcon.tsx';
import translations from '../translations.ts';
import { type NodeFormValues, type ProtocolKey, protocols } from './nodeForm.ts';

type BindMode = 'public' | 'loopback' | 'custom';
type TlsPreset = 'off' | 'on' | 'custom';
type PortPreset = 'recommended' | 'custom';

const CLICKHOUSE_HTTP_PORT = 20_026;
const GATEWAY_ROW_CLASS =
  'grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 md:items-center xl:grid-cols-[minmax(13rem,1.2fr)_minmax(10rem,0.8fr)_minmax(11rem,0.8fr)_minmax(14rem,1fr)]';

function protocolLabel(protocol: ProtocolKey) {
  return protocols.find(([key]) => key === protocol)?.[1] ?? protocol;
}

function selectedProtocols(values: NodeFormValues): ProtocolKey[] {
  return protocols.flatMap(([protocol]) => (values.config.protocols[protocol].enabled ? [protocol] : []));
}

function sharedBindHost(values: NodeFormValues, selected: ProtocolKey[]) {
  const relevant = selected.length > 0 ? selected : protocols.map(([protocol]) => protocol);
  const hosts = new Set(relevant.map((protocol) => values.config.protocols[protocol].bindHost));
  if (selected.includes('clickhouse')) hosts.add(values.config.protocols.clickhouse.httpBindHost);
  return hosts.size === 1 ? Array.from(hosts)[0] : null;
}

function bindMode(host: string | null): BindMode {
  if (host === '0.0.0.0') return 'public';
  if (host === '127.0.0.1') return 'loopback';
  return 'custom';
}

function tlsPreset(values: NodeFormValues, selected: ProtocolKey[]): TlsPreset {
  if (selected.length === 0 || selected.every((protocol) => !values.config.protocols[protocol].tls)) return 'off';
  if (selected.every((protocol) => values.config.protocols[protocol].tls)) return 'on';
  return 'custom';
}

function portPreset(values: NodeFormValues): PortPreset {
  const recommended = protocols.every(([protocol, , port]) => values.config.protocols[protocol].port === port);
  return recommended && values.config.protocols.clickhouse.httpPort === CLICKHOUSE_HTTP_PORT ? 'recommended' : 'custom';
}

function setAllBindHosts(form: UseFormReturnType<NodeFormValues>, host: string) {
  for (const [protocol] of protocols) {
    form.setFieldValue(`config.protocols.${protocol}.bindHost`, host);
  }
  form.setFieldValue('config.protocols.clickhouse.httpBindHost', host);
}

export default function GatewaySetup({ form }: { form: UseFormReturnType<NodeFormValues> }) {
  const { t } = translations.useTranslations();
  const [selectedPortPreset, setSelectedPortPreset] = useState<PortPreset>(() => portPreset(form.values));
  const selected = selectedProtocols(form.values);
  const commonBindHost = sharedBindHost(form.values, selected);
  const currentBindMode = bindMode(commonBindHost);
  const currentTlsPreset = tlsPreset(form.values, selected);
  const publicHost = form.values.publicHost.trim() || t('admin.nodeConfig.gatewayExampleHost', {});
  const clickhouseHttpPortInput = form.getInputProps('config.protocols.clickhouse.httpPort');
  const unencryptedPublicProtocols =
    currentBindMode === 'public' ? selected.filter((protocol) => !form.values.config.protocols[protocol].tls) : [];

  const setSelected = (next: string[]) => {
    for (const [protocol] of protocols) {
      form.setFieldValue(`config.protocols.${protocol}.enabled`, next.includes(protocol));
    }
  };

  const setBindMode = (next: string | null) => {
    if (next === 'public') setAllBindHosts(form, '0.0.0.0');
    if (next === 'loopback') setAllBindHosts(form, '127.0.0.1');
    if (next === 'custom' && currentBindMode !== 'custom') setAllBindHosts(form, '');
  };

  const setTlsPreset = (next: string | null) => {
    if (next !== 'on' && next !== 'off') return;
    for (const protocol of selected) {
      form.setFieldValue(`config.protocols.${protocol}.tls`, next === 'on');
    }
  };

  const resetPorts = () => {
    for (const [protocol, , port] of protocols) {
      form.setFieldValue(`config.protocols.${protocol}.port`, port);
    }
    form.setFieldValue('config.protocols.clickhouse.httpPort', CLICKHOUSE_HTTP_PORT);
    setSelectedPortPreset('recommended');
  };

  return (
    <Stack gap='md'>
      <Text size='sm' c='dimmed'>
        {t('admin.nodeConfig.gatewaySetupDescription', {})}
      </Text>

      <MultiSelect
        label={t('admin.nodeConfig.enabledDatabaseTypes', {})}
        description={t('admin.nodeConfig.enabledDatabaseTypesDescription', {})}
        data={protocols.map(([value, label]) => ({ value, label }))}
        value={selected}
        onChange={setSelected}
        searchable
        hidePickedOptions
        withAsterisk
      />

      <div className='grid grid-cols-1 gap-4 md:grid-cols-3 md:items-end'>
        <Select
          label={t('admin.nodeConfig.gatewayBindMode', {})}
          description={t('admin.nodeConfig.gatewayBindModeDescription', {})}
          data={[
            { value: 'public', label: t('admin.nodeConfig.gatewayBindPublic', {}) },
            { value: 'loopback', label: t('admin.nodeConfig.gatewayBindLoopback', {}) },
            { value: 'custom', label: t('admin.nodeConfig.gatewayBindCustom', {}) },
          ]}
          value={currentBindMode}
          onChange={setBindMode}
        />
        <Select
          label={t('admin.nodeConfig.gatewayTlsPreset', {})}
          description={t('admin.nodeConfig.gatewayTlsPresetDescription', {})}
          data={[
            { value: 'off', label: t('admin.nodeConfig.gatewayTlsOff', {}) },
            { value: 'on', label: t('admin.nodeConfig.gatewayTlsOn', {}) },
            { value: 'custom', label: t('admin.nodeConfig.gatewayTlsCustom', {}), disabled: true },
          ]}
          value={currentTlsPreset}
          onChange={setTlsPreset}
        />
        <Select
          label={t('admin.nodeConfig.gatewayPortPreset', {})}
          description={t('admin.nodeConfig.gatewayPortPresetDescription', {})}
          data={[
            { value: 'recommended', label: t('admin.nodeConfig.gatewayPortsRecommended', {}) },
            { value: 'custom', label: t('admin.nodeConfig.gatewayPortsCustom', {}) },
          ]}
          value={selectedPortPreset}
          onChange={(next) => {
            if (next === 'recommended') {
              resetPorts();
            } else if (next === 'custom') {
              setSelectedPortPreset('custom');
            }
          }}
        />
      </div>

      {currentBindMode === 'custom' && (
        <TextInput
          label={t('admin.nodeConfig.gatewayCustomBindHost', {})}
          description={
            commonBindHost === null
              ? t('admin.nodeConfig.gatewayMixedBindHosts', {})
              : t('admin.nodeConfig.gatewayCustomBindHostDescription', {})
          }
          value={commonBindHost ?? ''}
          placeholder={
            commonBindHost === null
              ? t('admin.nodeConfig.gatewayMixedBindPlaceholder', {})
              : t('admin.nodeConfig.gatewayCustomBindPlaceholder', {})
          }
          onChange={(event) => setAllBindHosts(form, event.currentTarget.value)}
        />
      )}

      {form.values.enabled && selected.length === 0 && (
        <Alert color='yellow'>{t('admin.nodeConfig.gatewayProtocolRequired', {})}</Alert>
      )}
      {form.values.enabled && unencryptedPublicProtocols.length > 0 && (
        <Alert color='yellow'>
          {t('admin.nodeConfig.gatewayPlaintextWarning', {
            protocols: unencryptedPublicProtocols.map(protocolLabel).join(', '),
          })}
        </Alert>
      )}

      <Stack gap='sm'>
        {selected.map((protocol) => {
          const protocolConfig = form.values.config.protocols[protocol];
          const portPath = `config.protocols.${protocol}.port`;
          const tlsPath = `config.protocols.${protocol}.tls`;
          const portInput = form.getInputProps(portPath);
          return (
            <Card key={protocol} p='md'>
              <div className={GATEWAY_ROW_CLASS}>
                <Group gap='sm' wrap='nowrap'>
                  <ProtocolIcon protocol={protocol} size={30} />
                  <div>
                    <Text fw={600}>{protocolLabel(protocol)}</Text>
                    <Text size='xs' c='dimmed'>
                      {protocol.toUpperCase()}
                    </Text>
                  </div>
                </Group>
                <NumberInput
                  label={t('admin.nodeConfig.gatewayPort', {})}
                  min={1}
                  max={65_535}
                  key={form.key(portPath)}
                  {...portInput}
                  onChange={(value) => {
                    portInput.onChange(value);
                    setSelectedPortPreset('custom');
                  }}
                />
                <div className='flex flex-col justify-center'>
                  <Text size='sm' fw={500} mb={6}>
                    {t('admin.nodeConfig.protocolTls', {})}
                  </Text>
                  <Switch
                    aria-label={t('admin.nodeConfig.protocolTls', {})}
                    key={form.key(tlsPath)}
                    {...form.getInputProps(tlsPath, { type: 'checkbox' })}
                  />
                </div>
                <div className='min-w-0'>
                  <Text size='sm' fw={500} mb={5}>
                    {t('admin.nodeConfig.shownEndpoint', {})}
                  </Text>
                  <Code className='break-all'>{`${publicHost}:${protocolConfig.port}`}</Code>
                </div>
              </div>

              {protocol === 'clickhouse' && (
                <div className={`${GATEWAY_ROW_CLASS} border-t border-(--mantine-color-default-border) mt-4 pt-4`}>
                  <Text size='sm' fw={500}>
                    {t('admin.nodeConfig.clickhouseHttpGateway', {})}
                  </Text>
                  <NumberInput
                    label={t('admin.nodeConfig.clickhouseHttpPort', {})}
                    min={1}
                    max={65_535}
                    key={form.key('config.protocols.clickhouse.httpPort')}
                    {...clickhouseHttpPortInput}
                    onChange={(value) => {
                      clickhouseHttpPortInput.onChange(value);
                      setSelectedPortPreset('custom');
                    }}
                  />
                  <div className='hidden xl:block' aria-hidden='true' />
                  <div className='min-w-0 md:col-span-2 xl:col-span-1'>
                    <Text size='sm' fw={500} mb={5}>
                      {t('admin.nodeConfig.shownEndpoint', {})}
                    </Text>
                    <Code className='break-all'>{`${publicHost}:${form.values.config.protocols.clickhouse.httpPort}`}</Code>
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </Stack>

      {selectedPortPreset === 'custom' && (
        <Group justify='flex-end'>
          <Button type='button' variant='default' size='xs' onClick={resetPorts}>
            {t('admin.nodeConfig.resetGatewayPorts', {})}
          </Button>
        </Group>
      )}
    </Stack>
  );
}
