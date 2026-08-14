import { faPlus, faTrash } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { Box, Group, ScrollArea, Stack, Text } from '@mantine/core';
import ActionIcon from '@/elements/ActionIcon.tsx';
import Button from '@/elements/Button.tsx';
import Card from '@/elements/Card.tsx';
import Select from '@/elements/input/Select.tsx';
import TextArea from '@/elements/input/TextArea.tsx';
import TextInput from '@/elements/input/TextInput.tsx';
import translations from '../../translations.ts';
import {
  countVisualValueNodes,
  createVisualValueChild,
  removeVisualValueNode,
  updateVisualValueNode,
  type VisualValueKind,
  type VisualValueNode,
  withVisualValueKind,
} from '../data-editor/valueBuilder.ts';

const MAX_DEPTH = 12;
const MAX_NODES = 4096;

export default function VisualObjectBuilder({
  root,
  onChange,
}: {
  root: VisualValueNode;
  onChange: (value: VisualValueNode) => void;
}) {
  const { t } = translations.useTranslations();
  const nodeCount = countVisualValueNodes(root);
  const canAddNode = nodeCount < MAX_NODES;

  const updateNode = (nodeId: string, update: (node: VisualValueNode) => VisualValueNode) => {
    onChange(updateVisualValueNode(root, nodeId, update));
  };

  const addChild = (parent: VisualValueNode) => {
    if (!canAddNode) return;
    updateNode(parent.id, (node) => ({ ...node, children: [...node.children, createVisualValueChild(node)] }));
  };

  return (
    <Stack gap='sm'>
      <Group justify='space-between' align='flex-start'>
        <Box>
          <Text fw={600}>{t('server.dataEditor.valueBuilder.title', {})}</Text>
          <Text size='xs' c='dimmed'>
            {t('server.dataEditor.valueBuilder.description', {})}
          </Text>
        </Box>
        <Button
          type='button'
          size='compact-sm'
          variant='default'
          disabled={!canAddNode}
          leftSection={<FontAwesomeIcon icon={faPlus} />}
          onClick={() => addChild(root)}
        >
          {t('server.dataEditor.valueBuilder.addField', {})}
        </Button>
      </Group>

      <Card p='sm'>
        <ScrollArea.Autosize mah='55vh' type='auto' offsetScrollbars>
          {root.children.length ? (
            <Stack gap='sm' pr='xs'>
              {root.children.map((node, index) => (
                <ValueNodeEditor
                  key={node.id}
                  node={node}
                  index={index}
                  depth={1}
                  parentKind='object'
                  parentLocked={false}
                  canAddNode={canAddNode}
                  onUpdate={updateNode}
                  onRemove={(nodeId) => onChange(removeVisualValueNode(root, nodeId))}
                  onAddChild={addChild}
                />
              ))}
            </Stack>
          ) : (
            <Stack align='center' gap='xs' py='xl'>
              <Text size='sm' c='dimmed'>
                {t('server.dataEditor.valueBuilder.emptyObject', {})}
              </Text>
              <Button
                type='button'
                size='compact-sm'
                variant='default'
                leftSection={<FontAwesomeIcon icon={faPlus} />}
                onClick={() => addChild(root)}
              >
                {t('server.dataEditor.valueBuilder.addFirstField', {})}
              </Button>
            </Stack>
          )}
        </ScrollArea.Autosize>
      </Card>

      {!canAddNode && (
        <Text size='xs' c='orange'>
          {t('server.dataEditor.valueBuilder.maximumValues', { count: MAX_NODES })}
        </Text>
      )}
    </Stack>
  );
}

