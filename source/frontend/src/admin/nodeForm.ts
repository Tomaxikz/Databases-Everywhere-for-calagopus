import { z } from 'zod';
import type { NodeInput, NodeRecord } from '../api/types.ts';

export const protocols = [
  ['postgres', 'PostgreSQL', 20020, 'postgres:18.4'],
  ['mysql', 'MySQL', 3308, 'mysql:8.4'],
  ['mariadb', 'MariaDB', 20021, 'mariadb:12.3.2'],
  ['redis', 'Redis', 20022, 'redis:8.8.0'],
  ['valkey', 'Valkey', 20027, 'valkey/valkey:9.1.1'],
  ['mongodb', 'MongoDB', 20023, 'mongo:8.3.4'],
  ['clickhouse', 'ClickHouse', 20024, 'clickhouse/clickhouse-server:26.4.4.38'],
  ['qdrant', 'Qdrant', 20025, 'qdrant/qdrant:v1.18.2'],
] as const;

export type ProtocolKey = (typeof protocols)[number][0];

const hostName = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => !value.includes('/') && !value.match(/\s/));
const optionalAbsolutePath = z
  .string()
  .trim()
  .max(500)
  .refine((value) => !value || value.startsWith('/'));
const absolutePath = z.string().trim().startsWith('/').max(500);
const httpOrigin = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const origin = new URL(value);
      return (
        ['http:', 'https:'].includes(origin.protocol) &&
        !origin.username &&
        !origin.password &&
        (origin.pathname === '' || origin.pathname === '/') &&
        !origin.search &&
        !origin.hash
      );
    } catch {
      return false;
    }
  });

const imageReference = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((image) => {
    const tail = image.split('/').at(-1) || '';
    const tag = tail.includes(':') ? tail.slice(tail.lastIndexOf(':') + 1) : '';
    return image.includes('@sha256:') || (tag.length > 0 && tag.toLowerCase() !== 'latest');
  });

const protocolConfigurationSchema = z.object({
  enabled: z.boolean(),
  bindHost: hostName,
  port: z.number().int().min(1).max(65_535),
  tls: z.boolean(),
  image: imageReference,
  allowedImages: z.array(imageReference).min(1).max(100),
});

