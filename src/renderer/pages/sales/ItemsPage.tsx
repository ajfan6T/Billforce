import { useEffect, useMemo, useRef, useState } from 'react';
import { Package, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { call, errorMessage, type ApiOutput } from '../../api';
import { useDebounced, useHotkeys, useMutation, useQuery } from '../../hooks';
import { useAuth, useFeatures } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { Alert, Badge, Button, EmptyState, ErrorBox, IconButton, Page, PageHeader, Toolbar } from '../../components/ui';
import { Checkbox, Field, FormGrid, MoneyInput, SearchInput, Select, TextInput } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { ExportButtons } from '../../components/report';
import { Modal } from '../../components/modal';
import { UNITS } from '../../../shared/constants';
import { formatINR } from '../../../shared/money';
import { GST_RATES, formatRate, hsnProblem } from '../../../shared/gst';
import type { ReportData } from '../../../shared/report';
import './sales.css';

type Item = ApiOutput<'items.list'>[number];

interface ItemForm {
  name: string;
  code: string;
  unit: string;
  rate: number | null;
  category: string;
  hsn: string;
  /** null = the usual rate from Settings > GST. */
  gstRate: number | null;
}

const EMPTY: ItemForm = { name: '', code: '', unit: 'pcs', rate: null, category: '', hsn: '', gstRate: null };

/** "18%", or "18% (usual)" for items without their own rate. */
export function gstRateText(rate: number | null, usual: number): string {
  return rate === null ? `${formatRate(usual)} (usual)` : formatRate(rate);
}

function ItemModal({ open, item, categories, onClose, onSaved }: { open: boolean; item: Item | null; categories: string[]; onClose: () => void; onSaved: (i: Item, created: boolean) => void }) {
  const [f, setF] = useState<ItemForm>(EMPTY);
  const features = useFeatures();
  const withGst = features.gst === 'regular';
  const create = useMutation('items.create');
  const update = useMutation('items.update');
  const m = item ? update : create;
  useEffect(() => {
    if (!open) return;
    create.reset();
    update.reset();
    setF(
      item
        ? { name: item.name, code: item.code ?? '', unit: item.unit, rate: item.rate, category: item.category ?? '', hsn: item.hsn ?? '', gstRate: item.gstRate }
        : EMPTY,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item]);
  const hsnError = withGst ? hsnProblem(f.hsn) : null;
  const problem = !f.name.trim()
    ? 'Enter the item name'
    : f.rate === null
      ? 'Enter the rate (0 if it changes every time)'
      : !f.unit.trim()
        ? 'Choose the unit'
        : hsnError;
  const save = async () => {
    if (problem || m.loading) return;
    const input = {
      name: f.name.trim(),
      code: f.code.trim() || null,
      unit: f.unit.trim(),
      rate: f.rate ?? 0,
      category: f.category.trim() || null,
      // GST fields are sent only when the business charges GST (otherwise they stay as they are).
      ...(withGst ? { hsn: f.hsn.trim() || null, gstRate: f.gstRate } : {}),
    };
    try {
      const saved = item ? await update.run({ id: item.id, ...input }) : await create.run(input);
      onSaved(saved, !item);
    } catch {
      /* shown below */
    }
  };
  const unitOptions = UNITS.includes(f.unit as (typeof UNITS)[number]) || !f.unit ? [...UNITS] : [f.unit, ...UNITS];
  return (
    <Modal
      open={open}
      title={item ? `Edit ${item.name}` : 'Add item'}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.loading} disabled={!!problem} onClick={save} title={problem ?? undefined}>
            {item ? 'Save changes' : 'Add item'}
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
          <Field label="Item name" required error={m.fields.name} className="span-2">
            <TextInput autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Sugar (loose)" maxLength={120} />
          </Field>
          <Field label="Selling rate" required hint={withGst ? (features.gstInclusive ? 'Including GST. Can be changed on each bill' : 'Without GST (GST is added on the bill)') : 'Default rate on bills; can be changed on each bill'}>
            <MoneyInput value={f.rate} onChange={(rate) => setF({ ...f, rate })} placeholder="0.00" aria-label="Rate" />
          </Field>
          <Field label="Unit" required>
            <Select<string> value={f.unit} onChange={(unit) => setF({ ...f, unit })} options={unitOptions.map((u) => ({ value: u, label: u }))} aria-label="Unit" />
          </Field>
          <Field label="Code / barcode" hint="Optional. Typing or scanning it on the bill adds the item">
            <TextInput value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} maxLength={40} />
          </Field>
          <Field label="Category" hint="Optional, e.g. Grocery, Snacks">
            <TextInput value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} list="item-categories" maxLength={60} />
            <datalist id="item-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          {withGst && (
            <>
              <Field label="GST rate">
                <Select<string>
                  value={f.gstRate === null ? '' : String(f.gstRate)}
                  onChange={(v) => setF({ ...f, gstRate: v === '' ? null : Number(v) })}
                  aria-label="GST rate"
                  options={[{ value: '', label: `Usual rate (${formatRate(features.gstDefaultRate)})` }, ...GST_RATES.map((r) => ({ value: String(r), label: formatRate(r) }))]}
                />
              </Field>
              <Field label="HSN / SAC code" hint="4, 6 or 8 digits, from your supplier's bill" error={m.fields.hsn ?? hsnError}>
                <TextInput value={f.hsn} onChange={(e) => setF({ ...f, hsn: e.target.value.replace(/[^0-9]/g, '') })} maxLength={8} inputMode="numeric" />
              </Field>
            </>
          )}
        </FormGrid>
        {m.error && !m.fields.name && <Alert tone="red">{m.error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Click the rate to change it in place (Enter saves, Esc cancels). */
function RateCell({ item, editable, onSaved }: { item: Item; editable: boolean; onSaved: (i: Item) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<number | null>(item.rate);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) setTimeout(() => ref.current?.focus(), 0);
  }, [editing]);
  if (!editable) return <span className="money">{formatINR(item.rate)}</span>;
  if (!editing) {
    return (
      <button
        type="button"
        className="sl-rate-cell"
        title="Click to change the rate"
        onClick={(e) => {
          e.stopPropagation();
          setValue(item.rate);
          setEditing(true);
        }}
      >
        {formatINR(item.rate)}
      </button>
    );
  }
  const commit = async () => {
    if (value === null || value === item.rate) return setEditing(false);
    setBusy(true);
    try {
      const saved = await call('items.setRate', { id: item.id, rate: value });
      toast.success(`${item.name}: rate changed to ${formatINR(saved.rate)}`);
      onSaved(saved);
      setEditing(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sl-items-rate-edit" onClick={(e) => e.stopPropagation()}>
      <MoneyInput
        ref={ref}
        value={value}
        disabled={busy}
        onChange={setValue}
        aria-label={`New rate for ${item.name}`}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setEditing(false);
          }
        }}
        onBlur={() => void commit()}
      />
    </div>
  );
}

