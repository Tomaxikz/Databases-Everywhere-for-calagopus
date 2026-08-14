import { z } from 'zod';
import { adminNodeSchema } from '@/lib/schemas/admin/nodes.ts';
import HostAssignmentsPage from './HostAssignmentsPage.tsx';

export default function NodeHostAssignmentsPage({ node }: { node: z.infer<typeof adminNodeSchema> }) {
  return <HostAssignmentsPage target='panel-node' targetUuid={node.uuid} targetName={node.name} />;
}
