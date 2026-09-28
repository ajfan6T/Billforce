import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import { Alert, Button, Card, ErrorBox, Loading } from '../../components/ui';
import { useHotkeys, useMutation, useQuery } from '../../hooks';
import { useDialogs, useToast, useUnsavedWarning } from '../../feedback';
import type { Permission } from '../../../shared/permissions';

type EditableRole = 'manager' | 'cashier';
const EDITABLE: EditableRole[] = ['manager', 'cashier'];

const same = (a: Permission[], b: Permission[]) => a.length === b.length && a.every((p) => b.includes(p));

/** Permission matrix: each permission (grouped) x Owner / Manager / Cashier. Owner is fixed to everything. */
export function RolePermissions() {
  const q = useQuery('roles.get', undefined);
  const save = useMutation('roles.update');
  const toast = useToast();
  const dialogs = useDialogs();
  const [draft, setDraft] = useState<Record<EditableRole, Permission[]> | null>(null);

  useEffect(() => {
    if (q.data) setDraft({ manager: [...q.data.roles.manager], cashier: [...q.data.roles.cashier] });
  }, [q.data]);

  const dirty = useMemo(() => {
    if (!q.data || !draft) return [] as EditableRole[];
    return EDITABLE.filter((r) => !same(draft[r], q.data!.roles[r]));
  }, [q.data, draft]);
  useUnsavedWarning(dirty.length > 0);

  const canEdit = !!q.data?.canEdit;

  const toggle = (role: EditableRole, p: Permission, on: boolean) =>
    setDraft((d) => (d ? { ...d, [role]: on ? [...d[role], p] : d[role].filter((x) => x !== p) } : d));
  const setGroup = (role: EditableRole, perms: Permission[], on: boolean) =>
    setDraft((d) => (d ? { ...d, [role]: on ? [...new Set([...d[role], ...perms])] : d[role].filter((x) => !perms.includes(x)) } : d));

  const saveAll = async () => {
    if (!draft || !dirty.length) return;
    const risky = dirty.filter((r) => draft[r].includes('users.manage') && !q.data!.roles[r].includes('users.manage'));
    if (risky.length) {
      const ok = await dialogs.confirm({
        title: 'Allow managing users?',
        message: `${risky.map((r) => (r === 'manager' ? 'Managers' : 'Cashiers')).join(' and ')} will be able to add logins and reset passwords of managers and cashiers. Only the owner can ever change owner logins.`,
        confirmText: 'Allow',
      });
      if (!ok) return;
    }
    try {
      let latest = null;
      for (const role of dirty) latest = await save.run({ role, permissions: draft[role] });
      if (latest) q.setData(latest);
      toast.success('Permissions saved. They apply the next time those users do something.');
    } catch (e) {
      toast.error(e);
    }
  };

  const resetDefaults = async () => {
    if (!q.data) return;
    const ok = await dialogs.confirm({
      title: 'Go back to the standard permissions?',
      message: 'Manager and Cashier will get the permissions Billforce started with. Nothing is saved until you press Save.',
      confirmText: 'Use standard permissions',
    });
    if (ok) setDraft({ manager: [...q.data.defaults.manager], cashier: [...q.data.defaults.cashier] });
  };

  useHotkeys({ 'ctrl+s': () => canEdit && void saveAll() }, [canEdit, draft, dirty]);

  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  if (!q.data || !draft) return <Loading />;
  const data = q.data;

  return (
    <div className="stack">
      {!canEdit && <Alert tone="blue">Only the owner can change what each role is allowed to do. You can see the current permissions here.</Alert>}
      {canEdit && (
        <Alert tone="neutral">
          Tick what Managers and Cashiers may do. The Owner can always do everything. Changes apply to users with that role from their next action.
        </Alert>
      )}
      <Card padded={false}>
        <div className="table-wrap">
          <table className="table perm-table">
            <thead>
              <tr>
                <th>Permission</th>
                <th className="role-col">Owner</th>
                <th className="role-col">
                  Manager <span className="tab-count">{data.userCounts.manager}</span>
                </th>
                <th className="role-col">
                  Cashier <span className="tab-count">{data.userCounts.cashier}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.groups.map((g) => {
                const keys = g.permissions.map((p) => p.key);
                return [
                  <tr key={g.group} className="perm-group">
                    <td>{g.group}</td>
                    <td className="role-col" />
                    {EDITABLE.map((role) => {
                      const all = keys.every((k) => draft[role].includes(k));
                      return (
                        <td key={role} className="role-col">
                          {canEdit && (
                            <button type="button" className="link-btn" onClick={() => setGroup(role, keys, !all)}>
                              {all ? 'None' : 'All'}
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>,
                  ...g.permissions.map((p) => {
                    const changed = EDITABLE.some((r) => draft[r].includes(p.key) !== data.roles[r].includes(p.key));
                    return (
                      <tr key={p.key} className={`perm-row${changed ? ' changed' : ''}`}>
                        <td>{p.label}</td>
                        <td className="role-col">
                          <input type="checkbox" checked disabled aria-label={`Owner: ${p.label}`} />
                        </td>
                        {EDITABLE.map((role) => (
                          <td key={role} className="role-col">
                            <input
                              type="checkbox"
                              aria-label={`${role === 'manager' ? 'Manager' : 'Cashier'}: ${p.label}`}
                              checked={draft[role].includes(p.key)}
                              disabled={!canEdit}
                              onChange={(e) => toggle(role, p.key, e.target.checked)}
                            />
                          </td>
                        ))}
                      </tr>
                    );
                  }),
                ];
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {canEdit && (
        <div className="sticky-savebar">
          <Button variant="ghost" icon={<RotateCcw size={15} />} onClick={resetDefaults}>
            Standard permissions
          </Button>
          <div className="row">
            {dirty.length > 0 && <span className="unsaved-dot">Unsaved changes</span>}
            {dirty.length > 0 && (
              <Button variant="ghost" onClick={() => setDraft({ manager: [...data.roles.manager], cashier: [...data.roles.cashier] })}>
                Undo
              </Button>
            )}
            <Button variant="primary" icon={<Save size={15} />} kbd="Ctrl+S" loading={save.loading} disabled={!dirty.length} onClick={saveAll}>
              Save permissions
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
