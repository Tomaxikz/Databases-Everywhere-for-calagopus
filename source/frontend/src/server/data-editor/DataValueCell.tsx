import { faCheck, faCopy } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Badge, Box, CopyButton, Group, Text, Tooltip } from '@mantine/core';
import ActionIcon from '@/elements/ActionIcon.tsx';
import translations from '../../translations.ts';
import describeDataValue, { type DataValueDescription } from './dataValue.ts';

export default function DataValueCell({ value }: { value: unknown }) {
  const { t, tItem } = translations.useTranslations();
  const description = describeDataValue(value);

  if (description.kind === 'object-id') {
    return (
      <Group gap='xs' wrap='nowrap' miw={0}>
        <Badge size='xs' variant='light' color='violet' className='shrink-0'>
          {t('server.dataEditor.valueDisplay.objectId', {})}
        </Badge>
        <Text size='sm' ff='monospace' truncate title={description.text}>
          {description.text}
        </Text>
        <CopyButton value={description.text} timeout={1500}>
          {({ copied, copy }) => (
            <Tooltip
              label={
                copied
                  ? t('server.dataEditor.valueDisplay.copied', {})
                  : t('server.dataEditor.valueDisplay.copyValue', {})
              }
              withArrow
            >
              <ActionIcon
                type='button'
                size='sm'
                variant='subtle'
                color={copied ? 'green' : 'gray'}
                aria-label={
                  copied
                    ? t('server.dataEditor.valueDisplay.copied', {})
                    : t('server.dataEditor.valueDisplay.copyValue', {})
                }
                onClick={(event) => {
                  event.stopPropagation();
                  copy();
                }}
              >
                <FontAwesomeIcon icon={copied ? faCheck : faCopy} />
              </ActionIcon>
            </Tooltip>
          )}
        </CopyButton>
      </Group>
    );
  }

  const content = (() => {
    switch (description.kind) {
      case 'missing':
        return (
          <Text size='sm' c='dimmed'>
            {t('server.dataEditor.valueDisplay.notSet', {})}
          </Text>
        );
      case 'null':
        return (
          <Badge size='xs' variant='light' color='gray'>
            {t('server.dataEditor.valueDisplay.null', {})}
          </Badge>
        );
      case 'boolean':
        return (
          <Badge size='xs' variant='light' color={description.text === 'true' ? 'green' : 'gray'}>
            {description.text === 'true'
              ? t('server.dataEditor.valueDisplay.true', {})
              : t('server.dataEditor.valueDisplay.false', {})}
          </Badge>
        );
      case 'date':
        return (
          <Group gap='xs' wrap='nowrap' miw={0}>
            <Badge size='xs' variant='light' color='blue' className='shrink-0'>
              {t('server.dataEditor.valueDisplay.date', {})}
            </Badge>
            <Text size='sm' truncate>
              {formatDate(description.text)}
            </Text>
          </Group>
        );
      case 'array':
        return (
          <CollectionValue
            description={description}
            label={
              description.count
                ? tItem('dataValueItem', description.count)
                : t('server.dataEditor.valueDisplay.emptyList', {})
            }
            color='cyan'
          />
        );
      case 'object':
        return (
          <CollectionValue
            description={description}
            label={
              description.count
                ? tItem('dataValueField', description.count)
                : t('server.dataEditor.valueDisplay.emptyObject', {})
            }
            color='grape'
          />
        );
      case 'number':
        return (
          <Text size='sm' ff='monospace' truncate>
            {description.text}
          </Text>
        );
      case 'string':
        return description.text ? (
          <Text size='sm' truncate>
            {description.text}
          </Text>
        ) : (
          <Text size='sm' c='dimmed' fs='italic'>
            {t('server.dataEditor.valueDisplay.emptyText', {})}
          </Text>
        );
    }
  })();

  const needsTooltip = description.title.length > 48 || description.kind === 'array' || description.kind === 'object';

  return (
    <Tooltip
      label={
        <Text size='xs' ff='monospace' style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {description.title}
        </Text>
      }
      disabled={!needsTooltip}
      multiline
      maw={520}
      openDelay={400}
      withinPortal
      withArrow
    >
      <Box miw={0} maw={420}>
        {content}
      </Box>
    </Tooltip>
  );
}

function CollectionValue({
  description,
  label,
  color,
}: {
  description: DataValueDescription;
  label: string;
  color: string;
}) {
  return (
    <Group gap='xs' wrap='nowrap' miw={0}>
      <Badge size='xs' variant='light' color={color} className='shrink-0'>
        {label}
      </Badge>
      {description.text && (
        <Text size='xs' c='dimmed' ff='monospace' truncate>
          {description.text}
        </Text>
      )}
    </Group>
  );
}

function formatDate(value: string): string {
  const numeric = /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  const date = new Date(Number.isFinite(numeric) ? numeric : value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
