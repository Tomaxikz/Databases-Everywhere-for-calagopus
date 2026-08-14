import { createElement } from 'react';
import Alert from '@/elements/Alert.tsx';
import type { FieldDef } from '@/elements/form-engine/index.ts';
import translations from '../translations.ts';
import GatewaySetup from './GatewaySetup.tsx';
import type { NodeFormValues, ProtocolKey } from './nodeForm.ts';
import { isLoopbackHost, protocols } from './nodeForm.ts';

const apiSslEnabled = (values: NodeFormValues) => values.config.api.sslEnabled;
const clientCertificateRequired = (values: NodeFormValues) =>
  values.config.api.sslEnabled && values.config.api.requireClientCert;
const publicApiWithoutTls = (values: NodeFormValues) =>
  !isLoopbackHost(values.config.api.host) && !values.config.api.sslEnabled;
const databaseTlsEnabled = (values: NodeFormValues) =>
  protocols.some(([protocol]) => values.config.protocols[protocol].enabled && values.config.protocols[protocol].tls);
const backupsEnabled = (values: NodeFormValues) => values.config.backups.enabled;
const s3Selected = (values: NodeFormValues) =>
  values.config.backups.enabled && values.config.backups.storageDriver === 's3';
const kopiaSelected = (values: NodeFormValues) =>
  values.config.backups.enabled && values.config.backups.storageDriver === 'kopia';
const allocationGuardDisabled = (values: NodeFormValues) =>
  !values.config.allocation.preventCpuOverallocation ||
  !values.config.allocation.preventMemoryOverallocation ||
  !values.config.allocation.preventDiskOverallocation;
const dynamicSchedulerEnabled = (values: NodeFormValues) => values.config.artifacts.scheduler.dynamicLimiterEnabled;
const manualSchedulerEnabled = (values: NodeFormValues) => !values.config.artifacts.scheduler.dynamicLimiterEnabled;
const streamExportsOnly = (values: NodeFormValues) => values.config.artifacts.streamExportsOnly;
const remoteImportEnabled = (values: NodeFormValues) => values.config.security.remoteImport.enabled;
const plaintextRemoteImportEnabled = (values: NodeFormValues) =>
  values.config.security.remoteImport.enabled && values.config.security.remoteImport.allowPlaintext;

function advancedProtocolFields(protocol: ProtocolKey, label: string): FieldDef<NodeFormValues>[] {
  const enabled = (values: NodeFormValues) => values.config.protocols[protocol].enabled;
  return [
    {
      type: 'divider',
      name: `config.protocols.${protocol}.section`,
      label: translations.getTranslations().t('admin.nodeConfig.advancedProtocol', { protocol: label }),
      advanced: true,
      when: enabled,
    },
    {
      type: 'text',
      name: `config.protocols.${protocol}.bindHost`,
      label: translations.getTranslations().t('admin.nodeConfig.bindHost', {}),
      description: translations.getTranslations().t('admin.nodeConfig.bindHostDescription', {}),
      required: true,
      advanced: true,
      when: enabled,
    },
    ...(protocol === 'clickhouse'
      ? ([
          {
            type: 'text',
            name: 'config.protocols.clickhouse.httpBindHost',
            label: translations.getTranslations().t('admin.nodeConfig.clickhouseHttpHost', {}),
            required: true,
            advanced: true,
            when: enabled,
          },
        ] satisfies FieldDef<NodeFormValues>[])
      : []),
    {
      type: 'text',
      name: `config.protocols.${protocol}.image`,
      label: translations.getTranslations().t('admin.nodeConfig.defaultImage', {}),
      description: translations.getTranslations().t('admin.nodeConfig.imageDescription', {}),
      required: true,
      advanced: true,
      when: enabled,
    },
    {
      type: 'tags',
      name: `config.protocols.${protocol}.allowedImages`,
      label: translations.getTranslations().t('admin.nodeConfig.allowedImages', {}),
      description: translations.getTranslations().t('admin.nodeConfig.allowedImagesDescription', {}),
      allowReordering: true,
      allowDuplicates: false,
      colSpan: 'full',
      advanced: true,
      when: enabled,
    },
  ];
}