const configurationSchema = z.object({
  debug: z.boolean(),
  protocols: z.object({
    postgres: protocolConfigurationSchema,
    mysql: protocolConfigurationSchema,
    mariadb: protocolConfigurationSchema,
    redis: protocolConfigurationSchema,
    valkey: protocolConfigurationSchema,
    mongodb: protocolConfigurationSchema,
    clickhouse: protocolConfigurationSchema.extend({
      httpBindHost: hostName,
      httpPort: z.number().int().min(1).max(65_535),
    }),
    qdrant: protocolConfigurationSchema,
  }),
  databaseTls: z.object({ cert: optionalAbsolutePath, key: optionalAbsolutePath }),
  api: z.object({
    host: hostName,
    port: z.number().int().min(1).max(65_535),
    trustedHosts: z.array(hostName).max(100),
    trustedOrigins: z.array(httpOrigin).max(100),
    sslEnabled: z.boolean(),
    sslCert: optionalAbsolutePath,
    sslKey: optionalAbsolutePath,
    requireClientCert: z.boolean(),
    clientCa: optionalAbsolutePath,
  }),
  allocation: z.object({
    preventCpuOverallocation: z.boolean(),
    preventMemoryOverallocation: z.boolean(),
    preventDiskOverallocation: z.boolean(),
    maxMemoryMib: z.number().int().min(0).max(1_048_576),
    maxDiskMib: z.number().int().min(0),
    reservedMemoryMib: z.number().int().min(0).max(1_048_576),
    reservedDiskMib: z.number().int().min(0),
  }),
  backups: z.object({
    enabled: z.boolean(),
    intervalMinutes: z.number().int().min(1).max(525_600),
    runOnStartup: z.boolean(),
    retentionKeepLatestPerInstance: z.number().int().min(0).max(100_000),
    retentionMaxAgeDays: z.number().int().min(0).max(36_500),
    storageDriver: z.enum(['local', 's3', 'kopia']),
    s3: z.object({
      bucket: z.string().trim().max(255),
      region: z.string().trim().min(1).max(100),
      endpoint: z
        .string()
        .trim()
        .max(2048)
        .refine((value) => !value || z.url({ protocol: /^https?$/ }).safeParse(value).success),
      prefix: z.string().trim().max(500),
      pathStyle: z.boolean(),
      allowHttp: z.boolean(),
      requestTimeoutSeconds: z.number().int().min(1).max(86_400),
      maxRetries: z.number().int().min(0).max(100),
    }),
    kopia: z.object({
      executable: absolutePath,
      configFile: optionalAbsolutePath,
      operationTimeoutSeconds: z.number().int().min(1).max(86_400),
    }),
    browsing: z.object({
      enabled: z.boolean(),
      maxObjects: z.number().int().min(1).max(100_000),
      maxPreviewObjects: z.number().int().min(0).max(100_000),
      previewRowsPerObject: z.number().int().min(0).max(10_000),
      maxRowBytes: z.number().int().min(1).max(10_485_760),
      maxCatalogBytes: z.number().int().min(1).max(1_073_741_824),
    }),
  }),
  artifacts: z.object({
    streamExportsOnly: z.boolean(),
    maxArtifactsPerInstance: z.number().int().min(1).max(10_000),
    retentionKeepLatest: z.number().int().min(0).max(100_000),
    retentionMaxAgeDays: z.number().int().min(0).max(36_500),
    scheduler: z.object({
      dynamicLimiterEnabled: z.boolean(),
      maxQueuedJobs: z.number().int().min(64).max(8_192),
      maxQueuedJobsPerInstance: z.number().int().min(1).max(256),
      manualMaxActiveJobs: z.number().int().min(1).max(1_024),
      dynamicMaxActiveJobs: z.number().int().min(1).max(1_024),
      dynamicMemoryBudgetMib: z
        .number()
        .int()
        .refine((value) => value === 0 || (value >= 128 && value <= 16_777_216)),
      dynamicIoBudgetMib: z
        .number()
        .int()
        .refine((value) => value === 0 || (value >= 256 && value <= 67_108_864)),
      dynamicCpuUnits: z.number().int().min(0).max(65_536),
      starvationTimeoutSeconds: z.number().int().min(1).max(3_600),
      maxBypass: z.number().int().min(0).max(1_024),
    }),
  }),
  daemon: z.object({
    engine: z.enum(['docker', 'podman']),
    socketPath: optionalAbsolutePath,
    containerReadOnlyRootfs: z.boolean(),
    containerUsernsMode: z.string().trim().max(255),
    containerSeccompProfile: z.string().trim().max(500),
    containerApparmorProfile: z.string().trim().max(500),
    containerSecurityOpts: z.array(z.string().trim().min(1).max(500)).max(100),
  }),
  security: z.object({
    apiBodyLimitBytes: z.number().int().min(1),
    apiRateLimitPerMinute: z.number().int().min(1),
    dbConnectionLimitPerMinute: z.number().int().min(1),
    pidsLimit: z.number().int().min(1),
    clickhousePidsLimit: z.number().int().min(1),
  }),
  disk: z.object({
    mode: z.enum(['auto', 'project_quota', 'fuse_quota', 'soft_scanner']),
    fuseQuotaBinary: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((value) => value === 'embedded' || value.startsWith('/')),
    fuseQuotaBinarySha256: z
      .string()
      .trim()
      .regex(/^(?:|[0-9a-f]{64})$/),
    fuseQuotaRescanIntervalSeconds: z.number().int().min(1).max(86_400),
    projectIdBase: z.number().int().min(1).max(2_147_000_000),
    softScanner: z.object({
      scanIntervalSeconds: z.number().int().min(1).max(3_600),
      maxConcurrentScans: z.number().int().min(1).max(64),
      maxEntriesPerScan: z.number().int().min(1).max(10_000_000),
      scanTimeoutSeconds: z.number().int().min(1).max(3_600),
      maxConsecutiveScanFailures: z.number().int().min(1).max(10),
      safetyReserveMib: z.number().int().min(0),
      recoveryPercent: z.number().int().min(1).max(99),
      shutdownGraceSeconds: z.number().int().min(1).max(300),
    }),
  }),
  paths: z.object({
    data: z.string().trim().startsWith('/').max(500),
    metadata: z.string().trim().startsWith('/').max(500),
    volumes: z.string().trim().startsWith('/').max(500),
    backups: z.string().trim().startsWith('/').max(500),
    sockets: z.string().trim().startsWith('/').max(500),
    locks: z.string().trim().startsWith('/').max(500),
    logs: z.string().trim().startsWith('/').max(500),
    artifacts: z.string().trim().startsWith('/').max(500),
    exports: z.string().trim().startsWith('/').max(500),
    imports: z.string().trim().startsWith('/').max(500),
    fuse: z.string().trim().startsWith('/').max(500),
    tmp: z.string().trim().startsWith('/').max(500),
  }),
});

const secretSchema = z.object({
  s3AccessKeyId: z.string().max(5000),
  s3SecretAccessKey: z.string().max(5000),
  s3SessionToken: z.string().max(5000),
  kopiaRepositoryPassword: z.string().max(5000),
  clearS3Credentials: z.boolean(),
  clearKopiaRepositoryPassword: z.boolean(),
});

