import { useState } from 'react';
import { KeyRound, Pencil, ShieldCheck, UserCheck, UserPlus, UserX, Users } from 'lucide-react';
import { Badge, Button, Card, EmptyState, ErrorBox, IconButton, Page, PageHeader, Tabs } from '../../components/ui';
import { DataTable, type Column } from '../../components/table';
import { useHotkeys, useMutation, useQuery, useStoredState } from '../../hooks';
import { useDialogs, useToast } from '../../feedback';
import { useAuth } from '../../auth';
import { ROLE_LABELS } from '../../../shared/constants';
import { RoleBadge, WhenText, initials } from './common';
import { RecoveryCodeModal, ResetPasswordModal, UserFormModal, type UserItem } from './UserModals';
import { RolePermissions } from './RolePermissions';
import './admin.css';

function UsersTab() {
  const { session, refresh } = useAuth();
  const list = useQuery('users.list', undefined);
  const setActive = useMutation('users.update');
  const toast = useToast();
  const dialogs = useDialogs();
  const [editing, setEditing] = useState<UserItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<UserItem | null>(null);
  const [recovery, setRecovery] = useState(false);
  const isOwner = session?.role === 'owner';

  useHotkeys({ 'alt+n': () => setAdding(true) });

  const toggleActive = async (u: UserItem) => {
    if (u.isActive) {
      const ok = await dialogs.confirm({
        title: `Deactivate ${u.fullName}?`,
        message: (
          <>
            <b>{u.username}</b> will no longer be able to log in. Their bills and entries stay in your records and the activity log. You can re-activate the login at any time.
          </>
        ),
        confirmText: 'Deactivate',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await setActive.run({ id: u.id, fullName: u.fullName, role: u.role, isActive: !u.isActive });
      toast.success(u.isActive ? `${u.fullName} can no longer log in` : `${u.fullName} can log in again`);
      await list.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const canTouch = (u: UserItem) => isOwner || u.role !== 'owner';

  const columns: Array<Column<UserItem>> = [
    {
      key: 'fullName',
      label: 'Name',
      render: (u) => (
        <div className="user-cell">
          <span className={`user-avatar ${u.isActive ? u.role : 'inactive'}`}>{initials(u.fullName)}</span>
          <div>
            <span className="cell-main">{u.fullName}</span>
            {u.isSelf && (
              <>
                {' '}
                <Badge tone="blue">You</Badge>
              </>
            )}
            <span className="cell-note">{u.username}</span>
          </div>
        </div>
      ),
    },
    { key: 'role', label: 'Role', value: (u) => ROLE_LABELS[u.role], render: (u) => <RoleBadge role={u.role} /> },
    {
      key: 'status',
      label: 'Status',
      value: (u) => (u.isActive ? 0 : 1),
      render: (u) => (
        <div className="status-list">
          {u.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}
          {u.isActive && u.mustChangePassword && <Badge tone="amber">Must set password</Badge>}
          {u.isActive && u.isLocked && <Badge tone="red">Locked for a minute</Badge>}
        </div>
      ),
    },
    { key: 'lastLoginAt', label: 'Last login', value: (u) => u.lastLoginAt ?? '', render: (u) => <WhenText ts={u.lastLoginAt} /> },
    {
      key: 'actions',
      label: '',
      sortable: false,
      align: 'right',
      render: (u) =>
        canTouch(u) ? (
          <div className="admin-actions" onClick={(e) => e.stopPropagation()}>
            <IconButton label="Edit" icon={<Pencil size={16} />} onClick={() => setEditing(u)} />
            {!u.isSelf && <IconButton label="Reset password" icon={<KeyRound size={16} />} onClick={() => setResetting(u)} disabled={!u.isActive} />}
            {!u.isSelf &&
              (u.isActive ? (
                <IconButton label="Deactivate" icon={<UserX size={16} />} onClick={() => void toggleActive(u)} />
              ) : (
                <IconButton label="Activate" icon={<UserCheck size={16} />} onClick={() => void toggleActive(u)} />
              ))}
          </div>
        ) : (
          <span className="faint small">Owner only</span>
        ),
    },
  ];

  const onlyOwner = list.data && list.data.length === 1;

  return (
    <div className="stack">
      <div className="row-between">
        <p className="muted mt-0 mb-0">Give each person their own login, so the activity log shows who did what.</p>
        <Button variant="primary" icon={<UserPlus size={16} />} kbd="Alt+N" onClick={() => setAdding(true)}>
          Add user
        </Button>
      </div>
      <Card padded={false}>
        {list.error ? (
          <div className="card-body">
            <ErrorBox error={list.error} onRetry={list.reload} />
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={list.data}
            loading={list.loading}
            rowKey={(u) => u.id}
            rowClassName={(u) => (u.isActive ? '' : 'row-inactive')}
            onRowClick={(u) => canTouch(u) && setEditing(u)}
          />
        )}
      </Card>
      {onlyOwner && (
        <EmptyState
          icon={<Users size={32} />}
          title="Only you have a login"
          message="Add a login for each manager or cashier. Cashiers can only bill and take payments; managers can do most day-to-day work."
          action={
            <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setAdding(true)}>
              Add a user
            </Button>
          }
        />
      )}
      {isOwner && (
        <Card title="Owner recovery code" actions={<Button icon={<ShieldCheck size={16} />} onClick={() => setRecovery(true)}>Generate new recovery code</Button>}>
          <p className="muted mt-0 mb-0">
            If you forget the owner password, the recovery code written down at setup lets you choose a new one from the login screen. Make a new code if the old one is lost.
          </p>
        </Card>
      )}
      <UserFormModal
        open={adding || !!editing}
        user={editing}
        onClose={() => {
          setAdding(false);
          setEditing(null);
        }}
        onSaved={async (u) => {
          setAdding(false);
          setEditing(null);
          await list.reload();
          if (u.isSelf) await refresh();
        }}
      />
      <ResetPasswordModal
        user={resetting}
        onClose={() => setResetting(null)}
        onDone={async () => {
          setResetting(null);
          await list.reload();
        }}
      />
      <RecoveryCodeModal open={recovery} onClose={() => setRecovery(false)} />
    </div>
  );
}

export function UsersPage() {
  const [tab, setTab] = useStoredState<'users' | 'roles'>('admin.users.tab', 'users');
  return (
    <Page>
      <PageHeader title="Users & permissions" subtitle="Logins for everyone who uses Billforce, and what each role may do" />
      <Tabs
        tabs={[
          { key: 'users', label: 'Users' },
          { key: 'roles', label: 'Role permissions' },
        ]}
        value={tab}
        onChange={(k) => setTab(k as 'users' | 'roles')}
      />
      {tab === 'users' ? <UsersTab /> : <RolePermissions />}
    </Page>
  );
}
