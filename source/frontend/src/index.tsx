import { faCubesStacked, faDatabase, faServer } from '@fortawesome/free-solid-svg-icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { FC } from 'react';
import { Extension, type ExtensionContext } from 'shared';
import LocationHostAssignmentsPage from './admin/assignments/LocationHostAssignmentsPage.tsx';
import NodeHostAssignmentsPage from './admin/assignments/NodeHostAssignmentsPage.tsx';
import NodesPage from './admin/NodesPage.tsx';
import SettingsPage, { SettingsCard } from './admin/SettingsPage.tsx';
import { createServerLimitsFormSlot, updateServerLimitsFormSlot } from './forms/serverLimits.tsx';
import DatabaseViewPage from './server/DatabaseViewPage.tsx';
import { integrateNativeDatabasesContainer } from './server/NativeDatabasesIntegration.tsx';
import translations from './translations.ts';

class DatabasesEverywhereExtension extends Extension {
  public cardConfigurationPage: FC = SettingsPage;
  public cardComponent: FC = SettingsCard;
  public cardIcon = <FontAwesomeIcon icon={faDatabase} />;

  public initialize(ctx: ExtensionContext): void {
    ctx.extensionRegistry.forms.extend('admin.servers.create', createServerLimitsFormSlot);
    ctx.extensionRegistry.forms.extend('admin.servers.update', updateServerLimitsFormSlot);

    ctx.extensionRegistry.routes.addAdminRoute({
      name: () => translations.getTranslations().t('admin.title', {}),
      icon: faServer,
      path: '/databases-everywhere/*',
      element: NodesPage,
      permission: ['databases-everywhere-nodes.*'],
      category: 'databases',
    });

    ctx.extensionRegistry.pages.admin.nodes.view.subNavigation.addItemInterceptor((items, { node }) => {
      const after = items.findIndex((item) => item.path === '/database-agent-hosts');
      items.splice(after < 0 ? items.length : after + 1, 0, {
        name: () => translations.getTranslations().t('assignments.tab', {}),
        icon: faCubesStacked,
        path: '/databases-everywhere-hosts',
        element: <NodeHostAssignmentsPage node={node} />,
        permission: 'databases-everywhere-nodes.read',
      });
    });

    ctx.extensionRegistry.pages.admin.locations.view.subNavigation.addItemInterceptor((items, { location }) => {
      const after = items.findIndex((item) => item.path === '/database-agent-hosts');
      items.splice(after < 0 ? items.length : after + 1, 0, {
        name: () => translations.getTranslations().t('assignments.tab', {}),
        icon: faCubesStacked,
        path: '/databases-everywhere-hosts',
        element: <LocationHostAssignmentsPage location={location} />,
        permission: 'databases-everywhere-nodes.read',
      });
    });

    ctx.extensionRegistry.pages.server.databases.enterContainer((container) => {
      container.addPropsInterceptor(integrateNativeDatabasesContainer);
    });

    ctx.extensionRegistry.routes.addServerRoute({
      name: undefined,
      path: '/databases/dbev/:database',
      element: DatabaseViewPage,
      permission: 'databases-everywhere.read',
    });
  }
}

export default new DatabasesEverywhereExtension();
