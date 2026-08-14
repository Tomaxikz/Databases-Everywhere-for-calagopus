export const VISUAL_VALUE_KINDS = ['string', 'number', 'boolean', 'null', 'object', 'array'] as const;

export type VisualValueKind = (typeof VISUAL_VALUE_KINDS)[number];

export interface VisualValueNode {
  id: string;
  key: string;
  kind: VisualValueKind;
  scalar: string | boolean | null;
  children: VisualValueNode[];
  locked: boolean;
}

export type VisualValueValidationCode = 'field-name-required' | 'duplicate-field' | 'invalid-number';

export class VisualValueValidationError extends Error {
  public constructor(
    public readonly code: VisualValueValidationCode,
    public readonly path: string,
    public readonly field?: string,
  ) {
    super(code);
    this.name = 'VisualValueValidationError';
  }
}

let nodeSequence = 0;

function nextNodeId(): string {
  nodeSequence += 1;
  return `dbev-value-${nodeSequence}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nodeFromValue(value: unknown, key: string, locked: boolean): VisualValueNode {
  if (Array.isArray(value)) {
    return {
      id: nextNodeId(),
      key,
      kind: 'array',
      scalar: null,
      children: value.map((item) => nodeFromValue(item, '', locked)),
      locked,
    };
  }

  if (isRecord(value)) {
    return {
      id: nextNodeId(),
      key,
      kind: 'object',
      scalar: null,
      children: Object.entries(value).map(([childKey, childValue]) => nodeFromValue(childValue, childKey, locked)),
      locked,
    };
  }

  if (typeof value === 'number') {
    return {
      id: nextNodeId(),
      key,
      kind: 'number',
      scalar: String(value),
      children: [],
      locked,
    };
  }

  if (typeof value === 'boolean') {
    return {
      id: nextNodeId(),
      key,
      kind: 'boolean',
      scalar: value,
      children: [],
      locked,
    };
  }

  if (value === null || value === undefined) {
    return {
      id: nextNodeId(),
      key,
      kind: 'null',
      scalar: null,
      children: [],
      locked,
    };
  }

  return {
    id: nextNodeId(),
    key,
    kind: 'string',
    scalar: String(value),
    children: [],
    locked,
  };
}

export function visualValueRoot(value: unknown, lockedRootKeys: readonly string[] = []): VisualValueNode {
  const record = isRecord(value) ? value : {};
  const lockedKeys = new Set(lockedRootKeys);

  return {
    id: nextNodeId(),
    key: '',
    kind: 'object',
    scalar: null,
    children: Object.entries(record).map(([key, childValue]) => nodeFromValue(childValue, key, lockedKeys.has(key))),
    locked: false,
  };
}

export function createVisualValueChild(parent: VisualValueNode): VisualValueNode {
  return {
    id: nextNodeId(),
    key: parent.kind === 'object' ? nextAvailableFieldName(parent.children) : '',
    kind: 'string',
    scalar: '',
    children: [],
    locked: false,
  };
}

function nextAvailableFieldName(children: readonly VisualValueNode[]): string {
  const names = new Set(children.map((child) => child.key));
  if (!names.has('field')) return 'field';

  let suffix = 2;
  while (names.has(`field_${suffix}`)) suffix += 1;
  return `field_${suffix}`;
}

export function withVisualValueKind(node: VisualValueNode, kind: VisualValueKind): VisualValueNode {
  if (node.kind === kind) return node;

  switch (kind) {
    case 'string':
      return {
        ...node,
        kind,
        scalar:
          typeof node.scalar === 'string' ? node.scalar : node.scalar === null ? '' : node.scalar ? 'true' : 'false',
        children: [],
      };
    case 'number':
      return {
        ...node,
        kind,
        scalar: typeof node.scalar === 'string' && node.scalar.trim() ? node.scalar : '0',
        children: [],
      };
    case 'boolean':
      return {
        ...node,
        kind,
        scalar: typeof node.scalar === 'boolean' ? node.scalar : false,
        children: [],
      };
    case 'null':
      return { ...node, kind, scalar: null, children: [] };
    case 'object':
    case 'array':
      return { ...node, kind, scalar: null, children: [] };
  }
}

export function updateVisualValueNode(
  root: VisualValueNode,
  nodeId: string,
  update: (node: VisualValueNode) => VisualValueNode,
): VisualValueNode {
  if (root.id === nodeId) return update(root);
  if (!root.children.length) return root;

  let changed = false;
  const children = root.children.map((child) => {
    const next = updateVisualValueNode(child, nodeId, update);
    if (next !== child) changed = true;
    return next;
  });

  return changed ? { ...root, children } : root;
}

export function removeVisualValueNode(root: VisualValueNode, nodeId: string): VisualValueNode {
  const directChildren = root.children.filter((child) => child.id !== nodeId);
  if (directChildren.length !== root.children.length) return { ...root, children: directChildren };

  let changed = false;
  const children = root.children.map((child) => {
    const next = removeVisualValueNode(child, nodeId);
    if (next !== child) changed = true;
    return next;
  });

  return changed ? { ...root, children } : root;
}

export function countVisualValueNodes(node: VisualValueNode): number {
  return 1 + node.children.reduce((count, child) => count + countVisualValueNodes(child), 0);
}

export function visualValueToJson(root: VisualValueNode): Record<string, unknown> {
  return objectNodeToJson(root, '$');
}

function objectNodeToJson(node: VisualValueNode, path: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const names = new Set<string>();

  for (const child of node.children) {
    if (!child.key.trim()) throw new VisualValueValidationError('field-name-required', path);
    if (names.has(child.key)) throw new VisualValueValidationError('duplicate-field', path, child.key);
    names.add(child.key);
    result[child.key] = nodeToJson(child, `${path}.${child.key}`);
  }

  return result;
}

function nodeToJson(node: VisualValueNode, path: string): unknown {
  switch (node.kind) {
    case 'string':
      return typeof node.scalar === 'string' ? node.scalar : '';
    case 'number': {
      const raw = typeof node.scalar === 'string' ? node.scalar.trim() : '';
      const value = Number(raw);
      if (!raw || !Number.isFinite(value)) throw new VisualValueValidationError('invalid-number', path);
      return value;
    }
    case 'boolean':
      return node.scalar === true;
    case 'null':
      return null;
    case 'object':
      return objectNodeToJson(node, path);
    case 'array':
      return node.children.map((child, index) => nodeToJson(child, `${path}[${index}]`));
  }
}
