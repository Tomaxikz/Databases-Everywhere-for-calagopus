import { faExternalLink } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import Anchor from '@/elements/Anchor.tsx';
import Button from '@/elements/Button.tsx';
import { AdminCan } from '@/elements/Can.tsx';
import AdminContentContainer from '@/elements/containers/AdminContentContainer.tsx';
import {
  AdvancedModeToggle,
  type FieldDef,
  FormEngine,
  useAdvancedMode,
  useFormEngine,
} from '@/elements/form-engine/index.ts';
import Group from '@/elements/Group.tsx';
import Switch from '@/elements/input/Switch.tsx';
import Stack from '@/elements/Stack.tsx';
import Text from '@/elements/Text.tsx';
import { useToast } from '@/providers/ToastProvider.tsx';
import { useTranslations } from '@/providers/TranslationProvider.tsx';
import { createNode, updateNode } from '../api/client.ts';
import { dbevQueryKeys } from '../api/queryKeys.ts';
import type { NodeCredentials, NodeRecord } from '../api/types.ts';
import translations from '../translations.ts';
import { nodeSupportsArtifactPolicy } from './artifactPolicy.ts';
import NodeCredentialsModal from './NodeCredentialsModal.tsx';
import NodeSetupReview from './NodeSetupReview.tsx';
import NodeSetupWizard, { type NodeSetupStep } from './NodeSetupWizard.tsx';
import { nodeConfigurationFieldGroups } from './nodeConfigurationFields.ts';
import {
  createNodeFormSchema,
  hasUnsupportedSelfUpgrade,
  initialNodeFormValues,
  type NodeFormValues,
  toNodeInput,
} from './nodeForm.ts';

const BASICS_STEP = 0;
const CONTAINERS_STEP = 1;
const GATEWAYS_STEP = 2;
const BACKUPS_STEP = 3;
const SYSTEM_STEP = 4;
const REVIEW_STEP = 5;

function stepForValidationPath(path: string) {
  if (path.startsWith('config.protocols') || path.startsWith('config.databaseTls')) return GATEWAYS_STEP;
  if (path.startsWith('config.backups') || path.startsWith('config.artifacts') || path.startsWith('secrets.')) {
    return BACKUPS_STEP;
  }
  if (path.startsWith('default') || path.startsWith('config.daemon') || path.startsWith('config.allocation')) {
    return CONTAINERS_STEP;
  }
  if (
    path.startsWith('config.api') ||
    path.startsWith('config.paths') ||
    path.startsWith('config.security') ||
    path.startsWith('config.disk') ||
    path === 'config.debug'
  ) {
    return SYSTEM_STEP;
  }
  return BASICS_STEP;
}

