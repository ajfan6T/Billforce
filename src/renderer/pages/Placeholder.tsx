import { Construction } from 'lucide-react';
import { EmptyState, Page, PageHeader } from '../components/ui';

/** Temporary page used while a module is being built. */
export function Placeholder({ title }: { title: string }) {
  return (
    <Page>
      <PageHeader title={title} />
      <EmptyState icon={<Construction size={36} />} title="Coming soon" message="This page is being built." />
    </Page>
  );
}