const baseNodeFormSchema = z.object({
  name: z.string().trim().min(1).max(191),
  apiUrl: z.url({ protocol: /^https?$/ }).max(2048),
  publicHost: hostName,
  defaultCpuCores: z.number().min(0.01).max(1024),
  defaultMemoryMib: z.number().int().min(1).max(1_048_576),
  defaultDiskMib: z.number().int().min(1),
  config: configurationSchema,
  secrets: secretSchema,
  enabled: z.boolean(),
});

export type NodeFormValues = z.infer<typeof baseNodeFormSchema>;

export function createNodeFormSchema(messages: {
  apiTlsRequired: string;
  clientCaRequired: string;
  clientCertificatesRequireTls: string;
  databaseTlsRequired: string;
  s3BucketRequired: string;
  s3HttpRequiresOptIn: string;
  clickhousePortsUnique: string;
  gatewayBindUnique: string;
  gatewayProtocolRequired: string;
  mysqlNineUnsupported: string;
}) {
  return baseNodeFormSchema.superRefine((value, context) => {
    if (value.enabled && !protocols.some(([protocol]) => value.config.protocols[protocol].enabled)) {
      context.addIssue({
        code: 'custom',
        path: ['config', 'protocols'],
        message: messages.gatewayProtocolRequired,
      });
    }
    if (value.config.api.sslEnabled && (!value.config.api.sslCert || !value.config.api.sslKey)) {
      context.addIssue({ code: 'custom', path: ['config', 'api', 'sslCert'], message: messages.apiTlsRequired });
    }
    if (value.config.api.requireClientCert && !value.config.api.clientCa) {
      context.addIssue({
        code: 'custom',
        path: ['config', 'api', 'clientCa'],
        message: messages.clientCaRequired,
      });
    }
    if (value.config.api.requireClientCert && !value.config.api.sslEnabled) {
      context.addIssue({
        code: 'custom',
        path: ['config', 'api', 'requireClientCert'],
        message: messages.clientCertificatesRequireTls,
      });
    }
    const protocolTlsEnabled = protocols.some(
      ([protocol]) => value.config.protocols[protocol].enabled && value.config.protocols[protocol].tls,
    );
    if (protocolTlsEnabled && (!value.config.databaseTls.cert || !value.config.databaseTls.key)) {
      context.addIssue({
        code: 'custom',
        path: ['config', 'databaseTls', 'cert'],
        message: messages.databaseTlsRequired,
      });
    }
    if (
      value.config.backups.enabled &&
      value.config.backups.storageDriver === 's3' &&
      value.config.backups.s3.endpoint.toLowerCase().startsWith('http://') &&
      !value.config.backups.s3.allowHttp
    ) {
      context.addIssue({
        code: 'custom',
        path: ['config', 'backups', 's3', 'allowHttp'],
        message: messages.s3HttpRequiresOptIn,
      });
    }
    if (
      value.config.backups.enabled &&
      value.config.backups.storageDriver === 's3' &&
      !value.config.backups.s3.bucket
    ) {
      context.addIssue({
        code: 'custom',
        path: ['config', 'backups', 's3', 'bucket'],
        message: messages.s3BucketRequired,
      });
    }
    if (value.config.protocols.clickhouse.port === value.config.protocols.clickhouse.httpPort) {
      context.addIssue({
        code: 'custom',
        path: ['config', 'protocols', 'clickhouse', 'httpPort'],
        message: messages.clickhousePortsUnique,
      });
    }
    const binds = new Map<string, (string | number)[]>();
    const addBind = (host: string, port: number, path: (string | number)[]) => {
      const bind = `${host.trim().toLowerCase()}:${port}`;
      const existing = binds.get(bind);
      if (existing) {
        context.addIssue({ code: 'custom', path, message: messages.gatewayBindUnique });
        return;
      }
      binds.set(bind, path);
    };
    for (const [protocol] of protocols) {
      const protocolConfig = value.config.protocols[protocol];
      if (!protocolConfig.enabled) continue;
      addBind(protocolConfig.bindHost, protocolConfig.port, ['config', 'protocols', protocol, 'port']);
      if (protocol === 'clickhouse') {
        const clickhouse = value.config.protocols.clickhouse;
        addBind(clickhouse.httpBindHost, clickhouse.httpPort, ['config', 'protocols', 'clickhouse', 'httpPort']);
      }
    }
    const mysqlImages = [value.config.protocols.mysql.image, ...value.config.protocols.mysql.allowedImages];
    if (mysqlImages.some(isMySqlNineImage)) {
      context.addIssue({
        code: 'custom',
        path: ['config', 'protocols', 'mysql', 'image'],
        message: messages.mysqlNineUnsupported,
      });
    }
    const scheduler = value.config.artifacts.scheduler;
    for (const [field, fieldValue] of [
      ['maxQueuedJobsPerInstance', scheduler.maxQueuedJobsPerInstance],
      ['manualMaxActiveJobs', scheduler.manualMaxActiveJobs],
      ['dynamicMaxActiveJobs', scheduler.dynamicMaxActiveJobs],
    ] as const) {
      if (fieldValue > scheduler.maxQueuedJobs) {
        context.addIssue({
          code: 'custom',
          path: ['config', 'artifacts', 'scheduler', field],
          message: 'This scheduler limit cannot exceed the durable queue limit.',
        });
      }
    }
  });
}

