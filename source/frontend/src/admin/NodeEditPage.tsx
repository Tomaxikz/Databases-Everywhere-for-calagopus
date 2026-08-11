import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { httpErrorToHuman } from '@/api/axios.ts';
import Alert from '@/elements/Alert.tsx';
import AdminContentContainer from '@/elements/containers/AdminContentContainer.tsx';
import Spinner from '@/elements/Spinner.tsx';
import { getNode } from '../api/client.ts';
import { dbevQueryKeys } from '../api/queryKeys.ts';
import translations from '../translations.ts';
import NodeCreateOrUpdate from './NodeCreateOrUpdate.tsx';

export default function NodeEditPage() {
  const { t } = translations.useTranslations();
  const { node = '' } = useParams<{ node: string }>();
  const query = useQuery({
    queryKey: dbevQueryKeys.adminNode(node),
    queryFn: () => getNode(node),
    enabled: Boolean(node),
  });

  if (query.data) return <NodeCreateOrUpdate contextNode={query.data} />;

  return (
    <AdminContentContainer title={t('admin.editTitle', {})} titleOrder={2}>
      {query.isPending ? <Spinner.Centered /> : <Alert color='red'>{httpErrorToHuman(query.error)}</Alert>}
    </AdminContentContainer>
  );
}
