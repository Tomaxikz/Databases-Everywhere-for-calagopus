import { faChevronRight, faPlus, faRotate, faSearch, faTable } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Group, Stack, Text, Title } from '@mantine/core';
import ActionIcon from '@/elements/ActionIcon.tsx';
import Alert from '@/elements/Alert.tsx';
import Badge from '@/elements/Badge.tsx';
import Button from '@/elements/Button.tsx';
import { ServerCan } from '@/elements/Can.tsx';
import Card from '@/elements/Card.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import ScrollArea from '@/elements/ScrollArea.tsx';
import Spinner from '@/elements/Spinner.tsx';
import { NoItems } from '@/elements/Table.tsx';
import UnstyledButton from '@/elements/UnstyledButton.tsx';
import type { DatabaseProtocol, DataObject } from '../../api/types.ts';
import translations from '../../translations.ts';

export function dataObjectKey(object: DataObject): string {
  return `${object.namespace ?? ''}\u0000${object.name}`;
}

interface Props {
  objects: DataObject[];
  filteredTotal: number;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  selectedKey: string | null;
  search: string;
  mode: 'table' | 'collection' | 'key';
  protocol: DatabaseProtocol;
  supportsCreation: boolean;
  readOnly?: boolean;
  onSearch: (value: string) => void;
  onSelect: (object: DataObject) => void;
  onCreate: () => void;
  onRefresh: () => void;
}

export default function ObjectSidebar({
  objects,
  filteredTotal,
  loading,
  refreshing,
  error,
  selectedKey,
  search,
  mode,
  protocol,
  supportsCreation,
  readOnly = false,
  onSearch,
  onSelect,
  onCreate,
  onRefresh,
}: Props) {
  const { t } = translations.useTranslations();
  const title =
    mode === 'collection'
      ? t('server.dataEditor.collections', {})
      : mode === 'key'
        ? t('server.dataEditor.keys', {})
        : t('server.dataEditor.tables', {});
  const description =
    mode === 'collection'
      ? protocol === 'qdrant'
        ? t('server.dataEditor.qdrantCollectionsDescription', {})
        : t('server.dataEditor.collectionsDescription', {})
      : mode === 'key'
        ? t('server.dataEditor.keysDescription', {})
        : t('server.dataEditor.tablesDescription', {});
  const searchPlaceholder =
    mode === 'collection'
      ? t('server.dataEditor.searchCollections', {})
      : mode === 'key'
        ? t('server.dataEditor.searchKeys', {})
        : t('server.dataEditor.searchTables', {});

  return (
    <Card
      p={0}
      h={{ base: 440, lg: 'clamp(560px, calc(100dvh - 220px), 900px)' }}
      className='flex flex-col overflow-hidden'
    >
      <Stack gap='sm' className='border-b border-(--mantine-color-default-border) px-4 py-3'>
        <Group justify='space-between' align='flex-start' wrap='nowrap'>
          <div className='min-w-0'>
            <Group gap='xs' wrap='nowrap'>
              <Title order={4}>{title}</Title>
              <Badge color='gray'>{filteredTotal}</Badge>
            </Group>
            <Text size='xs' c='dimmed' lineClamp={2}>
              {description}
            </Text>
          </div>
          <Group gap={6} wrap='nowrap'>
            <ActionIcon
              variant='default'
              size='input-sm'
              loading={refreshing}
              onClick={onRefresh}
              aria-label={t('common.refresh', {})}
            >
              <FontAwesomeIcon icon={faRotate} />
            </ActionIcon>
            {supportsCreation && !readOnly && (
              <ServerCan action='databases-everywhere.data-write'>
                <Button size='sm' onClick={onCreate} leftSection={<FontAwesomeIcon icon={faPlus} />}>
                  {mode === 'collection'
                    ? t('server.dataEditor.newCollection', {})
                    : t('server.dataEditor.newTable', {})}
                </Button>
              </ServerCan>
            )}
          </Group>
        </Group>
        <TextInput
          value={search}
          onChange={(event) => onSearch(event.currentTarget.value)}
          placeholder={searchPlaceholder}
          leftSection={<FontAwesomeIcon icon={faSearch} />}
          w='100%'
        />
      </Stack>

      <ScrollArea className='min-h-0 flex-1' type='auto' offsetScrollbars>
        {error ? (
          <Alert color='red' m='sm'>
            {error}
          </Alert>
        ) : loading ? (
          <Spinner.Centered />
        ) : objects.length === 0 ? (
          <NoItems />
        ) : (
          <Stack gap={0}>
            {objects.map((object) => {
              const key = dataObjectKey(object);
              const selected = key === selectedKey;
              return (
                <UnstyledButton
                  key={key}
                  w='100%'
                  px='md'
                  py='sm'
                  aria-pressed={selected}
                  bg={selected ? 'var(--mantine-primary-color-light)' : undefined}
                  className='border-b border-(--mantine-color-default-border) transition-colors hover:bg-(--mantine-color-default-hover)'
                  style={{
                    borderLeft: selected ? '3px solid var(--mantine-primary-color-filled)' : '3px solid transparent',
                  }}
                  onClick={() => onSelect(object)}
                >
                  <Group gap='sm' wrap='nowrap'>
                    <FontAwesomeIcon
                      icon={faTable}
                      className={selected ? 'text-(--mantine-primary-color-filled)' : 'text-(--mantine-color-dimmed)'}
                    />
                    <div className='min-w-0 flex-1'>
                      <Text fw={600} size='sm' truncate>
                        {object.name}
                      </Text>
                      <Text size='xs' c='dimmed' truncate>
                        {object.namespace || t('server.dataEditor.noValue', {})} · {object.kind}
                      </Text>
                    </div>
                    <FontAwesomeIcon
                      icon={faChevronRight}
                      className={selected ? 'text-(--mantine-primary-color-filled)' : 'text-(--mantine-color-dimmed)'}
                    />
                  </Group>
                </UnstyledButton>
              );
            })}
          </Stack>
        )}
      </ScrollArea>
    </Card>
  );
}