export function isLoopbackHost(host: string) {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)]$/, '$1');
  return normalized === 'localhost' || normalized.startsWith('127.') || normalized === '::1';
}

function isMySqlNineImage(image: string) {
  const withoutDigest = image.split('@', 1)[0];
  const tail = withoutDigest.split('/').at(-1) || '';
  const tag = tail.includes(':') ? tail.slice(tail.lastIndexOf(':') + 1) : '';
  return /^9(?:[.-]|$)/.test(tag);
}

const pathValue = (root: Record<string, unknown>, path: string[], fallback: unknown): unknown => {
  let current: unknown = root;
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return fallback;
    current = (current as Record<string, unknown>)[part];
  }
  return current ?? fallback;
};

const stringValue = (root: Record<string, unknown>, path: string[], fallback = '') => {
  const value = pathValue(root, path, fallback);
  return typeof value === 'string' ? value : fallback;
};
const numberValue = (root: Record<string, unknown>, path: string[], fallback: number) => {
  const value = pathValue(root, path, fallback);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};
const booleanValue = (root: Record<string, unknown>, path: string[], fallback: boolean) => {
  const value = pathValue(root, path, fallback);
  return typeof value === 'boolean' ? value : fallback;
};
const stringsValue = (root: Record<string, unknown>, path: string[], fallback: string[]) => {
  const value = pathValue(root, path, fallback);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : fallback;
};

function parseBind(bind: string, fallbackHost: string, fallbackPort: number) {
  const separator = bind.lastIndexOf(':');
  if (separator < 1) return { host: fallbackHost, port: fallbackPort };
  const port = Number(bind.slice(separator + 1));
  return {
    host: bind.slice(0, separator) || fallbackHost,
    port: Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallbackPort,
  };
}

