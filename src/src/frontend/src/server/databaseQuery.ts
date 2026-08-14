import { useQuery } from '@tanstack/react-query';
import { listDatabases } from '../api/client.ts';

export const databasesEverywhereQueryKey = (server: string) =>
  ['extensions', 'com.tomaxikz.databaseseverywhere', 'servers', server, 'databases'] as const;

export function serverHasDatabasesEverywhere(server: { featureLimits?: Record<string, unknown> } | undefined) {
  return (
    server?.featureLimits?.databasesEverywhereAvailable === true ||
    server?.featureLimits?.databasesEverywhereInUse === true
  );
}

export function useDatabasesEverywhere(server: string, enabled: boolean) {
  return useQuery({
    queryKey: databasesEverywhereQueryKey(server),
    queryFn: () => listDatabases(server),
    enabled: Boolean(server) && enabled,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
}
