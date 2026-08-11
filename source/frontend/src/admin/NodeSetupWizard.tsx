import { Stepper } from '@mantine/core';
import type { ReactNode } from 'react';
import Card from '@/elements/Card.tsx';
import Text from '@/elements/Text.tsx';
import Title from '@/elements/Title.tsx';

export interface NodeSetupStep {
  label: string;
  description: string;
}

interface Props {
  steps: NodeSetupStep[];
  active: number;
  onStepChange: (step: number) => void;
  children: ReactNode;
  footer: ReactNode;
  navigationDisabled?: boolean;
}

export default function NodeSetupWizard({
  steps,
  active,
  onStepChange,
  children,
  footer,
  navigationDisabled = false,
}: Props) {
  const current = steps[active];

  return (
    <div className='mx-auto grid w-full max-w-[100rem] grid-cols-1 gap-6 xl:grid-cols-[18rem_minmax(0,1fr)] xl:items-start'>
      <Card p='lg' className='xl:sticky xl:top-6'>
        <Stepper
          active={active}
          orientation='vertical'
          size='sm'
          onStepClick={navigationDisabled ? undefined : onStepChange}
          classNames={{
            root: 'w-full',
            step: 'w-full py-1',
            stepBody: 'min-w-0',
            stepLabel: 'leading-tight',
            stepDescription: 'mt-1 leading-tight',
          }}
        >
          {steps.map((step, index) => (
            <Stepper.Step
              key={step.label}
              label={step.label}
              description={step.description}
              style={{ cursor: navigationDisabled ? 'default' : 'pointer' }}
              aria-current={index === active ? 'step' : undefined}
            />
          ))}
        </Stepper>
      </Card>

      <Card p='lg' className='min-w-0'>
        <div className='mb-5'>
          <Title order={3}>{current?.label}</Title>
          <Text size='sm' c='dimmed' mt={4}>
            {current?.description}
          </Text>
        </div>

        <div key={active}>{children}</div>

        <div className='border-t border-(--mantine-color-default-border) mt-6 pt-4'>{footer}</div>
      </Card>
    </div>
  );
}