export function initialNodeFormValues(node?: NodeRecord): NodeFormValues {
  const configuration = node?.configuration ?? {};
  const protocolValues = Object.fromEntries(
    protocols.map(([protocol, , defaultPort, defaultImage]) => {
      const bind = parseBind(
        stringValue(configuration, [protocol, 'bind'], `0.0.0.0:${defaultPort}`),
        '0.0.0.0',
        defaultPort,
      );
      const base = {
        enabled: booleanValue(configuration, [protocol, 'enabled'], true),
        bindHost: bind.host,
        port: bind.port,
        tls: booleanValue(configuration, [protocol, 'tls'], false),
        image: stringValue(configuration, ['images', protocol], defaultImage),
        allowedImages: stringsValue(configuration, ['images', 'allowed', protocol], [defaultImage]),
      };
      return [
        protocol,
        protocol === 'clickhouse'
          ? {
              ...base,
              ...(() => {
                const http = parseBind(
                  stringValue(configuration, ['clickhouse', 'http_bind'], '0.0.0.0:20026'),
                  '0.0.0.0',
                  20026,
                );
                return { httpBindHost: http.host, httpPort: http.port };
              })(),
            }
          : base,
      ];
    }),
  ) as NodeFormValues['config']['protocols'];

  return {
    name: node?.name ?? '',
    apiUrl: node?.api_url ?? 'https://',
    publicHost: node?.public_host ?? '',
    defaultCpuCores: node?.default_cpu_cores ?? 0.5,
    defaultMemoryMib: node?.default_memory_mib ?? 512,
    defaultDiskMib: node?.default_disk_mib ?? 1024,
    enabled: node?.enabled ?? true,
    config: {
      debug: booleanValue(configuration, ['debug'], false),
      protocols: protocolValues,
      databaseTls: {
        cert: stringValue(configuration, ['tls', 'cert']),
        key: stringValue(configuration, ['tls', 'key']),
      },
      api: {
        host: stringValue(configuration, ['api', 'host'], '127.0.0.1'),
        port: numberValue(configuration, ['api', 'port'], 8090),
        trustedHosts: stringsValue(configuration, ['api', 'trusted_hosts'], []),
        trustedOrigins: stringsValue(configuration, ['api', 'trusted_origins'], []),
        sslEnabled: booleanValue(configuration, ['api', 'ssl', 'enabled'], false),
        sslCert: stringValue(configuration, ['api', 'ssl', 'cert']),
        sslKey: stringValue(configuration, ['api', 'ssl', 'key']),
        requireClientCert: booleanValue(configuration, ['api', 'ssl', 'require_client_cert'], false),
        clientCa: stringValue(configuration, ['api', 'ssl', 'client_ca']),
      },
      allocation: {
        preventCpuOverallocation: booleanValue(configuration, ['allocation', 'prevent_cpu_overallocation'], true),
        preventMemoryOverallocation: booleanValue(configuration, ['allocation', 'prevent_memory_overallocation'], true),
        preventDiskOverallocation: booleanValue(configuration, ['allocation', 'prevent_disk_overallocation'], true),
        maxMemoryMib: numberValue(configuration, ['allocation', 'max_memory_mib'], 0),
        maxDiskMib: numberValue(configuration, ['allocation', 'max_disk_mib'], 0),
        reservedMemoryMib: numberValue(configuration, ['allocation', 'reserved_memory_mib'], 512),
        reservedDiskMib: numberValue(configuration, ['allocation', 'reserved_disk_mib'], 2048),
      },
      backups: {
        enabled: booleanValue(configuration, ['backups', 'enabled'], true),
        intervalMinutes: numberValue(configuration, ['backups', 'interval_minutes'], 1440),
        runOnStartup: booleanValue(configuration, ['backups', 'run_on_startup'], false),
        retentionKeepLatestPerInstance: numberValue(
          configuration,
          ['backups', 'retention_keep_latest_per_instance'],
          7,
        ),
        retentionMaxAgeDays: numberValue(configuration, ['backups', 'retention_max_age_days'], 30),
        storageDriver: stringValue(configuration, ['backups', 'storage', 'driver'], 'local') as
          | 'local'
          | 's3'
          | 'kopia',
        s3: {
          bucket: stringValue(configuration, ['backups', 'storage', 's3', 'bucket']),
          region: stringValue(configuration, ['backups', 'storage', 's3', 'region'], 'us-east-1'),
          endpoint: stringValue(configuration, ['backups', 'storage', 's3', 'endpoint']),
          prefix: stringValue(configuration, ['backups', 'storage', 's3', 'prefix'], 'dbev'),
          pathStyle: booleanValue(configuration, ['backups', 'storage', 's3', 'path_style'], false),
          allowHttp: booleanValue(configuration, ['backups', 'storage', 's3', 'allow_http'], false),
          requestTimeoutSeconds: numberValue(
            configuration,
            ['backups', 'storage', 's3', 'request_timeout_seconds'],
            900,
          ),
          maxRetries: numberValue(configuration, ['backups', 'storage', 's3', 'max_retries'], 3),
        },
        kopia: {
          executable: stringValue(configuration, ['backups', 'storage', 'kopia', 'executable'], '/usr/local/bin/kopia'),
          configFile: stringValue(configuration, ['backups', 'storage', 'kopia', 'config_file']),
          operationTimeoutSeconds: numberValue(
            configuration,
            ['backups', 'storage', 'kopia', 'operation_timeout_seconds'],
            3600,
          ),
        },
        browsing: {
          enabled: booleanValue(configuration, ['backups', 'browsing', 'enabled'], true),
          maxObjects: numberValue(configuration, ['backups', 'browsing', 'max_objects'], 256),
          maxPreviewObjects: numberValue(configuration, ['backups', 'browsing', 'max_preview_objects'], 32),
          previewRowsPerObject: numberValue(configuration, ['backups', 'browsing', 'preview_rows_per_object'], 10),
          maxRowBytes: numberValue(configuration, ['backups', 'browsing', 'max_row_bytes'], 4096),
          maxCatalogBytes: numberValue(configuration, ['backups', 'browsing', 'max_catalog_bytes'], 1_048_576),
        },
      },
      artifacts: {
        streamExportsOnly: booleanValue(configuration, ['artifacts', 'stream_exports_only'], false),
        maxArtifactsPerInstance: numberValue(configuration, ['artifacts', 'max_artifacts_per_instance'], 20),
        retentionKeepLatest: numberValue(configuration, ['artifacts', 'retention_keep_latest'], 20),
        retentionMaxAgeDays: numberValue(configuration, ['artifacts', 'retention_max_age_days'], 30),
        scheduler: {
          dynamicLimiterEnabled: booleanValue(
            configuration,
            ['artifacts', 'import_export_scheduler', 'dynamic_limiter_enabled'],
            true,
          ),
          maxQueuedJobs: numberValue(configuration, ['artifacts', 'import_export_scheduler', 'max_queued_jobs'], 1024),
          maxQueuedJobsPerInstance: numberValue(
            configuration,
            ['artifacts', 'import_export_scheduler', 'max_queued_jobs_per_instance'],
            32,
          ),
          manualMaxActiveJobs: numberValue(
            configuration,
            ['artifacts', 'import_export_scheduler', 'manual_max_active_jobs'],
            16,
          ),
          dynamicMaxActiveJobs: numberValue(
            configuration,
            ['artifacts', 'import_export_scheduler', 'dynamic_max_active_jobs'],
            256,
          ),
          dynamicMemoryBudgetMib: numberValue(
            configuration,
            ['artifacts', 'import_export_scheduler', 'dynamic_memory_budget_mib'],
            0,
          ),
          dynamicIoBudgetMib: numberValue(
            configuration,
            ['artifacts', 'import_export_scheduler', 'dynamic_io_budget_mib'],
            0,
          ),
          dynamicCpuUnits: numberValue(configuration, ['artifacts', 'import_export_scheduler', 'dynamic_cpu_units'], 0),
          starvationTimeoutSeconds: numberValue(
            configuration,
            ['artifacts', 'import_export_scheduler', 'starvation_timeout_seconds'],
            30,
          ),
          maxBypass: numberValue(configuration, ['artifacts', 'import_export_scheduler', 'max_bypass'], 8),
        },
      },
      daemon: {
        engine: stringValue(configuration, ['daemon', 'engine'], 'docker') as 'docker' | 'podman',
        socketPath: stringValue(configuration, ['daemon', 'socket_path']),
        containerReadOnlyRootfs: booleanValue(configuration, ['daemon', 'container_read_only_rootfs'], false),
        containerUsernsMode: stringValue(configuration, ['daemon', 'container_userns_mode']),
        containerSeccompProfile: stringValue(configuration, ['daemon', 'container_seccomp_profile']),
        containerApparmorProfile: stringValue(configuration, ['daemon', 'container_apparmor_profile']),
        containerSecurityOpts: stringsValue(configuration, ['daemon', 'container_security_opts'], []),
      },
      security: {
        apiBodyLimitBytes: numberValue(configuration, ['security', 'api_body_limit_bytes'], 1_048_576),
        apiRateLimitPerMinute: numberValue(configuration, ['security', 'api_rate_limit_per_minute'], 600),
        dbConnectionLimitPerMinute: numberValue(configuration, ['security', 'db_connection_limit_per_minute'], 240),
        pidsLimit: numberValue(configuration, ['security', 'pids_limit'], 512),
        clickhousePidsLimit: numberValue(configuration, ['security', 'pids_limits', 'clickhouse'], 4096),
      },
      disk: {
        mode: (() => {
          const mode = stringValue(configuration, ['disk', 'mode'], 'auto');
          return (mode === 'none' ? 'soft_scanner' : mode) as NodeFormValues['config']['disk']['mode'];
        })(),
        fuseQuotaBinary: stringValue(configuration, ['disk', 'fuse_quota_binary'], 'embedded'),
        fuseQuotaBinarySha256: stringValue(configuration, ['disk', 'fuse_quota_binary_sha256']),
        fuseQuotaRescanIntervalSeconds: numberValue(configuration, ['disk', 'fuse_quota_rescan_interval_seconds'], 150),
        projectIdBase: numberValue(configuration, ['disk', 'project_id_base'], 200_000),
        softScanner: {
          scanIntervalSeconds: numberValue(configuration, ['disk', 'soft_scanner', 'scan_interval_seconds'], 15),
          maxConcurrentScans: numberValue(configuration, ['disk', 'soft_scanner', 'max_concurrent_scans'], 2),
          maxEntriesPerScan: numberValue(configuration, ['disk', 'soft_scanner', 'max_entries_per_scan'], 1_000_000),
          scanTimeoutSeconds: numberValue(configuration, ['disk', 'soft_scanner', 'scan_timeout_seconds'], 30),
          maxConsecutiveScanFailures: numberValue(
            configuration,
            ['disk', 'soft_scanner', 'max_consecutive_scan_failures'],
            3,
          ),
          safetyReserveMib: numberValue(configuration, ['disk', 'soft_scanner', 'safety_reserve_mib'], 64),
          recoveryPercent: numberValue(configuration, ['disk', 'soft_scanner', 'recovery_percent'], 85),
          shutdownGraceSeconds: numberValue(configuration, ['disk', 'soft_scanner', 'shutdown_grace_seconds'], 30),
        },
      },
      paths: {
        data: stringValue(configuration, ['paths', 'data'], '/var/lib/dbev'),
        metadata: stringValue(configuration, ['paths', 'metadata'], '/var/lib/dbev/metadata'),
        volumes: stringValue(configuration, ['paths', 'volumes'], '/var/lib/dbev/volumes'),
        backups: stringValue(configuration, ['paths', 'backups'], '/var/lib/dbev/backups'),
        sockets: stringValue(configuration, ['paths', 'sockets'], '/run/dbev/sockets'),
        locks: stringValue(configuration, ['paths', 'locks'], '/run/dbev/locks'),
        logs: stringValue(configuration, ['paths', 'logs'], '/var/log/dbev'),
        artifacts: stringValue(configuration, ['paths', 'artifacts'], '/var/lib/dbev/artifacts'),
        exports: stringValue(configuration, ['paths', 'exports'], '/var/lib/dbev/artifacts/exports'),
        imports: stringValue(configuration, ['paths', 'imports'], '/var/lib/dbev/artifacts/imports'),
        fuse: stringValue(configuration, ['paths', 'fuse'], '/var/lib/dbev/fuse'),
        tmp: stringValue(configuration, ['paths', 'tmp'], '/var/lib/dbev/tmp'),
      },
    },
    secrets: {
      s3AccessKeyId: '',
      s3SecretAccessKey: '',
      s3SessionToken: '',
      kopiaRepositoryPassword: '',
      clearS3Credentials: false,
      clearKopiaRepositoryPassword: false,
    },
  };
}