export default function NodeCreateOrUpdate({ contextNode }: { contextNode?: NodeRecord }) {
  const { t } = translations.useTranslations();
  const { t: tBase } = useTranslations();
  const [advancedMode] = useAdvancedMode();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [credentials, setCredentials] = useState<NodeCredentials | null>(null);
  const [createdNode, setCreatedNode] = useState<NodeRecord | null>(null);
  const [stayAfterCreate, setStayAfterCreate] = useState(false);
  const [activeStep, setActiveStep] = useState(BASICS_STEP);
  const supportsArtifactPolicy = !contextNode || nodeSupportsArtifactPolicy(contextNode);
  const importedSelfUpgrade = hasUnsupportedSelfUpgrade(contextNode?.configuration);

  useEffect(() => setActiveStep(BASICS_STEP), [contextNode?.uuid]);

  const schema = useMemo(
    () =>
      createNodeFormSchema({
        apiTlsRequired: t('admin.nodeConfig.apiTlsRequired', {}),
        clientCaRequired: t('admin.nodeConfig.clientCaRequired', {}),
        clientCertificatesRequireTls: t('admin.nodeConfig.clientCertificatesRequireTls', {}),
        databaseTlsRequired: t('admin.nodeConfig.databaseTlsRequired', {}),
        s3BucketRequired: t('admin.nodeConfig.s3BucketRequired', {}),
        s3HttpRequiresOptIn: t('admin.nodeConfig.s3HttpRequiresOptIn', {}),
        clickhousePortsUnique: t('admin.nodeConfig.clickhousePortsUnique', {}),
        gatewayBindUnique: t('admin.nodeConfig.gatewayBindUnique', {}),
        gatewayProtocolRequired: t('admin.nodeConfig.gatewayProtocolRequired', {}),
        mysqlNineUnsupported: t('admin.nodeConfig.mysqlNineUnsupported', {}),
        schedulerLimitExceedsQueue: t('admin.nodeConfig.schedulerLimitExceedsQueue', {}),
        backupPreviewExceedsObjects: t('admin.nodeConfig.backupPreviewExceedsObjects', {}),
        remotePrivateHostInvalid: t('admin.nodeConfig.remotePrivateHostInvalid', {}),
        remoteOperationTimeoutTooShort: t('admin.nodeConfig.remoteOperationTimeoutTooShort', {}),
        uploadTotalSmallerThanFile: t('admin.nodeConfig.uploadTotalSmallerThanFile', {}),
        uploadIdleTimeoutTooLong: t('admin.nodeConfig.uploadIdleTimeoutTooLong', {}),
      }),
    [t],
  );
  const form = useFormEngine<NodeFormValues>('admin.databasesEverywhere.nodes.createOrUpdate', {
    schema,
    initialValues: initialNodeFormValues(contextNode),
    validateInputOnBlur: true,
  });

  if (contextNode?.mutations_allowed === false && contextNode.cached_system !== null) {
    return (
      <AdminContentContainer title={t('admin.editTitle', {})} titleOrder={2}>
        <Stack>
          <Alert color='yellow' title={t('admin.readOnlyCompatibilityMode', {})}>
            {contextNode.mutation_block_reason || t('admin.readOnlyCompatibilityDescription', {})}
          </Alert>
          <Group justify='flex-end'>
            <Button variant='default' onClick={() => navigate(`/admin/databases-everywhere?node=${contextNode.uuid}`)}>
              {tBase('common.button.back', {})}
            </Button>
          </Group>
        </Stack>
      </AdminContentContainer>
    );
  }

  const identityFields: FieldDef<NodeFormValues>[] = [
    {
      type: 'text',
      name: 'name',
      label: t('admin.nodeName', {}),
      description: t('admin.nodeNameDescription', {}),
      required: true,
    },
    {
      type: 'text',
      name: 'apiUrl',
      label: t('admin.apiUrl', {}),
      description: t('admin.apiUrlDescription', {}),
      required: true,
    },
    {
      type: 'text',
      name: 'publicHost',
      label: t('admin.publicHost', {}),
      description: t('admin.publicHostDescription', {}),
      required: true,
    },
    {
      type: 'custom',
      name: 'enabled',
      render: (fieldForm) => (
        <div className='flex h-full flex-col'>
          <Text size='sm' fw={500}>
            {t('admin.enabled', {})}
          </Text>
          <Text size='xs' c='dimmed' mt={2}>
            {t('admin.enabledDescription', {})}
          </Text>
          <Switch
            mt='sm'
            aria-label={t('admin.enabled', {})}
            key={fieldForm.key('enabled')}
            {...fieldForm.getInputProps('enabled', { type: 'checkbox' })}
          />
        </div>
      ),
    },
  ];

  const resourceFields: FieldDef<NodeFormValues>[] = [
    { type: 'divider', name: 'resourceDefaults', label: t('admin.defaults', {}) },
    {
      type: 'number',
      name: 'defaultCpuCores',
      label: t('admin.cpu', {}),
      description: t('admin.cpuDescription', {}),
      required: true,
      props: { min: 0.01, max: 1024, decimalScale: 2, step: 0.25 },
    },
    {
      type: 'size',
      name: 'defaultMemoryMib',
      label: t('admin.memory', {}),
      description: t('admin.memoryDescription', {}),
      required: true,
      mode: 'mb',
      min: 1,
    },
    {
      type: 'size',
      name: 'defaultDiskMib',
      label: t('admin.disk', {}),
      description: t('admin.diskDescription', {}),
      required: true,
      mode: 'mb',
      min: 1,
    },
  ];

  const configurationFields = nodeConfigurationFieldGroups(
    Boolean(contextNode),
    contextNode?.has_configuration_secrets ?? false,
    supportsArtifactPolicy,
  );
  const steps: Array<NodeSetupStep & { fields?: FieldDef<NodeFormValues>[] }> = [
    {
      label: t('admin.wizard.steps.basics.label', {}),
      description: t('admin.wizard.steps.basics.description', {}),
      fields: identityFields,
    },
    {
      label: t('admin.wizard.steps.containers.label', {}),
      description: t('admin.wizard.steps.containers.description', {}),
      fields: [...resourceFields, ...configurationFields.runtime, ...configurationFields.allocation],
    },
    {
      label: t('admin.wizard.steps.gateways.label', {}),
      description: t('admin.wizard.steps.gateways.description', {}),
      fields: configurationFields.gateways,
    },
    {
      label: t('admin.wizard.steps.backups.label', {}),
      description: t('admin.wizard.steps.backups.description', {}),
      fields: [...configurationFields.backups, ...configurationFields.artifacts],
    },
    {
      label: t('admin.wizard.steps.system.label', {}),
      description: t('admin.wizard.steps.system.description', {}),
      fields: [
        ...configurationFields.api,
        ...configurationFields.paths,
        ...configurationFields.security,
        ...configurationFields.disk,
      ],
    },
    {
      label: t('admin.wizard.steps.review.label', {}),
      description: t('admin.wizard.steps.review.description', {}),
    },
  ];

  const submit = async (stay: boolean) => {
    const validation = form.validate();
    if (validation.hasErrors) {
      const errorSteps = Object.keys(validation.errors).map(stepForValidationPath);
      setActiveStep(errorSteps.length > 0 ? Math.min(...errorSteps) : BASICS_STEP);
      addToast(t('admin.wizard.validationError', {}), 'error');
      return;
    }

    setLoading(true);
    try {
      const values = schema.parse(form.getValues());
      const input = toNodeInput(values, contextNode?.configuration, { includeArtifactPolicy: supportsArtifactPolicy });
      if (contextNode) {
        await updateNode(contextNode.uuid, input);
        await queryClient.invalidateQueries({ queryKey: dbevQueryKeys.adminNodes() });
        addToast(t('admin.nodeUpdated', {}), 'success');
        navigate(`/admin/databases-everywhere?node=${contextNode.uuid}`);
      } else {
        const created = await createNode(input);
        await queryClient.invalidateQueries({ queryKey: dbevQueryKeys.adminNodes() });
        setStayAfterCreate(stay);
        setCreatedNode(created.node);
        setCredentials(created.credentials);
        addToast(t('admin.nodeCreated', {}), 'success');
      }
    } catch (error) {
      addToast(httpErrorToHuman(error), 'error');
    } finally {
      setLoading(false);
    }
  };

  const closeCredentials = () => {
    setCredentials(null);
    if (!stayAfterCreate && createdNode) {
      navigate(`/admin/databases-everywhere?node=${createdNode.uuid}`);
    }
    setCreatedNode(null);
  };

  const goToNextStep = () => {
    const validation = form.validate();
    const currentStepHasErrors = Object.keys(validation.errors).some(
      (path) => stepForValidationPath(path) === activeStep,
    );
    if (currentStepHasErrors) {
      addToast(t('admin.wizard.stepValidationError', {}), 'error');
      return;
    }
    setActiveStep(Math.min(activeStep + 1, REVIEW_STEP));
  };

  const activeFields = steps[activeStep]?.fields ?? [];
  const wizardFooter = (
    <Group justify='space-between' wrap='wrap'>
      <Group gap='sm'>
        {activeStep > BASICS_STEP && (
          <Button type='button' variant='default' disabled={loading} onClick={() => setActiveStep(activeStep - 1)}>
            {tBase('common.button.back', {})}
          </Button>
        )}
        <Anchor href='https://github.com/Tomaxikz/DatabasesEverywhere' target='_blank' rel='noopener noreferrer'>
          <Button type='button' variant='subtle' leftSection={<FontAwesomeIcon icon={faExternalLink} />}>
            {tBase('common.button.viewDocumentation', {})}
          </Button>
        </Anchor>
      </Group>

      {activeStep < REVIEW_STEP ? (
        <Button type='button' disabled={loading} onClick={goToNextStep}>
          {tBase('common.button.continue', {})}
        </Button>
      ) : (
        <AdminCan
          action={contextNode ? 'databases-everywhere-nodes.update' : 'databases-everywhere-nodes.create'}
          cantSave
        >
          <Button type='submit' loading={loading}>
            {tBase('common.button.save', {})}
          </Button>
          {!contextNode && (
            <Button type='button' onClick={() => submit(true)} loading={loading}>
              {tBase('common.button.saveAndStay', {})}
            </Button>
          )}
        </AdminCan>
      )}
    </Group>
  );

  return (
    <AdminContentContainer
      title={contextNode ? t('admin.editTitle', {}) : t('admin.createTitle', {})}
      titleOrder={2}
      contentRight={<AdvancedModeToggle />}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (activeStep < REVIEW_STEP) {
            goToNextStep();
          } else {
            submit(false);
          }
        }}
      >
        <NodeSetupWizard
          steps={steps}
          active={activeStep}
          onStepChange={setActiveStep}
          footer={wizardFooter}
          navigationDisabled={loading}
        >
          {activeStep === BASICS_STEP && (
            <Alert color='blue' mb='md'>
              {t('admin.nodeConfig.simpleSetup', {})}
            </Alert>
          )}
          {activeStep === SYSTEM_STEP && !advancedMode && (
            <Alert color='blue' mb='md'>
              {t('admin.wizard.systemDefaultsHint', {})}
            </Alert>
          )}
          {importedSelfUpgrade && (activeStep === SYSTEM_STEP || activeStep === REVIEW_STEP) && (
            <Alert color='red' title={t('admin.nodeConfig.selfUpgradeTitle', {})} mb='md'>
              {t('admin.nodeConfig.selfUpgradeDescription', {})}
            </Alert>
          )}
          {activeStep === REVIEW_STEP ? (
            <NodeSetupReview values={form.values} showArtifactPolicy={supportsArtifactPolicy} />
          ) : activeStep === CONTAINERS_STEP ? (
            <Stack gap='md'>
              <FormEngine form={form} fields={resourceFields} className='md:grid-cols-3!' />
              <FormEngine form={form} fields={configurationFields.runtime} />
              <FormEngine form={form} fields={configurationFields.allocation} />
            </Stack>
          ) : (
            <FormEngine form={form} fields={activeFields} />
          )}
        </NodeSetupWizard>
      </form>

      <NodeCredentialsModal credentials={credentials} onClose={closeCredentials} />
    </AdminContentContainer>
  );
}