export function ItemsPage() {
  const { can } = useAuth();
  const features = useFeatures();
  const withGst = features.gst === 'regular';
  const toast = useToast();
  const dialogs = useDialogs();
  const manage = can('items.manage');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const dq = useDebounced(q, 200);
  const list = useQuery('items.list', { q: dq.trim() || null, category: category || null, includeInactive: showInactive });
  const cats = useQuery('items.categories', undefined);
  const [modal, setModal] = useState<{ open: boolean; item: Item | null }>({ open: false, item: null });
  useHotkeys({ 'ctrl+n': () => manage && setModal({ open: true, item: null }), F3: () => (document.querySelector('.sl-items-toolbar input[type=search]') as HTMLInputElement | null)?.focus() });

  const refresh = () => {
    void list.reload();
    void cats.reload();
  };

  const toggleActive = async (it: Item) => {
    if (it.isActive) {
      const ok = await dialogs.confirm({
        title: `Deactivate ${it.name}?`,
        message: 'It will no longer appear when billing. Old bills are not affected, and you can re-activate it any time.',
        confirmText: 'Deactivate',
      });
      if (!ok) return;
    }
    try {
      await call('items.setActive', { id: it.id, active: !it.isActive });
      toast.success(`${it.name} ${it.isActive ? 'deactivated' : 're-activated'}`);
      refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  const remove = async (it: Item) => {
    const ok = await dialogs.confirm({
      title: `Delete ${it.name}?`,
      message:
        it.useCount > 0
          ? `${it.name} is on ${it.useCount} bill${it.useCount === 1 ? '' : 's'}, so it cannot be deleted — old bills refer to it. It will be deactivated instead (hidden from billing).`
          : 'This item was never billed, so it will be deleted permanently.',
      confirmText: it.useCount > 0 ? 'Deactivate' : 'Delete',
      danger: it.useCount === 0,
    });
    if (!ok) return;
    try {
      const res = await call('items.remove', { id: it.id });
      if (res.deleted) toast.success(`${it.name} deleted`);
      else toast.info(`${it.name} is used on old bills, so it was deactivated instead of deleted.`);
      refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  const columns: Array<Column<Item>> = [
    {
      key: 'name',
      label: 'Item',
      render: (it) => (
        <span>
          <span className="sl-cell-main">{it.name}</span>
          {it.code && <span className="sl-cell-sub">Code {it.code}</span>}
        </span>
      ),
    },
    { key: 'unit', label: 'Unit' },
    { key: 'rate', label: 'Rate', type: 'money', align: 'right', render: (it) => <RateCell item={it} editable={manage && it.isActive} onSaved={() => void list.reload()} /> },
    { key: 'category', label: 'Category', render: (it) => it.category ?? <span className="faint">—</span> },
    ...(withGst
      ? [
          { key: 'gstRate', label: 'GST', value: (it: Item) => it.gstRate ?? features.gstDefaultRate, render: (it: Item) => gstRateText(it.gstRate, features.gstDefaultRate) } satisfies Column<Item>,
          { key: 'hsn', label: 'HSN', render: (it: Item) => it.hsn ?? <span className="faint">—</span> } satisfies Column<Item>,
        ]
      : []),
    { key: 'useCount', label: 'Times billed', type: 'number', render: (it) => (it.useCount ? it.useCount.toLocaleString('en-IN') : <span className="faint">never</span>) },
    { key: 'lastUsedAt', label: 'Last billed', type: 'datetime' },
    { key: 'isActive', label: 'Status', value: (it) => (it.isActive ? 1 : 0), render: (it) => (it.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>) },
    ...(manage
      ? [
          {
            key: 'actions',
            label: '',
            sortable: false,
            render: (it: Item) => (
              <div className="sl-row-actions" onClick={(e) => e.stopPropagation()}>
                <IconButton label={`Edit ${it.name}`} icon={<Pencil size={15} />} onClick={() => setModal({ open: true, item: it })} />
                <IconButton label={it.isActive ? `Deactivate ${it.name}` : `Re-activate ${it.name}`} icon={<Power size={15} />} onClick={() => void toggleActive(it)} />
                <IconButton label={`Delete ${it.name}`} className="danger" icon={<Trash2 size={15} />} onClick={() => void remove(it)} />
              </div>
            ),
          } satisfies Column<Item>,
        ]
      : []),
  ];

  const report = useMemo<ReportData | null>(() => {
    if (!list.data) return null;
    return {
      title: 'Item price list',
      subtitle: [category || 'All categories', showInactive ? 'including inactive' : 'active items', dq ? `"${dq}"` : ''].filter(Boolean).join(' · '),
      columns: [
        { key: 'name', label: 'Item', width: 30 },
        { key: 'code', label: 'Code', width: 14 },
        { key: 'unit', label: 'Unit', width: 8 },
        { key: 'rate', label: 'Rate', type: 'money', width: 12 },
        { key: 'category', label: 'Category', width: 16 },
        ...(withGst ? [{ key: 'gst', label: 'GST', width: 10 }, { key: 'hsn', label: 'HSN', width: 10 }] : []),
        { key: 'uses', label: 'Times billed', type: 'number', width: 12 },
        { key: 'status', label: 'Status', width: 10 },
      ],
      rows: list.data.map((it) => ({
        cells: {
          name: it.name,
          code: it.code ?? '',
          unit: it.unit,
          rate: it.rate,
          category: it.category ?? '',
          gst: gstRateText(it.gstRate, features.gstDefaultRate),
          hsn: it.hsn ?? '',
          uses: it.useCount,
          status: it.isActive ? 'Active' : 'Inactive',
        },
      })),
    };
  }, [list.data, category, showInactive, dq, withGst, features.gstDefaultRate]);

  const filtered = !!(dq || category);
  return (
    <Page>
      <PageHeader
        title="Items & rates"
        subtitle="Your price list for quick billing. Stock is not tracked."
        actions={
          <>
            <ExportButtons report={report} disabled={!list.data?.length} />
            {manage && (
              <Button variant="primary" icon={<Plus size={16} />} kbd="Ctrl+N" onClick={() => setModal({ open: true, item: null })}>
                Add item
              </Button>
            )}
          </>
        }
      />
      {!manage && <Alert tone="neutral">You can look up items and rates. Ask the owner if you need to add items or change rates.</Alert>}
      <Toolbar className="sl-items-toolbar mt-1">
        <SearchInput value={q} onChange={setQ} placeholder="Search name, code or category… (F3)" />
        <Select<string>
          value={category}
          onChange={setCategory}
          aria-label="Category"
          options={[{ value: '', label: 'All categories' }, ...(cats.data ?? []).map((c) => ({ value: c, label: c }))]}
          style={{ width: 'auto', minWidth: 170 }}
        />
        <Checkbox checked={showInactive} onChange={setShowInactive} label="Show inactive items" />
        <span className="spacer" />
        {list.data && (
          <span className="muted small">
            {list.data.length} item{list.data.length === 1 ? '' : 's'}
          </span>
        )}
      </Toolbar>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      <div className="card sl-list-card">
        <DataTable<Item>
          columns={columns}
          rows={list.data}
          rowKey={(it) => it.id}
          loading={list.loading}
          onRowClick={manage ? (it) => setModal({ open: true, item: it }) : undefined}
          rowClassName={(it) => (it.isActive ? '' : 'sl-inactive')}
          initialSort={{ key: 'name', dir: 'asc' }}
          empty={
            <EmptyState
              icon={<Package size={32} />}
              title={filtered ? 'No items match your search' : 'No items yet'}
              message={filtered ? 'Try another name, or clear the category filter.' : 'Add the things you sell with their usual rates. You can still type any item name while billing.'}
              action={
                manage && !filtered ? (
                  <Button variant="primary" icon={<Plus size={16} />} onClick={() => setModal({ open: true, item: null })}>
                    Add your first item
                  </Button>
                ) : undefined
              }
            />
          }
        />
      </div>
      {manage && <p className="faint small mt-1">Tip: click a rate to change it quickly. Items that were billed cannot be deleted, only deactivated.</p>}
      <ItemModal
        open={modal.open}
        item={modal.item}
        categories={cats.data ?? []}
        onClose={() => setModal({ open: false, item: null })}
        onSaved={(it, created) => {
          toast.success(created ? `Added ${it.name} at ${formatINR(it.rate)}/${it.unit}` : `Saved ${it.name}`);
          setModal({ open: false, item: null });
          refresh();
        }}
      />
    </Page>
  );
}
