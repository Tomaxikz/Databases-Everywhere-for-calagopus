import {
  faArrowsRotate,
  faBoxArchive,
  faChartLine,
  faDatabase,
  faFileExport,
  faTerminal,
} from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { lazy } from 'react';
import Spinner from '@/elements/Spinner.tsx';
import Tabs from '@/elements/Tabs.tsx';
import { useServerCan } from '@/plugins/usePermissions.ts';
import type { DatabaseRecord } from '../api/types.ts';
import translations from '../translations.ts';
import { databaseActionPolicy } from './databaseActionPolicy.ts';
import OverviewTab from './tabs/OverviewTab.tsx';

const DataTab = lazy(() => import('./tabs/DataTab.tsx'));
const ConsoleTab = lazy(() => import('./tabs/ConsoleTab.tsx'));
const TransfersTab = lazy(() => import('./tabs/TransfersTab.tsx'));
const BackupsTab = lazy(() => import('./tabs/BackupsTab.tsx'));
const UpdatesTab = lazy(() => import('./tabs/UpdatesTab.tsx'));

interface Props {
  server: string;
  database: DatabaseRecord;
  onChanged: () => void;
  onDeleted: () => void;
}

export default function DatabaseWorkspace(props: Props) {
  const { t } = translations.useTranslations();
  const canBrowseData = useServerCan('databases-everywhere.data');
  const canUseConsole = useServerCan('databases-everywhere.console');
  const canUseTransfers = useServerCan('databases-everywhere.transfers');
  const canUseBackups = useServerCan('databases-everywhere.backups');
  const canUpdate = useServerCan('databases-everywhere.update');
  const policy = databaseActionPolicy(props.database.status);
  return (
    <Tabs defaultValue='overview' keepMounted={false}>
      <Tabs.List>
        <Tabs.Tab value='overview' leftSection={<FontAwesomeIcon icon={faChartLine} />}>
          {t('server.overview', {})}
        </Tabs.Tab>
        {canBrowseData && policy.useConnection && (
          <Tabs.Tab value='data' leftSection={<FontAwesomeIcon icon={faDatabase} />}>
            {t('server.data', {})}
          </Tabs.Tab>
        )}
        {canUseConsole && policy.useConnection && props.database.mutations_allowed && (
          <Tabs.Tab value='console' leftSection={<FontAwesomeIcon icon={faTerminal} />}>
            {t('server.console', {})}
          </Tabs.Tab>
        )}
        {canUseTransfers && policy.useConnection && (
          <Tabs.Tab value='transfers' leftSection={<FontAwesomeIcon icon={faFileExport} />}>
            {t('server.transfers', {})}
          </Tabs.Tab>
        )}
        {canUseBackups && (
          <Tabs.Tab value='backups' leftSection={<FontAwesomeIcon icon={faBoxArchive} />}>
            {t('server.backups', {})}
          </Tabs.Tab>
        )}
        {canUpdate && (
          <Tabs.Tab value='updates' leftSection={<FontAwesomeIcon icon={faArrowsRotate} />}>
            {t('server.updates', {})}
          </Tabs.Tab>
        )}
      </Tabs.List>
      <Tabs.Panel value='overview'>
        <OverviewTab {...props} />
      </Tabs.Panel>
      {canBrowseData && policy.useConnection && (
        <Tabs.Panel value='data'>
          <Spinner.Suspense className='min-h-40'>
            <DataTab server={props.server} database={props.database} />
          </Spinner.Suspense>
        </Tabs.Panel>
      )}
      {canUseConsole && policy.useConnection && props.database.mutations_allowed && (
        <Tabs.Panel value='console'>
          <Spinner.Suspense className='min-h-40'>
            <ConsoleTab server={props.server} database={props.database} />
          </Spinner.Suspense>
        </Tabs.Panel>
      )}
      {canUseTransfers && policy.useConnection && (
        <Tabs.Panel value='transfers'>
          <Spinner.Suspense className='min-h-40'>
            <TransfersTab server={props.server} database={props.database} />
          </Spinner.Suspense>
        </Tabs.Panel>
      )}
      {canUseBackups && (
        <Tabs.Panel value='backups'>
          <Spinner.Suspense className='min-h-40'>
            <BackupsTab server={props.server} database={props.database} />
          </Spinner.Suspense>
        </Tabs.Panel>
      )}
      {canUpdate && (
        <Tabs.Panel value='updates'>
          <Spinner.Suspense className='min-h-40'>
            <UpdatesTab server={props.server} database={props.database} onChanged={props.onChanged} />
          </Spinner.Suspense>
        </Tabs.Panel>
      )}
    </Tabs>
  );
}
