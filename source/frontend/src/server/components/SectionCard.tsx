import classNames from 'classnames';
import type { ReactNode } from 'react';
import Card from '@/elements/Card.tsx';
import Group from '@/elements/Group.tsx';

export interface SectionCardProps {
  heading: ReactNode;
  headerRight?: ReactNode;
  bodyPadded?: boolean;
  bodyClassName?: string;
  children: ReactNode;
}

export default function SectionCard({
  heading,
  headerRight,
  bodyPadded = true,
  bodyClassName,
  children,
}: SectionCardProps) {
  return (
    <Card p={0}>
      <Group
        justify='space-between'
        align='flex-start'
        wrap='nowrap'
        className='border-b border-(--mantine-color-default-border) px-4 py-3'
      >
        <div className='min-w-0'>{heading}</div>
        {headerRight}
      </Group>
      <div className={classNames('min-w-0', bodyPadded && 'p-4', bodyClassName)}>{children}</div>
    </Card>
  );
}
