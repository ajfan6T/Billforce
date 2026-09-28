import { Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router';
import { ShieldOff } from 'lucide-react';
import { AuthProvider, useAuth } from './auth';
import { FeedbackProvider } from './feedback';
import { Shell } from './layout/Shell';
import { APP_ROUTES } from './routes';
import { SetupWizard } from './pages/auth/Setup';
import { LockScreen, LoginScreen } from './pages/auth/Login';
import { ForcePasswordChange } from './pages/admin/ForcePasswordChange';
import { EmptyState, Loading, Page } from './components/ui';
import type { AppRoute } from './routing';

function NoAccess() {
  return (
    <Page>
      <EmptyState icon={<ShieldOff size={36} />} title="You don't have access to this page" message="Ask the owner to give your role permission for it." />
    </Page>
  );
}

function Guard({ route }: { route: AppRoute }) {
  const { can, canAny } = useAuth();
  const ok = !route.perm || (Array.isArray(route.perm) ? canAny(route.perm) : can(route.perm));
  return (
    <Shell fullBleed={route.fullBleed}>
      <Suspense fallback={<Loading />}>{ok ? route.element : <NoAccess />}</Suspense>
    </Shell>
  );
}

function Root() {
  const { status, session, locked } = useAuth();
  if (!status) return <Loading label="Starting Billforce…" />;
  if (!status.setupDone) return <SetupWizard />;
  if (!session) return <LoginScreen />;
  if (session.mustChangePassword) return <ForcePasswordChange />;
  return (
    <>
      <Routes>
        {APP_ROUTES.map((r) => (
          <Route key={r.path} path={r.path} element={<Guard route={r} />} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {locked && <LockScreen />}
    </>
  );
}

export function App() {
  return (
    <HashRouter>
      <FeedbackProvider>
        <AuthProvider>
          <Root />
        </AuthProvider>
      </FeedbackProvider>
    </HashRouter>
  );
}
