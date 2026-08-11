const root = ['extensions', 'com.tomaxikz.databaseseverywhere'] as const;

export const dbevQueryKeys = {
  root,
  adminNodes: () => [...root, 'admin', 'nodes'] as const,
  adminNode: (node: string) => [...root, 'admin', 'nodes', node] as const,
  adminNodeConfiguration: (node: string) => [...root, 'admin', 'nodes', node, 'configuration'] as const,
  adminImageRegistry: (protocol: string, page: number) => [...root, 'admin', 'image-registry', protocol, page] as const,
  panelNodeAssignments: (node: string) => [...root, 'admin', 'panel-nodes', node, 'hosts'] as const,
  locationAssignments: (location: string) => [...root, 'admin', 'locations', location, 'hosts'] as const,
  panelNodeAvailabilityRoot: () => [...root, 'admin', 'panel-nodes'] as const,
  panelNodeAvailability: (node: string) => [...root, 'admin', 'panel-nodes', node, 'availability'] as const,
  databaseRuntime: (server: string, database: string) =>
    [...root, 'server', server, 'databases', database, 'runtime'] as const,
  databaseExplorer: (server: string, database: string) =>
    [...root, 'server', server, 'databases', database, 'explorer'] as const,
  databaseRows: (server: string, database: string, namespace: string | null, object: string, page: number) =>
    [...root, 'server', server, 'databases', database, 'rows', namespace, object, page] as const,
  databaseSchema: (server: string, database: string, namespace: string | null, object: string) =>
    [...root, 'server', server, 'databases', database, 'schema', namespace, object] as const,
  databaseBackups: (server: string, database: string) =>
    [...root, 'server', server, 'databases', database, 'backups'] as const,
  databaseBackupContents: (server: string, database: string, backup: string | null, object: string | null) =>
    [...root, 'server', server, 'databases', database, 'backups', backup, 'contents', object] as const,
};
