import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ChefHat, ListPlus, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { call, type ApiOutput } from '../../api';
import { useDebounced, useHotkeys, useMutation, useQuery } from '../../hooks';
import { useAuth, useCanSeeCosts, useFeatures } from '../../auth';
import { useDialogs, useToast } from '../../feedback';
import { Alert, Badge, Button, EmptyState, ErrorBox, IconButton, Page, PageHeader, Toolbar } from '../../components/ui';
import { Checkbox, Combobox, Field, FormGrid, MoneyInput, NumberInput, SearchInput, Select, TextInput } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { ExportButtons } from '../../components/report';
import { Modal } from '../../components/modal';
import { formatINR, formatQty } from '../../../shared/money';
import { GST_RATES, formatRate, hsnProblem } from '../../../shared/gst';
import { compatibleUnits, convertQty } from '../../../shared/units';
import { gstRateText } from '../sales/ItemsPage';
import { IngredientModal } from './IngredientsPage';
import './menu.css';

type Dish = ApiOutput<'menu.list'>[number];
type Ingredient = ApiOutput<'menu.ingredients'>[number];

const DISH_UNITS = ['plate', 'half plate', 'bowl', 'glass', 'cup', 'pcs', 'portion', 'kg', 'ltr'];

interface Line {
  key: number;
  ingredient: Ingredient | null;
  text: string;
  qty: number | null;
  unit: string;
  note: string;
}

let nextKey = 1;
const blank = (): Line => ({ key: nextKey++, ingredient: null, text: '', qty: null, unit: '', note: '' });

/** Units a recipe may use for an ingredient: g for kg, ml for ltr ... (the smaller unit first). */
function recipeUnits(stockUnit: string): string[] {
  const units = compatibleUnits(stockUnit);
  return units.length > 1 ? [...units].sort((a, b) => (convertQty(1, a, stockUnit) ?? 1) - (convertQty(1, b, stockUnit) ?? 1)) : units;
}

/** "Chicken 250 g, Butter 20 g" */
export function recipeText(d: Dish): string {
  return d.recipe.map((l) => `${l.ingredientName} ${formatQty(l.qty)} ${l.unit}`).join(', ');
}

