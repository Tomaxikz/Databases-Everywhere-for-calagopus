import type { NodeRecord } from '../api/types.ts';

type NodeRuntimeStateInput = Pick<
  NodeRecord,
  'cached_system' | 'last_error' | 'mutation_block_reason' | 'mutations_allowed' | 'restart_required'
>;

export interface NodeRuntimeState {
  mutationBlocked: boolean;
  recordMutationBlocked: boolean;
  mutationBlockReason: string | null;
  restartRequired: boolean;
  operationalError: string | null;
}

export function nodeRuntimeState(node: NodeRuntimeStateInput): NodeRuntimeState {
  const mutationBlocked = node.mutations_allowed === false;
  const mutationBlockReason = mutationBlocked ? node.mutation_block_reason : null;

  return {
    mutationBlocked,
    recordMutationBlocked: mutationBlocked && node.cached_system !== null,
    mutationBlockReason,
    restartRequired: node.restart_required === true,
    operationalError: node.last_error && node.last_error !== mutationBlockReason ? node.last_error : null,
  };
}
