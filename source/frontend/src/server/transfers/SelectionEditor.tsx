import { Group, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Button from '@/elements/Button.tsx';
import MultiSelect from '@/elements/input/MultiSelect.tsx';
import TagsInput from '@/elements/input/TagsInput.tsx';
import Spinner from '@/elements/Spinner.tsx';
import { getExplorer } from '../../api/client.ts';
import type { DatabaseProtocol } from '../../api/types.ts';

export default function SelectionEditor({
  server,
  database,
  protocol,
  operation,
  discover,
  include,
  exclude,
  onInclude,
  onExclude,
}: {
  server: string;
  database: string;
  protocol: DatabaseProtocol;
  operation: 'export' | 'import';
  discover: boolean;
  include: string[];
  exclude: string[];
  onInclude: (value: string[]) => void;
  onExclude: (value: string[]) => void;
}) {
  const explorer = useQuery({
    queryKey: ['dbev', server, database, 'transfer-objects'],
    queryFn: () => getExplorer(server, database),
    enabled: discover,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const options = [...new Set((explorer.data?.objects ?? []).map((object) => object.name))]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ value: name, label: name }));
  const objectLabel = protocol === 'mongodb' || protocol === 'qdrant' ? 'collections' : 'tables';
  const mongoSingle = protocol === 'mongodb' && operation === 'export';
  const setInclude = (next: string[]) => onInclude(mongoSingle && next.length > 1 ? next.slice(-1) : next);

  return (
    <Stack gap='sm' mt='md'>
      <Group justify='space-between' align='flex-start'>
        <div>
          <Text fw={600}>Choose {objectLabel}</Text>
          <Text size='sm' c='dimmed'>
            {mongoSingle
              ? 'MongoDB selective exports currently accept one collection.'
              : `Only the selected ${objectLabel} are included. Exclusions are optional.`}
          </Text>
        </div>
        {options.length > 0 && !mongoSingle && (
          <Group gap='xs'>
            <Button size='compact-xs' variant='default' onClick={() => setInclude(options.map((item) => item.value))}>
              Select all
            </Button>
            <Button size='compact-xs' variant='subtle' onClick={() => onInclude([])}>
              Clear
            </Button>
          </Group>
        )}
      </Group>

      {discover && explorer.isPending ? (
        <Spinner.Centered />
      ) : options.length ? (
        <>
          <MultiSelect
            searchable
            clearable
            label={`Included ${objectLabel}`}
            data={options}
            value={include}
            maxValues={mongoSingle ? 1 : undefined}
            onChange={setInclude}
            required
          />
          <MultiSelect
            searchable
            clearable
            label={`Excluded ${objectLabel} (optional)`}
            data={options.filter((option) => !include.includes(option.value))}
            value={exclude}
            onChange={onExclude}
          />
        </>
      ) : (
        <>
          {discover && explorer.error && (
            <Alert color='yellow'>The live object list is unavailable: {httpErrorToHuman(explorer.error)}</Alert>
          )}
          <TagsInput
            label={`Included ${objectLabel}`}
            description={`Enter each source ${objectLabel.slice(0, -1)} separately.`}
            value={include}
            onChange={setInclude}
            allowReordering={false}
          />
          <TagsInput
            label={`Excluded ${objectLabel} (optional)`}
            value={exclude}
            onChange={onExclude}
            allowReordering={false}
          />
        </>
      )}

      {protocol === 'clickhouse' && (
        <Text size='xs' c='dimmed'>
          This editor exports whole selected ClickHouse tables; field projection remains optional in the DBEV API.
        </Text>
      )}
    </Stack>
  );
}