function DishModal({ open, dish, categories, onClose, onSaved }: { open: boolean; dish: Dish | null; categories: string[]; onClose: () => void; onSaved: (d: Dish, created: boolean) => void }) {
  const features = useFeatures();
  const showCost = useCanSeeCosts();
  const withGst = features.gst === 'regular';
  const m = useMutation('menu.save');
  const ingredients = useQuery('menu.ingredients', open ? undefined : null);
  const [name, setName] = useState('');
  const [rate, setRate] = useState<number | null>(null);
  const [unit, setUnit] = useState('plate');
  const [category, setCategory] = useState('');
  const [code, setCode] = useState('');
  const [gstRate, setGstRate] = useState<number | null>(null);
  const [hsn, setHsn] = useState('');
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [newIngredient, setNewIngredient] = useState<{ open: boolean; name: string; lineKey: number | null }>({ open: false, name: '', lineKey: null });

  useEffect(() => {
    if (!open) return;
    m.reset();
    setName(dish?.item.name ?? '');
    setRate(dish ? dish.item.rate : null);
    setUnit(dish?.item.unit ?? 'plate');
    setCategory(dish?.item.category ?? '');
    setCode(dish?.item.code ?? '');
    setGstRate(dish?.item.gstRate ?? null);
    setHsn(dish?.item.hsn ?? '');
    setLines([
      ...(dish?.recipe ?? []).map((l) => ({
        key: nextKey++,
        ingredient: { id: l.ingredientId, name: l.ingredientName, unit: l.ingredientUnit } as Ingredient,
        text: l.ingredientName,
        qty: l.qty,
        unit: l.unit,
        note: l.note ?? '',
      })),
      blank(),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dish]);

  const setLine = (key: number, patch: Partial<Line>) =>
    setLines((ls) => {
      const next = ls.map((l) => (l.key === key ? { ...l, ...patch } : l));
      return next[next.length - 1].ingredient ? [...next, blank()] : next;
    });
  const pick = (key: number, ing: Ingredient) => setLine(key, { ingredient: ing, text: ing.name, unit: recipeUnits(ing.unit)[0] ?? ing.unit });

  const filled = lines.filter((l) => l.ingredient);
  const hsnError = withGst ? hsnProblem(hsn) : null;
  const ids = filled.map((l) => l.ingredient!.id);
  const problem = !name.trim()
    ? 'Enter the name of the dish'
    : rate === null
      ? 'Enter the price'
      : filled.some((l) => !l.qty || l.qty <= 0)
        ? 'Enter the quantity of every ingredient'
        : new Set(ids).size !== ids.length
          ? 'An ingredient is listed twice: enter its total quantity once'
          : hsnError;

  // Cost of each line at the ingredient's average cost.
  const costOf = useMemo(() => new Map((ingredients.data ?? []).map((i) => [i.id, i.avgCost])), [ingredients.data]);
  const lineCost = (l: Line) => {
    if (!l.ingredient || !l.qty) return undefined;
    const per = costOf.get(l.ingredient.id);
    const inUnit = convertQty(l.qty, l.unit, l.ingredient.unit);
    return per === undefined || per === null || inUnit === null ? undefined : Math.round(per * inUnit);
  };
  const costs = filled.map(lineCost);
  const total = filled.length && costs.every((c) => c !== undefined) ? costs.reduce((a, c) => a + (c ?? 0), 0) : null;

  const save = async () => {
    if (problem || m.loading) return;
    try {
      const saved = await m.run({
        id: dish?.item.id ?? null,
        name: name.trim(),
        rate: rate ?? 0,
        unit,
        category: category.trim() || null,
        code: code.trim() || null,
        ...(withGst ? { gstRate, hsn: hsn.trim() || null } : {}),
        recipe: filled.map((l) => ({ ingredientId: l.ingredient!.id, qty: l.qty!, unit: l.unit || l.ingredient!.unit, note: l.note.trim() || null })),
      });
      onSaved(saved, !dish);
    } catch {
      /* shown below */
    }
  };

  const unitOptions = DISH_UNITS.includes(unit) ? DISH_UNITS : [unit, ...DISH_UNITS];
  return (
    <Modal
      open={open}
      title={dish ? `Edit ${dish.item.name}` : 'Add a dish'}
      onClose={onClose}
      width={820}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={m.loading} disabled={!!problem} onClick={() => void save()} title={problem ?? undefined}>
            {dish ? 'Save dish' : 'Add dish'}
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
        <FormGrid cols={3}>
          <Field label="Dish name" required error={m.fields.name} className="span-2">
            <TextInput autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Butter Chicken" />
          </Field>
          <Field label="Price" required hint={withGst ? (features.gstInclusive ? 'Including GST' : 'Without GST') : undefined}>
            <MoneyInput value={rate} onChange={setRate} placeholder="0.00" aria-label="Price" />
          </Field>
          <Field label="Sold by">
            <Select<string> value={unit} onChange={setUnit} options={unitOptions.map((u) => ({ value: u, label: u }))} aria-label="Sold by" />
          </Field>
          <Field label="Category" hint="e.g. Starters, Main course">
            <TextInput value={category} maxLength={60} onChange={(e) => setCategory(e.target.value)} list="menu-categories" />
            <datalist id="menu-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="Code" hint="Optional short code for billing">
            <TextInput value={code} maxLength={40} onChange={(e) => setCode(e.target.value)} />
          </Field>
          {withGst && (
            <>
              <Field label="GST rate">
                <Select<string>
                  value={gstRate === null ? '' : String(gstRate)}
                  onChange={(v) => setGstRate(v === '' ? null : Number(v))}
                  aria-label="GST rate"
                  options={[{ value: '', label: `Usual rate (${formatRate(features.gstDefaultRate)})` }, ...GST_RATES.map((r) => ({ value: String(r), label: formatRate(r) }))]}
                />
              </Field>
              <Field label="HSN / SAC code" error={m.fields.hsn ?? hsnError}>
                <TextInput value={hsn} maxLength={8} inputMode="numeric" onChange={(e) => setHsn(e.target.value.replace(/[^0-9]/g, ''))} />
              </Field>
            </>
          )}
        </FormGrid>

        <div className="mn-recipe">
          <div className="mn-recipe-head">
            <b>Recipe for one {unit}</b>
            <span className="small muted">{features.stock ? 'Selling the dish takes these out of stock.' : 'Turn on stock tracking to take these out of stock when the dish is sold.'}</span>
          </div>
          <div className="mn-grid mn-grid-head">
            <span>Ingredient</span>
            <span className="r">Quantity</span>
            <span>Unit</span>
            <span>Note</span>
            <span className="r">{showCost ? 'Cost' : ''}</span>
            <span />
          </div>
          <div className="mn-lines">
            {lines.map((l, i) => {
              const cost = lineCost(l);
              return (
                <div className="mn-grid" key={l.key}>
                  <Combobox<Ingredient>
                    value={l.text}
                    onInputChange={(text) => setLine(l.key, { text, ingredient: null })}
                    loadOptions={async (q) => {
                      const list = ingredients.data ?? (await call('menu.ingredients'));
                      const t = q.trim().toLowerCase();
                      return list.filter((x) => x.isActive && x.name.toLowerCase().includes(t)).slice(0, 12);
                    }}
                    getKey={(x) => x.id}
                    renderOption={(x) => (
                      <div className="combo-option">
                        <div>{x.name}</div>
                        <span className="small muted">{x.stock === null ? x.unit : `${formatQty(x.stock)} ${x.unit} in stock`}</span>
                      </div>
                    )}
                    onSelect={(x) => pick(l.key, x)}
                    footer={(close) => (
                      <button
                        type="button"
                        className="combo-add"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          close();
                          setNewIngredient({ open: true, name: l.text.trim(), lineKey: l.key });
                        }}
                      >
                        <Plus size={14} /> New ingredient{l.text.trim() ? ` "${l.text.trim()}"` : ''}
                      </button>
                    )}
                    placeholder={i === 0 ? 'Choose an ingredient…' : 'Add another ingredient…'}
                    openOnFocus
                    aria-label={`Ingredient ${i + 1}`}
                  />
                  <NumberInput value={l.qty} decimals={3} onChange={(v) => setLine(l.key, { qty: v })} aria-label={`Ingredient ${i + 1} quantity`} disabled={!l.ingredient} />
                  {l.ingredient ? (
                    <Select<string> value={l.unit} onChange={(u) => setLine(l.key, { unit: u })} options={recipeUnits(l.ingredient.unit).map((u) => ({ value: u, label: u }))} aria-label={`Ingredient ${i + 1} unit`} />
                  ) : (
                    <span />
                  )}
                  <TextInput value={l.note} maxLength={200} onChange={(e) => setLine(l.key, { note: e.target.value })} disabled={!l.ingredient} placeholder="optional" aria-label={`Ingredient ${i + 1} note`} />
                  <span className="r small muted">{cost === undefined ? '' : formatINR(cost)}</span>
                  {l.ingredient ? <IconButton label="Remove ingredient" icon={<Trash2 size={15} />} className="danger" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} /> : <span />}
                </div>
              );
            })}
          </div>
          {!filled.length ? (
            <p className="small muted mb-0">A dish without a recipe can still be sold; it just does not take anything out of stock.</p>
          ) : (
            total !== null && (
              <p className="small mb-0 mn-recipe-total">
                Recipe cost <b>{formatINR(total)}</b>
                {rate ? ` · food cost ${Math.round((total / rate) * 1000) / 10}% of the price` : ''}
              </p>
            )
          )}
        </div>
        {m.error && !m.fields.name && <Alert tone="red">{m.error}</Alert>}
        <button type="submit" hidden />
      </form>
      <IngredientModal
        open={newIngredient.open}
        initialName={newIngredient.name}
        onClose={() => setNewIngredient({ open: false, name: '', lineKey: null })}
        onSaved={(ing) => {
          void ingredients.reload();
          if (newIngredient.lineKey !== null) pick(newIngredient.lineKey, ing);
          setNewIngredient({ open: false, name: '', lineKey: null });
        }}
      />
    </Modal>
  );
}