function mergeConfiguration(
  base: Record<string, unknown>,
  replacement: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(replacement)) {
    const current = merged[key];
    if (
      current &&
      value &&
      typeof current === 'object' &&
      typeof value === 'object' &&
      !Array.isArray(current) &&
      !Array.isArray(value)
    ) {
      merged[key] = mergeConfiguration(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function toNodeInput(
  values: NodeFormValues,
  existingConfiguration: Record<string, unknown> = {},
  options: { includeArtifactPolicy?: boolean } = {},
): NodeInput {
  const config = values.config;
  const includeArtifactPolicy = options.includeArtifactPolicy !== false;
  const configurationBase = includeArtifactPolicy
    ? existingConfiguration
    : withoutArtifactPolicy(existingConfiguration);
  const protocolConfiguration = Object.fromEntries(
    protocols.map(([protocol]) => {
      const value = config.protocols[protocol];
      return [
        protocol,
        {
          enabled: value.enabled,
          bind: `${value.bindHost}:${value.port}`,
          ...(protocol === 'clickhouse'
            ? {
                http_bind: `${config.protocols.clickhouse.httpBindHost}:${config.protocols.clickhouse.httpPort}`,
              }
            : {}),
          tls: value.tls,
        },
      ];
    }),
  );
  const images = Object.fromEntries(protocols.map(([protocol]) => [protocol, config.protocols[protocol].image]));
  const allowed = Object.fromEntries(
    protocols.map(([protocol]) => [
      protocol,
      Array.from(new Set([config.protocols[protocol].image, ...config.protocols[protocol].allowedImages])),
    ]),
  );

  const configuration = mergeConfiguration(configurationBase, {
    debug: config.debug,
    tls: { cert: config.databaseTls.cert, key: config.databaseTls.key },
    ...protocolConfiguration,
    api: {
      host: config.api.host,
      port: config.api.port,
      trusted_hosts: config.api.trustedHosts,
      trusted_origins: config.api.trustedOrigins,
      ssl: {
        enabled: config.api.sslEnabled,
        cert: config.api.sslCert,
        key: config.api.sslKey,
        require_client_cert: config.api.requireClientCert,
        client_ca: config.api.clientCa,
      },
    },
    security: {
      api_body_limit_bytes: config.security.apiBodyLimitBytes,
      api_rate_limit_per_minute: config.security.apiRateLimitPerMinute,
      db_connection_limit_per_minute: config.security.dbConnectionLimitPerMinute,
      pids_limit: config.security.pidsLimit,
      pids_limits: { clickhouse: config.security.clickhousePidsLimit },
    },
    artifacts: {
      ...(includeArtifactPolicy
        ? {
            stream_exports_only: config.artifacts.streamExportsOnly,
            max_artifacts_per_instance: config.artifacts.maxArtifactsPerInstance,
          }
        : {}),
      retention_keep_latest: config.artifacts.retentionKeepLatest,
      retention_max_age_days: config.artifacts.retentionMaxAgeDays,
      import_export_scheduler: {
        dynamic_limiter_enabled: config.artifacts.scheduler.dynamicLimiterEnabled,
        max_queued_jobs: config.artifacts.scheduler.maxQueuedJobs,
        max_queued_jobs_per_instance: config.artifacts.scheduler.maxQueuedJobsPerInstance,
        manual_max_active_jobs: config.artifacts.scheduler.manualMaxActiveJobs,
        dynamic_max_active_jobs: config.artifacts.scheduler.dynamicMaxActiveJobs,
        dynamic_memory_budget_mib: config.artifacts.scheduler.dynamicMemoryBudgetMib,
        dynamic_io_budget_mib: config.artifacts.scheduler.dynamicIoBudgetMib,
        dynamic_cpu_units: config.artifacts.scheduler.dynamicCpuUnits,
        starvation_timeout_seconds: config.artifacts.scheduler.starvationTimeoutSeconds,
        max_bypass: config.artifacts.scheduler.maxBypass,
      },
    },
    backups: {
      enabled: config.backups.enabled,
      interval_minutes: config.backups.intervalMinutes,
      run_on_startup: config.backups.runOnStartup,
      retention_keep_latest_per_instance: config.backups.retentionKeepLatestPerInstance,
      retention_max_age_days: config.backups.retentionMaxAgeDays,
      storage: {
        driver: config.backups.storageDriver,
        s3: {
          bucket: config.backups.s3.bucket,
          region: config.backups.s3.region,
          endpoint: config.backups.s3.endpoint,
          prefix: config.backups.s3.prefix,
          access_key_id: '',
          secret_access_key: '',
          session_token: '',
          path_style: config.backups.s3.pathStyle,
          allow_http: config.backups.s3.allowHttp,
          request_timeout_seconds: config.backups.s3.requestTimeoutSeconds,
          max_retries: config.backups.s3.maxRetries,
        },
        kopia: {
          executable: config.backups.kopia.executable,
          config_file: config.backups.kopia.configFile,
          repository_password: '',
          operation_timeout_seconds: config.backups.kopia.operationTimeoutSeconds,
        },
      },
      browsing: {
        enabled: config.backups.browsing.enabled,
        max_objects: config.backups.browsing.maxObjects,
        max_preview_objects: config.backups.browsing.maxPreviewObjects,
        preview_rows_per_object: config.backups.browsing.previewRowsPerObject,
        max_row_bytes: config.backups.browsing.maxRowBytes,
        max_catalog_bytes: config.backups.browsing.maxCatalogBytes,
      },
    },
    allocation: {
      prevent_cpu_overallocation: config.allocation.preventCpuOverallocation,
      prevent_memory_overallocation: config.allocation.preventMemoryOverallocation,
      prevent_disk_overallocation: config.allocation.preventDiskOverallocation,
      max_memory_mib: config.allocation.maxMemoryMib || null,
      max_disk_mib: config.allocation.maxDiskMib || null,
      reserved_memory_mib: config.allocation.reservedMemoryMib,
      reserved_disk_mib: config.allocation.reservedDiskMib,
    },
    disk: {
      mode: config.disk.mode,
      fuse_quota_binary: config.disk.fuseQuotaBinary,
      fuse_quota_binary_sha256: config.disk.fuseQuotaBinarySha256,
      fuse_quota_rescan_interval_seconds: config.disk.fuseQuotaRescanIntervalSeconds,
      project_id_base: config.disk.projectIdBase,
      soft_scanner: {
        scan_interval_seconds: config.disk.softScanner.scanIntervalSeconds,
        max_concurrent_scans: config.disk.softScanner.maxConcurrentScans,
        max_entries_per_scan: config.disk.softScanner.maxEntriesPerScan,
        scan_timeout_seconds: config.disk.softScanner.scanTimeoutSeconds,
        max_consecutive_scan_failures: config.disk.softScanner.maxConsecutiveScanFailures,
        safety_reserve_mib: config.disk.softScanner.safetyReserveMib,
        recovery_percent: config.disk.softScanner.recoveryPercent,
        shutdown_grace_seconds: config.disk.softScanner.shutdownGraceSeconds,
      },
    },
    daemon: {
      engine: config.daemon.engine,
      socket_path: config.daemon.socketPath,
      container_read_only_rootfs: config.daemon.containerReadOnlyRootfs,
      container_userns_mode: config.daemon.containerUsernsMode,
      container_seccomp_profile: config.daemon.containerSeccompProfile,
      container_apparmor_profile: config.daemon.containerApparmorProfile,
      container_security_opts: config.daemon.containerSecurityOpts,
    },
    images: { ...images, allowed },
    paths: config.paths,
  });
  const secrets = values.secrets;
  const hasSecretPatch =
    secrets.s3AccessKeyId ||
    secrets.s3SecretAccessKey ||
    secrets.s3SessionToken ||
    secrets.kopiaRepositoryPassword ||
    secrets.clearS3Credentials ||
    secrets.clearKopiaRepositoryPassword;

  return {
    name: values.name,
    enabled: values.enabled,
    api_url: values.apiUrl.replace(/\/$/, ''),
    public_host: values.publicHost,
    default_cpu_cores: values.defaultCpuCores,
    default_memory_mib: values.defaultMemoryMib,
    default_disk_mib: values.defaultDiskMib,
    configuration,
    ...(hasSecretPatch
      ? {
          configuration_secrets: {
            s3_access_key_id: secrets.s3AccessKeyId || undefined,
            s3_secret_access_key: secrets.s3SecretAccessKey || undefined,
            s3_session_token: secrets.s3SessionToken || undefined,
            kopia_repository_password: secrets.kopiaRepositoryPassword || undefined,
            clear_s3_credentials: secrets.clearS3Credentials,
            clear_kopia_repository_password: secrets.clearKopiaRepositoryPassword,
          },
        }
      : {}),
  };
}

function withoutArtifactPolicy(configuration: Record<string, unknown>): Record<string, unknown> {
  const artifacts = configuration.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) return configuration;
  const {
    stream_exports_only: _streamExportsOnly,
    max_artifacts_per_instance: _maxArtifactsPerInstance,
    ...compatibleArtifacts
  } = artifacts as Record<string, unknown>;
  return { ...configuration, artifacts: compatibleArtifacts };
}
