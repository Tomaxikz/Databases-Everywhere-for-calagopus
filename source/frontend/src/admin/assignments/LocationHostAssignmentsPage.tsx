import { z } from 'zod';
import { adminLocationSchema } from '@/lib/schemas/admin/locations.ts';
import HostAssignmentsPage from './HostAssignmentsPage.tsx';

export default function LocationHostAssignmentsPage({ location }: { location: z.infer<typeof adminLocationSchema> }) {
  return <HostAssignmentsPage target='location' targetUuid={location.uuid} targetName={location.name} />;
}