function ValueNodeEditor({
  node,
  index,
  depth,
  parentKind,
  parentLocked,
  canAddNode,
  onUpdate,
  onRemove,
  onAddChild,
}: {
  node: VisualValueNode;
  index: number;
  depth: number;
  parentKind: 'object' | 'array';
  parentLocked: boolean;
  canAddNode: boolean;
  onUpdate: (nodeId: string, update: (node: VisualValueNode) => VisualValueNode) => void;
  onRemove: (nodeId: string) => void;
  onAddChild: (node: VisualValueNode) => void;
}) {
  const { t } = translations.useTranslations();
  const container = node.kind === 'object' || node.kind === 'array';
  const canNest = depth < MAX_DEPTH;
  const typeOptions: { value: VisualValueKind; label: string }[] = [
    { value: 'string', label: t('server.dataEditor.valueBuilder.types.string', {}) },
    { value: 'number', label: t('server.dataEditor.valueBuilder.types.number', {}) },
    { value: 'boolean', label: t('server.dataEditor.valueBuilder.types.boolean', {}) },
    { value: 'null', label: t('server.dataEditor.valueBuilder.types.null', {}) },
    { value: 'object', label: t('server.dataEditor.valueBuilder.types.object', {}) },
    { value: 'array', label: t('server.dataEditor.valueBuilder.types.array', {}) },
  ];

  return (
    <Card p='sm' radius='sm'>
      <Stack gap='sm'>
        <Group align='flex-end' wrap='wrap' gap='sm'>
          <Box style={{ flex: '1 1 180px' }}>
            {parentKind === 'object' ? (
              <TextInput
                label={t('server.dataEditor.valueBuilder.fieldName', {})}
                value={node.key}
                disabled={node.locked}
                onChange={(event) => {
                  const key = event.currentTarget.value;
                  onUpdate(node.id, (current) => ({ ...current, key }));
                }}
                required
              />
            ) : (
              <Stack gap={4}>
                <Text size='xs' fw={500}>
                  {t('server.dataEditor.valueBuilder.arrayItem', { number: index + 1 })}
                </Text>
                <Text size='sm' c='dimmed' py={7}>
                  #{index + 1}
                </Text>
              </Stack>
            )}
          </Box>

          <Select
            label={t('server.dataEditor.valueBuilder.valueType', {})}
            data={typeOptions}
            value={node.kind}
            disabled={node.locked}
            onChange={(kind) =>
              kind && onUpdate(node.id, (current) => withVisualValueKind(current, kind as VisualValueKind))
            }
            style={{ flex: '0 1 170px' }}
          />

          {!container && (
            <Box style={{ flex: '2 1 260px' }}>
              <ScalarValueInput node={node} onUpdate={onUpdate} />
            </Box>
          )}

          <ActionIcon
            type='button'
            variant='subtle'
            color='red'
            mb={4}
            disabled={node.locked}
            aria-label={
              parentKind === 'object'
                ? t('server.dataEditor.valueBuilder.removeField', { name: node.key || index + 1 })
                : t('server.dataEditor.valueBuilder.removeItem', { number: index + 1 })
            }
            onClick={() => onRemove(node.id)}
          >
            <FontAwesomeIcon icon={faTrash} />
          </ActionIcon>
        </Group>

        {node.locked && !parentLocked && (
          <Text size='xs' c='dimmed'>
            {t('server.dataEditor.valueBuilder.managedIdentity', {})}
          </Text>
        )}

        {container && (
          <Box pl='md' style={{ borderLeft: '2px solid var(--mantine-color-default-border)' }}>
            <Stack gap='sm'>
              {node.children.map((child, childIndex) => (
                <ValueNodeEditor
                  key={child.id}
                  node={child}
                  index={childIndex}
                  depth={depth + 1}
                  parentKind={node.kind as 'object' | 'array'}
                  parentLocked={node.locked}
                  canAddNode={canAddNode}
                  onUpdate={onUpdate}
                  onRemove={onRemove}
                  onAddChild={onAddChild}
                />
              ))}

              {!node.children.length && (
                <Text size='xs' c='dimmed'>
                  {node.kind === 'object'
                    ? t('server.dataEditor.valueBuilder.emptyNestedObject', {})
                    : t('server.dataEditor.valueBuilder.emptyArray', {})}
                </Text>
              )}

              <Group gap='xs'>
                <Button
                  type='button'
                  size='compact-xs'
                  variant='default'
                  disabled={node.locked || !canNest || !canAddNode}
                  leftSection={<FontAwesomeIcon icon={faPlus} />}
                  onClick={() => onAddChild(node)}
                >
                  {node.kind === 'object'
                    ? t('server.dataEditor.valueBuilder.addField', {})
                    : t('server.dataEditor.valueBuilder.addItem', {})}
                </Button>
                {!canNest && (
                  <Text size='xs' c='orange'>
                    {t('server.dataEditor.valueBuilder.maximumDepth', { count: MAX_DEPTH })}
                  </Text>
                )}
              </Group>
            </Stack>
          </Box>
        )}
      </Stack>
    </Card>
  );
}

function ScalarValueInput({
  node,
  onUpdate,
}: {
  node: VisualValueNode;
  onUpdate: (nodeId: string, update: (node: VisualValueNode) => VisualValueNode) => void;
}) {
  const { t } = translations.useTranslations();

  if (node.kind === 'boolean') {
    return (
      <Select
        label={t('server.dataEditor.valueBuilder.value', {})}
        data={[
          { value: 'true', label: t('server.dataEditor.valueBuilder.true', {}) },
          { value: 'false', label: t('server.dataEditor.valueBuilder.false', {}) },
        ]}
        value={node.scalar === true ? 'true' : 'false'}
        disabled={node.locked}
        onChange={(value) => onUpdate(node.id, (current) => ({ ...current, scalar: value === 'true' }))}
      />
    );
  }

  if (node.kind === 'null') {
    return (
      <Stack gap={4}>
        <Text size='xs' fw={500}>
          {t('server.dataEditor.valueBuilder.value', {})}
        </Text>
        <Text size='sm' c='dimmed' py={7}>
          {t('server.dataEditor.valueBuilder.nullValue', {})}
        </Text>
      </Stack>
    );
  }

  if (node.kind === 'number') {
    return (
      <TextInput
        label={t('server.dataEditor.valueBuilder.value', {})}
        inputMode='decimal'
        value={typeof node.scalar === 'string' ? node.scalar : ''}
        disabled={node.locked}
        onChange={(event) => {
          const scalar = event.currentTarget.value;
          onUpdate(node.id, (current) => ({ ...current, scalar }));
        }}
        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
      />
    );
  }

  return (
    <TextArea
      label={t('server.dataEditor.valueBuilder.value', {})}
      autosize
      minRows={1}
      maxRows={5}
      value={typeof node.scalar === 'string' ? node.scalar : ''}
      disabled={node.locked}
      onChange={(event) => {
        const scalar = event.currentTarget.value;
        onUpdate(node.id, (current) => ({ ...current, scalar }));
      }}
    />
  );
}
