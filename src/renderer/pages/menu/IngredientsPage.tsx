import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Carrot, Pencil, Plus, Power } from 'lucide-react';
import { call, type ApiOutput } from '../../api';
import { useDebounced, useHotkeys, useMutation, useQuery } from '../../hooks';
import { useAuth, useFeatures } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { Alert, Badge, Button, EmptyState, ErrorBox, IconButton, Page, PageHeader, Toolbar } from '../../components/ui';
import { Checkbox, Field, FormGrid, NumberInput, SearchInput, Select, TextInput } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { Modal } from '../../components/modal';
import { formatINR, formatQty } from '../../../shared/money';
import { ItemModal } from '../sales/ItemsPage';
import './menu.css';

type Ingredient = ApiOutput<'menu.ingredients'>[number];

const INGREDIENT_UNITS = ['kg', 'g', 'ltr', 'ml', 'pcs', 'dozen', 'pack', 'bottle', 'bag', 'box'];

/** Add an ingredient: kept in stock, not sold on bills. */
export function IngredientModal({ open, initialName = '', onClose, onSaved }: { open: boolean; initialName?: string; onClose: () => void; onSaved: (i: Ingredient) => void }) {
  const features = useFeatures();
  const m = useMutation('menu.createIngredient');
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('kg');
  const [low, setLow] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    m.reset();
    setName(initialName);
    setUnit('kg');
    setLow(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const save = async () => {
    if (!name.trim() || m.loading) return;
    try {
      onSaved(await m.run({ name: name.trim(), unit, reorderLevel: features.stock ? low : null }));
    } catch {
      /* shown below */
    }
  };
  return (
    <Modal
      open={open}
      title="Add ingredient"
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.loading} disabled={!name.trim()} onClick={() => void save()}>
            Add ingredient
          </Button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <FormGrid cols={2}>
          <Field label="Name" required error={m.fields.name} className="span-2">
            <TextInput autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chicken, Paneer, Cream" />
          </Field>
          <Field label="Kept in" hint="The unit you buy and count it in">
            <Select<string> value={unit} onChange={setUnit} options={INGREDIENT_UNITS.map((u) => ({ value: u, label: u }))} aria-label="Unit" />
          </Field>
          {features.stock ? (
            <Field label="Low stock at" hint={`Alert when stock falls to this (${unit})`} error={m.fields.reorderLevel}>
              <NumberInput value={low} onChange={setLow} placeholder="e.g. 2" aria-label="Low stock at" />
            </Field>
          ) : (
            <span />
          )}
        </FormGrid>
        <p className="small muted mt-0 mb-0">Ingredients are not offered on bills. {features.stock ? 'Buy them in purchase bills to bring them into stock.' : ''}</p>
        {m.error && !m.fields.name && <Alert tone="red">{m.error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function IngredientsPage() {
  const { can } = useAuth();
  const features = useFeatures();
  const manage = can('items.manage');
  const toast = useToast();
  const dialogs = useDialogs();
  const [q, setQ] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const dq = useDebounced(q, 150);
  const list = useQuery('menu.ingredients', undefined);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Ingredient | null>(null);
  useHotkeys({ 'ctrl+n': () => manage && setAdding(true) });

  const rows = useMemo(() => {
    const t = dq.trim().toLowerCase();
    return (list.data ?? []).filter((i) => (showInactive || i.isActive) && (!t || i.name.toLowerCase().includes(t)));
  }, [list.data, dq, showInactive]);

  const toggleActive = async (i: Ingredient) => {
    if (i.isActive && i.usedIn > 0) {
      const ok = await dialogs.confirm({
        title: `Deactivate ${i.name}?`,
        message: `${i.name} is in the recipe of ${i.usedIn} dish${i.usedIn === 1 ? '' : 'es'}. Selling those dishes still takes it out of stock.`,
        confirmText: 'Deactivate',
      });
      if (!ok) return;
    }
    try {
      await call('items.setActive', { id: i.id, active: !i.isActive });
      toast.success(`${i.name} ${i.isActive ? 'deactivated' : 're-activated'}`);
      void list.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const columns: Array<Column<Ingredient>> = [
    { key: 'name', label: 'Ingredient', render: (i) => <span className="sl-cell-main">{i.name}</span> },
    { key: 'unit', label: 'Kept in' },
    ...(features.stock
      ? [
          {
            key: 'stock',
            label: 'In stock',
            align: 'right' as const,
            value: (i: Ingredient) => i.stock ?? -Infinity,
            render: (i: Ingredient) =>
              i.stock === null ? (
                <span className="faint">not tracked</span>
              ) : (
                <Link to={`/stock/items/${i.id}`} className={i.stock <= 0 ? 'neg' : i.reorderLevel && i.stock <= i.reorderLevel ? 'warn-text' : ''} onClick={(e) => e.stopPropagation()}>
                  <b>{formatQty(i.stock)}</b> {i.unit}
                </Link>
              ),
          } satisfies Column<Ingredient>,
          { key: 'reorderLevel', label: 'Low at', align: 'right' as const, render: (i: Ingredient) => (i.reorderLevel ? `${formatQty(i.reorderLevel)} ${i.unit}` : <span className="faint">—</span>) } satisfies Column<Ingredient>,
        ]
      : []),
    {
      key: 'avgCost',
      label: 'Average cost',
      align: 'right',
      value: (i) => i.avgCost ?? -1,
      render: (i) => (i.avgCost === null ? <span className="faint">not bought yet</span> : <span className="money">{`${formatINR(i.avgCost)}/${i.unit}`}</span>),
    },
    { key: 'usedIn', label: 'Used in', type: 'number', render: (i) => (i.usedIn ? `${i.usedIn} dish${i.usedIn === 1 ? '' : 'es'}` : <span className="faint">no recipe</span>) },
    {
      key: 'status',
      label: 'Status',
      value: (i) => (i.isActive ? 1 : 0),
      render: (i) => (!i.isActive ? <Badge>Inactive</Badge> : i.sellable ? <Badge tone="blue">Also sold</Badge> : <Badge tone="green">Active</Badge>),
    },
    ...(manage
      ? [
          {
            key: 'actions',
            label: '',
            sortable: false,
            render: (i: Ingredient) => (
              <div className="sl-row-actions" onClick={(e) => e.stopPropagation()}>
                <IconButton label={`Edit ${i.name}`} icon={<Pencil size={15} />} onClick={() => setEditing(i)} />
                <IconButton label={i.isActive ? `Deactivate ${i.name}` : `Re-activate ${i.name}`} icon={<Power size={15} />} onClick={() => void toggleActive(i)} />
              </div>
            ),
          } satisfies Column<Ingredient>,
        ]
      : []),
  ];

  return (
    <Page>
      <PageHeader
        title="Ingredients"
        subtitle={features.stock ? 'What your dishes are made of: bought in purchase bills, taken out of stock when a dish is sold' : 'What your dishes are made of'}
        back="/menu"
        actions={
          manage && (
            <Button variant="primary" icon={<Plus size={16} />} kbd="Ctrl+N" onClick={() => setAdding(true)}>
              Add ingredient
            </Button>
          )
        }
      />
      <Toolbar className="mt-1">
        <SearchInput value={q} onChange={setQ} placeholder="Search ingredients…" />
        <Checkbox checked={showInactive} onChange={setShowInactive} label="Show inactive" />
        <span className="spacer" />
        {features.stock && can('stock.manage') && (
          <Link to="/stock/adjustments/new?kind=count" className="small">
            Count the kitchen stock →
          </Link>
        )}
      </Toolbar>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      <div className="card sl-list-card">
        <DataTable<Ingredient>
          columns={columns}
          rows={list.data ? rows : undefined}
          rowKey={(i) => i.id}
          loading={list.loading}
          onRowClick={manage ? (i) => setEditing(i) : undefined}
          rowClassName={(i) => (i.isActive ? '' : 'sl-inactive')}
          initialSort={{ key: 'name', dir: 'asc' }}
          empty={
            <EmptyState
              icon={<Carrot size={32} />}
              title={dq ? 'No ingredients match your search' : 'No ingredients yet'}
              message={dq ? 'Try another name.' : 'Add the raw materials of your kitchen (chicken, paneer, oil, cream …), then use them in the recipes of your dishes.'}
              action={
                manage && !dq ? (
                  <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
                    Add your first ingredient
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </div>
      <IngredientModal
        open={adding}
        onClose={() => setAdding(false)}
        onSaved={(i) => {
          toast.success(`Added ${i.name}`);
          setAdding(false);
          void list.reload();
        }}
      />
      <ItemModal
        open={!!editing}
        item={editing}
        categories={[]}
        onClose={() => setEditing(null)}
        onSaved={(i) => {
          toast.success(`Saved ${i.name}`);
          setEditing(null);
          void list.reload();
        }}
      />
    </Page>
  );
}