function buildNodeConfigurationFields(
  editing: boolean,
  hasStoredSecrets: boolean,
  supportsArtifactPolicy: boolean,
): FieldDef<NodeFormValues>[] {
  const { t } = translations.getTranslations();
  return [
    { type: 'divider', name: 'apiSection', label: t('admin.nodeConfig.sections.api', {}) },
    {
      type: 'text',
      name: 'config.api.host',
      label: t('admin.nodeConfig.apiHost', {}),
      description: t('admin.nodeConfig.apiHostDescription', {}),
      required: true,
    },
    {
      type: 'number',
      name: 'config.api.port',
      label: t('admin.nodeConfig.apiPort', {}),
      required: true,
      props: { min: 1, max: 65_535 },
    },
    {
      type: 'tags',
      name: 'config.api.trustedHosts',
      label: t('admin.nodeConfig.trustedHosts', {}),
      description: t('admin.nodeConfig.trustedHostsDescription', {}),
      colSpan: 'full',
      advanced: true,
    },
    {
      type: 'tags',
      name: 'config.api.trustedOrigins',
      label: t('admin.nodeConfig.trustedOrigins', {}),
      description: t('admin.nodeConfig.trustedOriginsDescription', {}),
      colSpan: 'full',
    },
    {
      type: 'switch',
      name: 'config.api.sslEnabled',
      label: t('admin.nodeConfig.apiTls', {}),
      description: t('admin.nodeConfig.apiTlsDescription', {}),
      colSpan: 'full',
    },
    {
      type: 'custom',
      name: 'config.api.plaintextWarning',
      colSpan: 'full',
      when: publicApiWithoutTls,
      render: () => createElement(Alert, { color: 'yellow' }, t('admin.nodeConfig.apiPlaintextWarning', {})),
    },
    {
      type: 'text',
      name: 'config.api.sslCert',
      label: t('admin.nodeConfig.certificatePath', {}),
      required: true,
      when: apiSslEnabled,
    },
    {
      type: 'text',
      name: 'config.api.sslKey',
      label: t('admin.nodeConfig.privateKeyPath', {}),
      required: true,
      when: apiSslEnabled,
    },
    {
      type: 'switch',
      name: 'config.api.requireClientCert',
      label: t('admin.nodeConfig.requireClientCertificate', {}),
      advanced: true,
      when: apiSslEnabled,
    },
    {
      type: 'text',
      name: 'config.api.clientCa',
      label: t('admin.nodeConfig.clientCaPath', {}),
      required: true,
      advanced: true,
      when: clientCertificateRequired,
    },

    { type: 'divider', name: 'runtimeSection', label: t('admin.nodeConfig.sections.runtime', {}) },
    {
      type: 'select',
      name: 'config.daemon.engine',
      label: t('admin.nodeConfig.containerEngine', {}),
      required: true,
      colSpan: 'full',
      options: [
        { value: 'docker', label: 'Docker' },
        { value: 'podman', label: 'Podman' },
      ],
    },
    {
      type: 'text',
      name: 'config.daemon.socketPath',
      label: t('admin.nodeConfig.containerSocket', {}),
      description: t('admin.nodeConfig.containerSocketDescription', {}),
      advanced: true,
    },
    {
      type: 'switch',
      name: 'config.daemon.containerReadOnlyRootfs',
      label: t('admin.nodeConfig.readOnlyRootfs', {}),
      advanced: true,
    },
    {
      type: 'text',
      name: 'config.daemon.containerUsernsMode',
      label: t('admin.nodeConfig.usernsMode', {}),
      advanced: true,
    },
    {
      type: 'text',
      name: 'config.daemon.containerSeccompProfile',
      label: t('admin.nodeConfig.seccompProfile', {}),
      advanced: true,
    },
    {
      type: 'text',
      name: 'config.daemon.containerApparmorProfile',
      label: t('admin.nodeConfig.apparmorProfile', {}),
      advanced: true,
    },
    {
      type: 'tags',
      name: 'config.daemon.containerSecurityOpts',
      label: t('admin.nodeConfig.containerSecurityOptions', {}),
      colSpan: 'full',
      advanced: true,
    },

    {
      type: 'divider',
      name: 'allocationSection',
      label: t('admin.nodeConfig.sections.allocation', {}),
    },
    {
      type: 'size',
      name: 'config.allocation.maxMemoryMib',
      label: t('admin.nodeConfig.maxMemory', {}),
      description: t('admin.nodeConfig.zeroDetectedCapacity', {}),
      mode: 'mb',
      min: 0,
    },
    {
      type: 'size',
      name: 'config.allocation.maxDiskMib',
      label: t('admin.nodeConfig.maxDisk', {}),
      description: t('admin.nodeConfig.zeroDetectedCapacity', {}),
      mode: 'mb',
      min: 0,
    },
    {
      type: 'size',
      name: 'config.allocation.reservedMemoryMib',
      label: t('admin.nodeConfig.reservedMemory', {}),
      mode: 'mb',
      min: 0,
    },
    {
      type: 'size',
      name: 'config.allocation.reservedDiskMib',
      label: t('admin.nodeConfig.reservedDisk', {}),
      mode: 'mb',
      min: 0,
    },
    {
      type: 'divider',
      name: 'allocationGuardSection',
      label: t('admin.nodeConfig.sections.allocationGuards', {}),
      advanced: true,
    },
    {
      type: 'custom',
      name: 'config.allocation.guardWarning',
      colSpan: 'full',
      advanced: true,
      when: allocationGuardDisabled,
      render: () =>
        createElement(
          Alert,
          { color: 'red', title: t('admin.nodeConfig.allocationGuardWarningTitle', {}) },
          t('admin.nodeConfig.allocationGuardWarning', {}),
        ),
    },
    {
      type: 'switch',
      name: 'config.allocation.preventCpuOverallocation',
      label: t('admin.nodeConfig.preventCpuOverallocation', {}),
      description: t('admin.nodeConfig.preventCpuOverallocationDescription', {}),
      colSpan: 'full',
      advanced: true,
    },
    {
      type: 'switch',
      name: 'config.allocation.preventMemoryOverallocation',
      label: t('admin.nodeConfig.preventMemoryOverallocation', {}),
      description: t('admin.nodeConfig.preventMemoryOverallocationDescription', {}),
      colSpan: 'full',
      advanced: true,
    },
    {
      type: 'switch',
      name: 'config.allocation.preventDiskOverallocation',
      label: t('admin.nodeConfig.preventDiskOverallocation', {}),
      description: t('admin.nodeConfig.preventDiskOverallocationDescription', {}),
      colSpan: 'full',
      advanced: true,
    },

    { type: 'divider', name: 'protocolSection', label: t('admin.nodeConfig.sections.protocols', {}) },
    {
      type: 'custom',
      name: 'config.protocols.gatewaySetup',
      colSpan: 'full',
      render: (form) => createElement(GatewaySetup, { form }),
    },
    {
      type: 'text',
      name: 'config.databaseTls.cert',
      label: t('admin.nodeConfig.databaseCertificatePath', {}),
      required: true,
      when: databaseTlsEnabled,
    },
    ...protocols.flatMap(([protocol, label]) => advancedProtocolFields(protocol, label)),
    {
      type: 'text',
      name: 'config.databaseTls.key',
      label: t('admin.nodeConfig.databasePrivateKeyPath', {}),
      required: true,
      when: databaseTlsEnabled,
    },

    {
      type: 'divider',
      name: 'backupSection',
      label: t('admin.nodeConfig.sections.backups', {}),
      switchName: 'config.backups.enabled',
      switchLabel: t('admin.nodeConfig.automatedBackups', {}),
    },
    {
      type: 'number',
      name: 'config.backups.intervalMinutes',
      label: t('admin.nodeConfig.backupInterval', {}),
      description: t('admin.nodeConfig.automatedBackupsDescription', {}),
      required: true,
      props: { min: 1, max: 525_600 },
      when: backupsEnabled,
    },
    {
      type: 'switch',
      name: 'config.backups.runOnStartup',
      label: t('admin.nodeConfig.backupOnStartup', {}),
      advanced: true,
      when: backupsEnabled,
    },
    {
      type: 'number',
      name: 'config.backups.retentionKeepLatestPerInstance',
      label: t('admin.nodeConfig.backupKeepLatest', {}),
      props: { min: 1, max: 100_000 },
      when: backupsEnabled,
    },
    {
      type: 'number',
      name: 'config.backups.retentionMaxAgeDays',
      label: t('admin.nodeConfig.backupMaxAge', {}),
      props: { min: 0, max: 36_500 },
      when: backupsEnabled,
    },
    {
      type: 'select',
      name: 'config.backups.storageDriver',
      label: t('admin.nodeConfig.backupStorageDriver', {}),
      required: true,
      options: [
        { value: 'local', label: t('admin.nodeConfig.storageLocal', {}) },
        { value: 's3', label: 'S3' },
        { value: 'kopia', label: 'Kopia' },
      ],
      when: backupsEnabled,
    },
    {
      type: 'text',
      name: 'config.backups.s3.bucket',
      label: t('admin.nodeConfig.s3Bucket', {}),
      required: true,
      when: s3Selected,
    },
    {
      type: 'text',
      name: 'config.backups.s3.region',
      label: t('admin.nodeConfig.s3Region', {}),
      required: true,
      when: s3Selected,
    },
    {
      type: 'text',
      name: 'config.backups.s3.endpoint',
      label: t('admin.nodeConfig.s3Endpoint', {}),
      when: s3Selected,
    },
    {
      type: 'text',
      name: 'config.backups.s3.prefix',
      label: t('admin.nodeConfig.s3Prefix', {}),
      when: s3Selected,
    },
    {
      type: 'password',
      name: 'secrets.s3AccessKeyId',
      label: t('admin.nodeConfig.s3AccessKey', {}),
      description: t('admin.nodeConfig.secretDescription', {}),
      when: s3Selected,
    },
    {
      type: 'password',
      name: 'secrets.s3SecretAccessKey',
      label: t('admin.nodeConfig.s3SecretKey', {}),
      description: t('admin.nodeConfig.secretDescription', {}),
      when: s3Selected,
    },
    {
      type: 'password',
      name: 'secrets.s3SessionToken',
      label: t('admin.nodeConfig.s3SessionToken', {}),
      description: t('admin.nodeConfig.secretDescription', {}),
      when: s3Selected,
    },
    {
      type: 'switch',
      name: 'secrets.clearS3Credentials',
      label: t('admin.nodeConfig.clearS3Credentials', {}),
      advanced: true,
      when: (values) => editing && hasStoredSecrets && s3Selected(values),
    },
    {
      type: 'switch',
      name: 'config.backups.s3.pathStyle',
      label: t('admin.nodeConfig.s3PathStyle', {}),
      when: s3Selected,
    },
    {
      type: 'switch',
      name: 'config.backups.s3.allowHttp',
      label: t('admin.nodeConfig.s3AllowHttp', {}),
      advanced: true,
      when: s3Selected,
    },
    {
      type: 'number',
      name: 'config.backups.s3.requestTimeoutSeconds',
      label: t('admin.nodeConfig.storageTimeout', {}),
      props: { min: 1, max: 86_400 },
      advanced: true,
      when: s3Selected,
    },
    {
      type: 'number',
      name: 'config.backups.s3.maxRetries',
      label: t('admin.nodeConfig.storageRetries', {}),
      props: { min: 0, max: 10 },
      advanced: true,
      when: s3Selected,
    },
    {
      type: 'text',
      name: 'config.backups.kopia.executable',
      label: t('admin.nodeConfig.kopiaExecutable', {}),
      required: true,
      when: kopiaSelected,
    },
    {
      type: 'text',
      name: 'config.backups.kopia.configFile',
      label: t('admin.nodeConfig.kopiaConfig', {}),
      when: kopiaSelected,
    },
    {
      type: 'password',
      name: 'secrets.kopiaRepositoryPassword',
      label: t('admin.nodeConfig.kopiaPassword', {}),
      description: t('admin.nodeConfig.secretDescription', {}),
      when: kopiaSelected,
    },
    {
      type: 'switch',
      name: 'secrets.clearKopiaRepositoryPassword',
      label: t('admin.nodeConfig.clearKopiaPassword', {}),
      advanced: true,
      when: (values) => editing && hasStoredSecrets && kopiaSelected(values),
    },
    {
      type: 'number',
      name: 'config.backups.kopia.operationTimeoutSeconds',
      label: t('admin.nodeConfig.storageTimeout', {}),
      props: { min: 1, max: 86_400 },
      advanced: true,
      when: kopiaSelected,
    },
    {
      type: 'switch',
      name: 'config.backups.browsing.enabled',
      label: t('admin.nodeConfig.backupBrowsing', {}),
      when: backupsEnabled,
    },
    {
      type: 'number',
      name: 'config.backups.browsing.maxObjects',
      label: t('admin.nodeConfig.maxCatalogObjects', {}),
      props: { min: 1, max: 1_000 },
      advanced: true,
      when: backupsEnabled,
    },
    {
      type: 'number',
      name: 'config.backups.browsing.maxPreviewObjects',
      label: t('admin.nodeConfig.maxPreviewObjects', {}),
      props: { min: 0, max: 1_000 },
      advanced: true,
      when: backupsEnabled,
    },
    {
      type: 'number',
      name: 'config.backups.browsing.previewRowsPerObject',
      label: t('admin.nodeConfig.previewRows', {}),
      props: { min: 0, max: 100 },
      advanced: true,
      when: backupsEnabled,
    },
    {
      type: 'number',
      name: 'config.backups.browsing.maxRowBytes',
      label: t('admin.nodeConfig.maxRowBytes', {}),
      props: { min: 256, max: 16_384 },
      advanced: true,
      when: backupsEnabled,
    },
    {
      type: 'number',
      name: 'config.backups.browsing.maxCatalogBytes',
      label: t('admin.nodeConfig.maxCatalogBytes', {}),
      props: { min: 65_536, max: 1_048_576 },
      advanced: true,
      when: backupsEnabled,
    },

    { type: 'divider', name: 'artifactSection', label: t('admin.nodeConfig.sections.artifacts', {}), advanced: true },
    ...(supportsArtifactPolicy
      ? ([
          {
            type: 'switch',
            name: 'config.artifacts.streamExportsOnly',
            label: t('admin.nodeConfig.streamExportsOnly', {}),
            description: t('admin.nodeConfig.streamExportsOnlyDescription', {}),
            colSpan: 'full',
            advanced: true,
          },
          {
            type: 'number',
            name: 'config.artifacts.maxArtifactsPerInstance',
            label: t('admin.nodeConfig.maxArtifactsPerInstance', {}),
            description: t('admin.nodeConfig.maxArtifactsPerInstanceDescription', {}),
            required: true,
            props: { min: 1, max: 10_000 },
            advanced: true,
          },
          {
            type: 'custom',
            name: 'config.artifacts.streamExportsOnlyWarning',
            colSpan: 'full',
            advanced: true,
            when: streamExportsOnly,
            render: () =>
              createElement(
                Alert,
                { color: 'yellow', title: t('admin.nodeConfig.streamExportsOnlyWarningTitle', {}) },
                t('admin.nodeConfig.streamExportsOnlyWarning', {}),
              ),
          },
        ] satisfies FieldDef<NodeFormValues>[])
      : []),
    {
      type: 'number',
      name: 'config.artifacts.retentionKeepLatest',
      label: t('admin.nodeConfig.artifactKeepLatest', {}),
      props: { min: 1, max: 100_000 },
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.retentionMaxAgeDays',
      label: t('admin.nodeConfig.artifactMaxAge', {}),
      props: { min: 0, max: 36_500 },
      advanced: true,
    },
    {
      type: 'divider',
      name: 'importUploadSection',
      label: t('admin.nodeConfig.importUploads', {}),
      advanced: true,
    },
    {
      type: 'custom',
      name: 'config.artifacts.importUploadNotice',
      colSpan: 'full',
      advanced: true,
      render: () =>
        createElement(
          Alert,
          { color: 'blue', title: t('admin.nodeConfig.importUploadsNoticeTitle', {}) },
          t('admin.nodeConfig.importUploadsNotice', {}),
        ),
    },
    {
      type: 'size',
      name: 'config.artifacts.importUploadMaxBytes',
      label: t('admin.nodeConfig.importUploadMaxBytes', {}),
      description: t('admin.nodeConfig.importUploadMaxBytesDescription', {}),
      mode: 'b',
      min: 1,
      required: true,
      advanced: true,
    },
    {
      type: 'size',
      name: 'config.artifacts.importUploadMaxTotalBytes',
      label: t('admin.nodeConfig.importUploadMaxTotalBytes', {}),
      description: t('admin.nodeConfig.importUploadMaxTotalBytesDescription', {}),
      mode: 'b',
      min: 1,
      required: true,
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.importUploadMaxPerInstance',
      label: t('admin.nodeConfig.importUploadMaxPerInstance', {}),
      props: { min: 1, max: 64 },
      required: true,
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.importUploadMaxConcurrent',
      label: t('admin.nodeConfig.importUploadMaxConcurrent', {}),
      props: { min: 1, max: 32 },
      required: true,
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.importUploadTtlHours',
      label: t('admin.nodeConfig.importUploadTtlHours', {}),
      description: t('admin.nodeConfig.importUploadTtlHoursDescription', {}),
      props: { min: 1, max: 168 },
      required: true,
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.importUploadTimeoutSeconds',
      label: t('admin.nodeConfig.importUploadTimeout', {}),
      props: { min: 60, max: 86_400 },
      required: true,
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.importUploadIdleTimeoutSeconds',
      label: t('admin.nodeConfig.importUploadIdleTimeout', {}),
      props: { min: 5, max: 300 },
      required: true,
      advanced: true,
    },
    {
      type: 'divider',
      name: 'importExportSchedulerSection',
      label: t('admin.nodeConfig.importExportScheduler', {}),
      advanced: true,
    },
    {
      type: 'custom',
      name: 'config.artifacts.scheduler.explanation',
      colSpan: 'full',
      advanced: true,
      render: () =>
        createElement(
          Alert,
          { color: 'blue', title: t('admin.nodeConfig.schedulerNoticeTitle', {}) },
          t('admin.nodeConfig.schedulerNotice', {}),
        ),
    },
    {
      type: 'switch',
      name: 'config.artifacts.scheduler.dynamicLimiterEnabled',
      label: t('admin.nodeConfig.schedulerDynamicLimiter', {}),
      description: t('admin.nodeConfig.schedulerDynamicLimiterDescription', {}),
      colSpan: 'full',
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.scheduler.maxQueuedJobs',
      label: t('admin.nodeConfig.schedulerMaxQueuedJobs', {}),
      props: { min: 64, max: 8_192 },
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.scheduler.maxQueuedJobsPerInstance',
      label: t('admin.nodeConfig.schedulerMaxQueuedJobsPerDatabase', {}),
      props: { min: 1, max: 256 },
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.scheduler.manualMaxActiveJobs',
      label: t('admin.nodeConfig.schedulerManualActiveJobs', {}),
      description: t('admin.nodeConfig.schedulerManualActiveJobsDescription', {}),
      props: { min: 1, max: 1_024 },
      when: manualSchedulerEnabled,
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.scheduler.dynamicMaxActiveJobs',
      label: t('admin.nodeConfig.schedulerDynamicActiveJobs', {}),
      props: { min: 1, max: 1_024 },
      when: dynamicSchedulerEnabled,
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.scheduler.dynamicMemoryBudgetMib',
      label: t('admin.nodeConfig.schedulerMemoryBudget', {}),
      description: t('admin.nodeConfig.schedulerMemoryBudgetDescription', {}),
      props: { min: 0, max: 16_777_216 },
      when: dynamicSchedulerEnabled,
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.scheduler.dynamicIoBudgetMib',
      label: t('admin.nodeConfig.schedulerIoBudget', {}),
      description: t('admin.nodeConfig.schedulerIoBudgetDescription', {}),
      props: { min: 0, max: 67_108_864 },
      when: dynamicSchedulerEnabled,
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.scheduler.dynamicCpuUnits',
      label: t('admin.nodeConfig.schedulerCpuUnits', {}),
      description: t('admin.nodeConfig.schedulerCpuUnitsDescription', {}),
      props: { min: 0, max: 65_536 },
      when: dynamicSchedulerEnabled,
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.scheduler.starvationTimeoutSeconds',
      label: t('admin.nodeConfig.schedulerStarvationTimeout', {}),
      description: t('admin.nodeConfig.schedulerStarvationTimeoutDescription', {}),
      props: { min: 1, max: 3_600 },
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.artifacts.scheduler.maxBypass',
      label: t('admin.nodeConfig.schedulerMaxBypass', {}),
      props: { min: 0, max: 1_024 },
      advanced: true,
    },

    { type: 'divider', name: 'pathsSection', label: t('admin.nodeConfig.sections.paths', {}), advanced: true },
    ...(
      [
        ['data', 'Data'],
        ['metadata', 'Metadata'],
        ['volumes', 'Volumes'],
        ['backups', 'Backups'],
        ['sockets', 'Sockets'],
        ['locks', 'Locks'],
        ['logs', 'Logs'],
        ['artifacts', 'Artifacts'],
        ['exports', 'Exports'],
        ['imports', 'Imports'],
        ['fuse', 'FUSE'],
        ['tmp', 'Temporary files'],
      ] as const
    ).map(
      ([path, label]) =>
        ({
          type: 'text',
          name: `config.paths.${path}`,
          label: `${label} ${t('admin.nodeConfig.pathSuffix', {})}`,
          required: true,
          advanced: true,
        }) satisfies FieldDef<NodeFormValues>,
    ),

    { type: 'divider', name: 'securitySection', label: t('admin.nodeConfig.sections.security', {}), advanced: true },
    {
      type: 'number',
      name: 'config.security.apiBodyLimitBytes',
      label: t('admin.nodeConfig.apiBodyLimit', {}),
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.security.apiRateLimitPerMinute',
      label: t('admin.nodeConfig.apiRateLimit', {}),
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.security.dbConnectionLimitPerMinute',
      label: t('admin.nodeConfig.databaseRateLimit', {}),
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.security.pidsLimit',
      label: t('admin.nodeConfig.pidsLimit', {}),
      advanced: true,
    },
    {
      type: 'divider',
      name: 'protocolPidsSection',
      label: t('admin.nodeConfig.protocolPids', {}),
      advanced: true,
    },
    ...protocols.map(
      ([protocol, label]) =>
        ({
          type: 'number',
          name: `config.security.pidsLimits.${protocol}`,
          label: t('admin.nodeConfig.protocolPidsLimit', { protocol: label }),
          description: t('admin.nodeConfig.protocolPidsLimitDescription', {}),
          props: { min: 0 },
          advanced: true,
        }) satisfies FieldDef<NodeFormValues>,
    ),
    {
      type: 'divider',
      name: 'remoteImportSection',
      label: t('admin.nodeConfig.remoteImport', {}),
      advanced: true,
    },
    {
      type: 'switch',
      name: 'config.security.remoteImport.enabled',
      label: t('admin.nodeConfig.remoteImportEnabled', {}),
      description: t('admin.nodeConfig.remoteImportEnabledDescription', {}),
      colSpan: 'full',
      advanced: true,
    },
    {
      type: 'switch',
      name: 'config.security.remoteImport.allowPlaintext',
      label: t('admin.nodeConfig.remoteImportAllowPlaintext', {}),
      description: t('admin.nodeConfig.remoteImportAllowPlaintextDescription', {}),
      colSpan: 'full',
      when: remoteImportEnabled,
      advanced: true,
    },
    {
      type: 'custom',
      name: 'config.security.remoteImport.plaintextWarning',
      colSpan: 'full',
      when: plaintextRemoteImportEnabled,
      advanced: true,
      render: () =>
        createElement(
          Alert,
          { color: 'yellow', title: t('admin.nodeConfig.remoteImportPlaintextWarningTitle', {}) },
          t('admin.nodeConfig.remoteImportPlaintextWarning', {}),
        ),
    },
    {
      type: 'tags',
      name: 'config.security.remoteImport.allowedPrivateHosts',
      label: t('admin.nodeConfig.remoteImportPrivateHosts', {}),
      description: t('admin.nodeConfig.remoteImportPrivateHostsDescription', {}),
      placeholder: t('admin.nodeConfig.remoteImportPrivateHostsPlaceholder', {}),
      allowDuplicates: false,
      colSpan: 'full',
      when: remoteImportEnabled,
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.security.remoteImport.maxConcurrentJobs',
      label: t('admin.nodeConfig.remoteImportConcurrency', {}),
      props: { min: 1, max: 64 },
      when: remoteImportEnabled,
      required: true,
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.security.remoteImport.connectTimeoutSeconds',
      label: t('admin.nodeConfig.remoteImportConnectTimeout', {}),
      props: { min: 1, max: 300 },
      when: remoteImportEnabled,
      required: true,
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.security.remoteImport.operationTimeoutSeconds',
      label: t('admin.nodeConfig.remoteImportOperationTimeout', {}),
      props: { min: 1, max: 86_400 },
      when: remoteImportEnabled,
      required: true,
      advanced: true,
    },
    {
      type: 'size',
      name: 'config.security.remoteImport.maxStagedBytes',
      label: t('admin.nodeConfig.remoteImportMaxStagedBytes', {}),
      description: t('admin.nodeConfig.remoteImportMaxStagedBytesDescription', {}),
      mode: 'b',
      min: 1,
      when: remoteImportEnabled,
      required: true,
      advanced: true,
    },
    {
      type: 'switch',
      name: 'config.debug',
      label: t('admin.nodeConfig.debug', {}),
      advanced: true,
    },

    { type: 'divider', name: 'diskSection', label: t('admin.nodeConfig.sections.disk', {}) },
    {
      type: 'select',
      name: 'config.disk.mode',
      label: t('admin.nodeConfig.diskMode', {}),
      description: t('admin.nodeConfig.diskModeDescription', {}),
      options: [
        { value: 'auto', label: t('admin.nodeConfig.diskModeAuto', {}) },
        { value: 'project_quota', label: t('admin.nodeConfig.diskModeProjectQuota', {}) },
        { value: 'fuse_quota', label: t('admin.nodeConfig.diskModeFuseQuota', {}) },
        { value: 'soft_scanner', label: t('admin.nodeConfig.diskModeSoftScanner', {}) },
      ],
      colSpan: 'full',
      required: true,
    },
    {
      type: 'text',
      name: 'config.disk.fuseQuotaBinary',
      label: t('admin.nodeConfig.fuseQuotaBinary', {}),
      advanced: true,
    },
    {
      type: 'text',
      name: 'config.disk.fuseQuotaBinarySha256',
      label: t('admin.nodeConfig.fuseQuotaSha256', {}),
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.disk.fuseQuotaRescanIntervalSeconds',
      label: t('admin.nodeConfig.fuseRescanInterval', {}),
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.disk.projectIdBase',
      label: t('admin.nodeConfig.projectIdBase', {}),
      advanced: true,
    },
    {
      type: 'divider',
      name: 'softScannerSection',
      label: t('admin.nodeConfig.softScanner', {}),
      advanced: true,
    },
    {
      type: 'custom',
      name: 'config.disk.softScannerNotice',
      colSpan: 'full',
      advanced: true,
      render: () => createElement(Alert, { color: 'blue' }, t('admin.nodeConfig.softScannerDescription', {})),
    },
    {
      type: 'number',
      name: 'config.disk.softScanner.scanIntervalSeconds',
      label: t('admin.nodeConfig.softScannerScanInterval', {}),
      props: { min: 1, max: 3_600 },
      advanced: true,
    },
    {
      type: 'switch',
      name: 'config.disk.softScanner.useInotify',
      label: t('admin.nodeConfig.softScannerUseInotify', {}),
      description: t('admin.nodeConfig.softScannerUseInotifyDescription', {}),
      colSpan: 'full',
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.disk.softScanner.fullScanIntervalSeconds',
      label: t('admin.nodeConfig.softScannerFullScanInterval', {}),
      description: t('admin.nodeConfig.softScannerFullScanIntervalDescription', {}),
      props: { min: 1, max: 3_600 },
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.disk.softScanner.inotifyDebounceMilliseconds',
      label: t('admin.nodeConfig.softScannerInotifyDebounce', {}),
      props: { min: 1, max: 60_000 },
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.disk.softScanner.maxDirtyPathsPerInstance',
      label: t('admin.nodeConfig.softScannerDirtyPaths', {}),
      props: { min: 1, max: 65_536 },
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.disk.softScanner.maxConcurrentScans',
      label: t('admin.nodeConfig.softScannerConcurrency', {}),
      props: { min: 1, max: 64 },
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.disk.softScanner.maxEntriesPerScan',
      label: t('admin.nodeConfig.softScannerEntries', {}),
      props: { min: 1, max: 10_000_000 },
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.disk.softScanner.scanTimeoutSeconds',
      label: t('admin.nodeConfig.softScannerTimeout', {}),
      props: { min: 1, max: 3_600 },
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.disk.softScanner.maxConsecutiveScanFailures',
      label: t('admin.nodeConfig.softScannerFailures', {}),
      props: { min: 1, max: 10 },
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.disk.softScanner.safetyReserveMib',
      label: t('admin.nodeConfig.softScannerReserve', {}),
      props: { min: 0 },
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.disk.softScanner.recoveryPercent',
      label: t('admin.nodeConfig.softScannerRecovery', {}),
      props: { min: 1, max: 99 },
      advanced: true,
    },
    {
      type: 'number',
      name: 'config.disk.softScanner.shutdownGraceSeconds',
      label: t('admin.nodeConfig.softScannerShutdownGrace', {}),
      props: { min: 1, max: 300 },
      advanced: true,
    },
  ];
}

