import { SimpleGrid, Stack } from '@mantine/core';
import NumberInput from '@/elements/input/NumberInput.tsx';
import PasswordInput from '@/elements/input/PasswordInput.tsx';
import Switch from '@/elements/input/Switch.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import type { DatabaseProtocol } from '../../api/types.ts';
import type { RemoteValues } from './transferUtils.ts';

export default function RemoteSourceFields({
  protocol,
  value,
  onChange,
  allowPlaintext,
}: {
  protocol: DatabaseProtocol;
  value: RemoteValues;
  onChange: (value: RemoteValues) => void;
  allowPlaintext: boolean;
}) {
  const set = <K extends keyof RemoteValues>(key: K, next: RemoteValues[K]) => onChange({ ...value, [key]: next });
  const sql = ['postgres', 'mysql', 'mariadb', 'clickhouse'].includes(protocol);

  return (
    <Stack gap='sm'>
      <SimpleGrid cols={{ base: 1, md: 3 }}>
        <TextInput
          label='Source host'
          description='Hostname or IP address only.'
          value={value.host}
          onChange={(event) => set('host', event.currentTarget.value)}
          required
        />
        <NumberInput
          label='Source port'
          value={value.port}
          onChange={(next) => set('port', next)}
          min={1}
          max={65535}
          required
        />
        <Switch
          mt='xl'
          label='Verify TLS connection'
          description={
            allowPlaintext
              ? 'Disable only for a trusted source network. Credentials and data will be sent without TLS.'
              : 'Required by this database host. An administrator must explicitly allow plaintext remote imports.'
          }
          checked={value.tls}
          disabled={!allowPlaintext}
          onChange={(event) => set('tls', event.currentTarget.checked)}
        />
      </SimpleGrid>
      {(sql || protocol === 'mongodb') && (
        <SimpleGrid cols={{ base: 1, md: 3 }}>
          <TextInput
            label='Source database'
            value={value.database}
            onChange={(event) => set('database', event.currentTarget.value)}
            required
          />
          <TextInput
            label='Source username'
            value={value.username}
            onChange={(event) => set('username', event.currentTarget.value)}
            required={sql}
          />
          <PasswordInput
            label='Source password'
            value={value.password}
            onChange={(event) => set('password', event.currentTarget.value)}
            required={sql}
          />
        </SimpleGrid>
      )}
      {protocol === 'mongodb' && (
        <TextInput
          label='Authentication database (optional)'
          value={value.authenticationDatabase}
          onChange={(event) => set('authenticationDatabase', event.currentTarget.value)}
        />
      )}
      {['redis', 'valkey'].includes(protocol) && (
        <SimpleGrid cols={{ base: 1, md: 3 }}>
          <NumberInput
            label='Logical database index'
            value={value.databaseIndex}
            onChange={(next) => set('databaseIndex', next)}
            min={0}
          />
          <TextInput
            label='ACL username (optional)'
            value={value.username}
            onChange={(event) => set('username', event.currentTarget.value)}
          />
          <PasswordInput
            label='Source password (optional)'
            value={value.password}
            onChange={(event) => set('password', event.currentTarget.value)}
          />
        </SimpleGrid>
      )}
      {protocol === 'qdrant' && (
        <PasswordInput
          label='Source API key (optional)'
          value={value.apiKey}
          onChange={(event) => set('apiKey', event.currentTarget.value)}
        />
      )}
    </Stack>
  );
}
