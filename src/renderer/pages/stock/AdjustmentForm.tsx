import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Plus, Save, Trash2 } from 'lucide-react';
import { Alert, Button, Card, IconButton, Page, PageHeader } from '../../components/ui';
import { Combobox, DateInput, Field, FormGrid, MoneyInput, NumberInput, SegmentedControl, TextInput } from '../../components/forms';
import { call, type ApiOutput } from '../../api';
import { useMutation, useQuery } from '../../hooks';
import { useToast, useUnsavedWarning } from '../../feedback';
import { formatQty } from '../../../shared/money';
import { todayISO } from '../../../shared/dates';
import './stock.css';

type Kind = 'count' | 'adjust';
type StockItem = ApiOutput<'stock.summary'>['items'][number];

interface Line {
  key: number;
  item: { id: number; name: string; unit: string } | null;
  text: string;
  /** count: quantity found; adjust: change (+ / -). */
  qty: number | null;
  unitCost: number | null;
  note: string;
}

let nextKey = 1;
const blank = (): Line => ({ key: nextKey++, item: null, text: '', qty: null, unitCost: null, note: '' });

const REASONS = ['Damaged', 'Expired', 'Lost / theft', 'Own use', 'Free sample', 'Found in stock'];

/** Stock count (enter what is on the shelf) or adjustment (add / take out, with a reason). */
export function AdjustmentFormPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>(params.get('kind') === 'count' ? 'count' : 'adjust');
  const [date, setDate] = useState(todayISO());
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<Line[]>([blank()]);
  const m = useMutation('stock.adjust');
  const stock = useQuery('stock.summary', { asOf: date, includeInactive: true });
  const byId = useMemo(() => new Map((stock.data?.items ?? []).map((s) => [s.itemId, s])), [stock.data]);
  const dirty = lines.some((l) => l.item) || !!reason;
  useUnsavedWarning(dirty);

  // /stock/adjustments/new?item=12 starts with that item.
  useEffect(() => {
    const itemId = Number(params.get('item'));
    if (!itemId || !stock.data) return;
    const s = stock.data.items.find((x) => x.itemId === itemId);
    if (s && !lines.some((l) => l.item)) setLines([{ ...blank(), item: { id: s.itemId, name: s.name, unit: s.unit }, text: s.name }, blank()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stock.data]);

  const setLine = (key: number, patch: Partial<Line>) => {
    setLines((ls) => {
      const next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l));
      return next[next.length - 1].item ? [...next, blank()] : next;
    });
  };
  const filled = lines.filter((l) => l.item);
  const change = (l: Line, s: StockItem | undefined) => (l.qty === null ? null : kind === 'count' ? Math.round((l.qty - (s?.qty ?? 0)) * 1000) / 1000 : l.qty);
  const problem = !filled.length
    ? 'Add at least one item'
    : filled.some((l) => l.qty === null)
      ? kind === 'count'
        ? 'Enter the quantity found for every item'
        : 'Enter the change for every item'
      : kind === 'adjust' && !reason.trim()
        ? 'Choose or write a reason'
        : null;

  const save = async () => {
    if (problem) return;
    try {
      const saved = await m.run({
        date,
        kind,
        reason: reason.trim() || null,
        lines: filled.map((l) => ({
          itemId: l.item!.id,
          ...(kind === 'count' ? { counted: l.qty } : { qty: l.qty }),
          unitCost: l.unitCost,
          note: l.note.trim() || null,
        })),
      });
      toast.success(`${kind === 'count' ? 'Stock count' : 'Stock adjustment'} ${saved.adjNo} saved`);
      navigate(`/stock/adjustments/${saved.id}`);
    } catch {
      /* shown below */
    }
  };

  return (
    <Page>
      <PageHeader
        title={kind === 'count' ? 'Stock count' : 'Adjust stock'}
        subtitle={kind === 'count' ? 'Count what is on the shelf; Billforce corrects the stock to it' : 'Add or take out stock that did not come through a bill or purchase'}
        back="/stock/adjustments"
      />
      <div className="stack">
        <Card>
          <FormGrid cols={3}>
            <Field label="What are you doing?">
              <SegmentedControl<Kind>
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'count', label: 'Stock count' },
                  { value: 'adjust', label: 'Add / take out' },
                ]}
              />
            </Field>
            <Field label="Date" required>
              <DateInput value={date} max={todayISO()} onChange={(v) => v && setDate(v)} />
            </Field>
            <Field label="Reason" required={kind === 'adjust'} error={m.fields.reason}>
              <TextInput value={reason} list="stock-reasons" maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder={kind === 'count' ? 'e.g. Monthly count' : 'e.g. Damaged'} />
              <datalist id="stock-reasons">
                {REASONS.map((r) => (
                  <option key={r} value={r} />
                ))}
              </datalist>
            </Field>
          </FormGrid>
        </Card>
        <Card title="Items" padded={false}>
          <div className="card-body stack-sm">
            <div className={`st-grid st-head${kind === 'count' ? ' st-grid-count' : ''}`}>
              <span>Item</span>
              <span className="r">In the books</span>
              <span className="r">{kind === 'count' ? 'Found' : 'Change (+ / −)'}</span>
              {kind === 'count' && <span className="r">Difference</span>}
              <span className="r">Cost per unit</span>
              <span>Note</span>
              <span />
            </div>
            <div className="st-lines">
              {lines.map((l, i) => {
                const s = l.item ? byId.get(l.item.id) : undefined;
                const diff = change(l, s);
                return (
                  <div className={`st-grid${kind === 'count' ? ' st-grid-count' : ''}`} key={l.key}>
                    <Combobox<StockItem>
                      value={l.text}
                      onInputChange={(text) => setLine(l.key, { text, item: null })}
                      loadOptions={async (q) => (stock.data?.items ?? (await call('stock.summary', { asOf: date, includeInactive: true })).items).filter((x) => x.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 12)}
                      getKey={(x) => x.itemId}
                      renderOption={(x) => (
                        <div className="combo-option">
                          <div>{x.name}</div>
                          <span className="small muted">{`${formatQty(x.qty)} ${x.unit}`}</span>
                        </div>
                      )}
                      onSelect={(x) => setLine(l.key, { item: { id: x.itemId, name: x.name, unit: x.unit }, text: x.name })}
                      placeholder={i === 0 ? 'Choose an item…' : 'Add another item…'}
                      openOnFocus
                      aria-label={`Line ${i + 1} item`}
                    />
                    <span className="st-book">{l.item ? `${formatQty(s?.qty ?? 0)} ${l.item.unit}` : ''}</span>
                    <NumberInput value={l.qty} decimals={3} allowNegative={kind === 'adjust'} onChange={(v) => setLine(l.key, { qty: v })} aria-label={`Line ${i + 1} quantity`} disabled={!l.item} />
                    {kind === 'count' && (
                      <span className={`r ${diff === null ? '' : diff > 0 ? 'st-change-pos' : diff < 0 ? 'st-change-neg' : 'muted'}`}>
                        {diff === null || !l.item ? '' : diff === 0 ? 'no change' : `${diff > 0 ? '+' : ''}${formatQty(diff)} ${l.item.unit}`}
                      </span>
                    )}
                    <MoneyInput
                      value={l.unitCost}
                      onChange={(v) => setLine(l.key, { unitCost: v })}
                      placeholder={s?.costKnown ? 'Average' : 'Enter cost'}
                      aria-label={`Line ${i + 1} cost per unit`}
                      disabled={!l.item || !(diff !== null && diff > 0)}
                    />
                    <TextInput value={l.note} maxLength={200} onChange={(e) => setLine(l.key, { note: e.target.value })} disabled={!l.item} aria-label={`Line ${i + 1} note`} />
                    {l.item ? <IconButton label="Remove line" icon={<Trash2 size={15} />} className="danger" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} /> : <span />}
                  </div>
                );
              })}
            </div>
            <p className="small muted mb-0">
              {kind === 'count'
                ? 'The difference between what you found and what the books show is added or taken out on the date of the count. Stock found is valued at the average cost unless you enter a cost (enter it for items never bought, or they are valued at nothing).'
                : 'Stock added is valued at the average cost unless you enter a cost. Stock taken out lowers the stock value (and so the profit).'}
            </p>
          </div>
        </Card>
        {m.error && <Alert tone="red">{m.error}</Alert>}
        <div className="row">
          <Button variant="primary" icon={<Save size={16} />} loading={m.loading} disabled={!!problem} onClick={() => void save()}>
            Save
          </Button>
          <Button variant="ghost" icon={<Plus size={16} />} onClick={() => setLines((ls) => [...ls, blank()])}>
            Add line
          </Button>
          {problem && filled.length > 0 && <span className="small muted">{problem}</span>}
        </div>
      </div>
    </Page>
  );
}