export interface NodeConfigurationFieldGroups {
  api: FieldDef<NodeFormValues>[];
  runtime: FieldDef<NodeFormValues>[];
  allocation: FieldDef<NodeFormValues>[];
  gateways: FieldDef<NodeFormValues>[];
  backups: FieldDef<NodeFormValues>[];
  artifacts: FieldDef<NodeFormValues>[];
  paths: FieldDef<NodeFormValues>[];
  security: FieldDef<NodeFormValues>[];
  disk: FieldDef<NodeFormValues>[];
}

const sections = [
  ['api', 'apiSection'],
  ['runtime', 'runtimeSection'],
  ['allocation', 'allocationSection'],
  ['gateways', 'protocolSection'],
  ['backups', 'backupSection'],
  ['artifacts', 'artifactSection'],
  ['paths', 'pathsSection'],
  ['security', 'securitySection'],
  ['disk', 'diskSection'],
] as const;

export function nodeConfigurationFieldGroups(
  editing: boolean,
  hasStoredSecrets: boolean,
  supportsArtifactPolicy = true,
): NodeConfigurationFieldGroups {
  const fields = buildNodeConfigurationFields(editing, hasStoredSecrets, supportsArtifactPolicy);
  const groups = {} as NodeConfigurationFieldGroups;
  sections.forEach(([key, marker], index) => {
    const start = fields.findIndex((field) => field.name === marker);
    const nextMarker = sections[index + 1]?.[1];
    const end = nextMarker ? fields.findIndex((field) => field.name === nextMarker) : fields.length;
    groups[key] = fields.slice(start, end);
  });
  return groups;
}