/** Dishes are not stocked themselves, so an item with stock left cannot go on the menu. */
const hasStock = (i: { stock: number | null }) => i.stock !== null && i.stock !== 0;

/** Put items the business already sells on the menu. */
function AddItemsModal({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (n: number) => void }) {
  const q = useQuery('menu.candidates', open ? undefined : null);
  const m = useMutation('menu.addItems');
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (open) {
      setChosen(new Set());
      m.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const list = q.data ?? [];
  const choosable = list.filter((i) => !hasStock(i));
  const all = choosable.length > 0 && chosen.size === choosable.length;
  return (
    <Modal
      open={open}
      title="Put my items on the menu"
      onClose={onClose}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={m.loading}
            disabled={!chosen.size}
            onClick={async () => {
              try {
                const r = await m.run({ itemIds: [...chosen] });
                onAdded(r.added);
              } catch {
                /* shown below */
              }
            }}
          >
            Put {chosen.size || ''} on the menu
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="muted mt-0 mb-0">Choose the items that are dishes you cook. You can then give each one a recipe. Dishes are not kept in stock themselves: their ingredients are.</p>
        {q.error && <ErrorBox error={q.error} onRetry={q.reload} />}
        {q.data && !list.length && <Alert tone="neutral">All your items are already on the menu or used as ingredients.</Alert>}
        {list.length > 0 && (
          <>
            <Checkbox checked={all} onChange={(v) => setChosen(v ? new Set(choosable.map((i) => i.id)) : new Set())} label={<b>Choose all ({choosable.length})</b>} />
            <div className="mn-pick-list">
              {list.map((i) => (
                <Checkbox
                  key={i.id}
                  checked={chosen.has(i.id)}
                  disabled={hasStock(i)}
                  onChange={(v) => {
                    const next = new Set(chosen);
                    if (v) next.add(i.id);
                    else next.delete(i.id);
                    setChosen(next);
                  }}
                  label={
                    <span>
                      {i.name} <span className="muted small">{`${formatINR(i.rate)}/${i.unit}${i.category ? ` · ${i.category}` : ''}`}</span>
                      {hasStock(i) && <span className="warn-text small">{` · ${formatQty(i.stock!)} ${i.unit} in stock: count it to 0 first`}</span>}
                    </span>
                  }
                />
              ))}
            </div>
          </>
        )}
        {m.error && <Alert tone="red">{m.error}</Alert>}
      </div>
    </Modal>
  );
}

export function MenuPage() {
  const { can } = useAuth();
  const features = useFeatures();
  const withGst = features.gst === 'regular';
  const manage = can('items.manage');
  const toast = useToast();
  const dialogs = useDialogs();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const dq = useDebounced(q, 150);
  const list = useQuery('menu.list', { includeInactive: showInactive });
  const showCost = useCanSeeCosts();
  const costing = useQuery('menu.costing', showCost ? undefined : null);
  const [modal, setModal] = useState<{ open: boolean; dish: Dish | null }>({ open: false, dish: null });
  const [adding, setAdding] = useState(false);
  useHotkeys({ 'ctrl+n': () => manage && setModal({ open: true, dish: null }) });

  const categories = useMemo(() => [...new Set((list.data ?? []).map((d) => d.item.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b)), [list.data]);
  const rows = useMemo(() => {
    const t = dq.trim().toLowerCase();
    return (list.data ?? []).filter((d) => (!category || d.item.category === category) && (!t || d.item.name.toLowerCase().includes(t) || d.recipe.some((l) => l.ingredientName.toLowerCase().includes(t))));
  }, [list.data, dq, category]);

  const toggleActive = async (d: Dish) => {
    if (d.item.isActive) {
      const ok = await dialogs.confirm({ title: `Take ${d.item.name} off the menu?`, message: 'It will no longer appear when billing. Old bills are not affected, and you can bring it back any time.', confirmText: 'Take off the menu' });
      if (!ok) return;
    }
    try {
      await call('items.setActive', { id: d.item.id, active: !d.item.isActive });
      toast.success(d.item.isActive ? `${d.item.name} taken off the menu` : `${d.item.name} is back on the menu`);
      void list.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const costColumns: Array<Column<Dish>> = [
    {
      key: 'cost',
      label: 'Recipe cost',
      align: 'right',
      value: (d) => d.recipeCost ?? -1,
      render: (d) =>
        d.recipeCost === null ? (
          <span className="faint">{d.recipe.length ? 'no cost yet' : '—'}</span>
        ) : (
          <span title={d.costMissing.length ? `Leaves out ${d.costMissing.join(', ')} (not bought yet)` : undefined}>
            <span className="money">{formatINR(d.recipeCost)}</span>
            {d.costMissing.length > 0 && <span className="sl-cell-sub">{`+ ${d.costMissing.length} not bought yet`}</span>}
          </span>
        ),
    },
    {
      key: 'pct',
      label: 'Food cost',
      align: 'right',
      value: (d) => d.foodCostPct ?? -1,
      render: (d) => (d.foodCostPct === null ? <span className="faint">—</span> : <span className={d.foodCostPct > 40 ? 'warn-text' : ''}>{`${d.foodCostPct}%`}</span>),
    },
  ];

  const columns: Array<Column<Dish>> = [
    {
      key: 'name',
      label: 'Dish',
      value: (d) => d.item.name,
      render: (d) => (
        <span className="mn-dish-cell">
          <span className="sl-cell-main">{d.item.name}</span>
          <span className="sl-cell-sub">{d.recipe.length ? recipeText(d) : 'No recipe yet'}</span>
        </span>
      ),
    },
    { key: 'category', label: 'Category', value: (d) => d.item.category ?? '', render: (d) => d.item.category ?? <span className="faint">—</span> },
    { key: 'rate', label: 'Price', type: 'money', align: 'right', value: (d) => d.item.rate, render: (d) => <span className="money">{`${formatINR(d.item.rate)}/${d.item.unit}`}</span> },
    ...(withGst ? [{ key: 'gst', label: 'GST', value: (d: Dish) => d.item.gstRate ?? features.gstDefaultRate, render: (d: Dish) => gstRateText(d.item.gstRate, features.gstDefaultRate) } satisfies Column<Dish>] : []),
    ...(showCost ? costColumns : []),
    { key: 'uses', label: 'Times billed', type: 'number', value: (d) => d.item.useCount, render: (d) => (d.item.useCount ? d.item.useCount.toLocaleString('en-IN') : <span className="faint">never</span>) },
    { key: 'status', label: 'Status', value: (d) => (d.item.isActive ? 1 : 0), render: (d) => (d.item.isActive ? <Badge tone="green">On the menu</Badge> : <Badge>Off the menu</Badge>) },
    ...(manage
      ? [
          {
            key: 'actions',
            label: '',
            sortable: false,
            render: (d: Dish) => (
              <div className="sl-row-actions" onClick={(e) => e.stopPropagation()}>
                <IconButton label={`Edit ${d.item.name}`} icon={<Pencil size={15} />} onClick={() => setModal({ open: true, dish: d })} />
                <IconButton label={d.item.isActive ? `Take ${d.item.name} off the menu` : `Put ${d.item.name} back on the menu`} icon={<Power size={15} />} onClick={() => void toggleActive(d)} />
              </div>
            ),
          } satisfies Column<Dish>,
        ]
      : []),
  ];

  return (
    <Page wide>
      <PageHeader
        title="Menu & recipes"
        subtitle={features.stock ? 'Your dishes and what goes into them. Selling a dish takes its ingredients out of stock.' : 'Your dishes, their prices and what goes into them'}
        actions={
          <>
            {costing.data && <ExportButtons report={costing.data} load={() => call('menu.costing')} />}
            {manage && (
              <Button icon={<ListPlus size={16} />} onClick={() => setAdding(true)}>
                Add from my items
              </Button>
            )}
            {manage && (
              <Button variant="primary" icon={<Plus size={16} />} kbd="Ctrl+N" onClick={() => setModal({ open: true, dish: null })}>
                Add dish
              </Button>
            )}
          </>
        }
      />
      <Toolbar className="mt-1">
        <SearchInput value={q} onChange={setQ} placeholder="Search dishes or ingredients…" />
        {categories.length > 0 && (
          <Select<string>
            value={category}
            onChange={setCategory}
            aria-label="Category"
            options={[{ value: '', label: 'All categories' }, ...categories.map((c) => ({ value: c, label: c }))]}
            style={{ width: 'auto', minWidth: 170 }}
          />
        )}
        <Checkbox checked={showInactive} onChange={setShowInactive} label="Show dishes off the menu" />
        <span className="spacer" />
        <Link to="/menu/ingredients" className="small">
          Ingredients →
        </Link>
      </Toolbar>
      {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
      <div className="card sl-list-card">
        <DataTable<Dish>
          columns={columns}
          rows={list.data ? rows : undefined}
          rowKey={(d) => d.item.id}
          loading={list.loading}
          onRowClick={manage ? (d) => setModal({ open: true, dish: d }) : undefined}
          rowClassName={(d) => (d.item.isActive ? '' : 'sl-inactive')}
          initialSort={{ key: 'category', dir: 'asc' }}
          empty={
            <EmptyState
              icon={<ChefHat size={32} />}
              title={dq || category ? 'No dishes match your search' : 'No dishes yet'}
              message={dq || category ? 'Try another name.' : 'Add your dishes with their price and recipe, or put the items you already sell on the menu.'}
              action={
                manage && !dq && !category ? (
                  <div className="row">
                    <Button variant="primary" icon={<Plus size={16} />} onClick={() => setModal({ open: true, dish: null })}>
                      Add your first dish
                    </Button>
                    <Button icon={<ListPlus size={16} />} onClick={() => setAdding(true)}>
                      Add from my items
                    </Button>
                  </div>
                ) : undefined
              }
            />
          }
        />
      </div>
      {showCost && <p className="faint small mt-1">Food cost = recipe cost ÷ price, from the average cost of each ingredient (what you paid for it). Dishes over 40% are marked.</p>}
      <DishModal
        open={modal.open}
        dish={modal.dish}
        categories={categories}
        onClose={() => setModal({ open: false, dish: null })}
        onSaved={(d, created) => {
          toast.success(created ? `Added ${d.item.name} to the menu` : `Saved ${d.item.name}`);
          setModal({ open: false, dish: null });
          void list.reload();
          void costing.reload();
        }}
      />
      <AddItemsModal
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(n) => {
          toast.success(n ? `Put ${n} item${n === 1 ? '' : 's'} on the menu. Now add their recipes.` : 'Those items were already on the menu');
          setAdding(false);
          void list.reload();
        }}
      />
    </Page>
  );
}
