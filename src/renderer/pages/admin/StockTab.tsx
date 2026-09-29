import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Card } from '../../components/ui';
import { Switch } from '../../components/forms';
import { useHotkeys } from '../../hooks';
import { useAuth } from '../../auth';
import { useToast } from '../../feedback';
import { call } from '../../api';
import type { AppSettings, MenuSettings, StockSettings } from '../../../shared/settings';
import { useSectionForm } from './useSectionForm';
import { SaveBar, SwitchRow } from './common';

export function StockTab({
  settings,
  onSaved,
  onMenuSaved,
  onDirty,
}: {
  settings: AppSettings;
  onSaved: (v: StockSettings) => void;
  onMenuSaved: (v: MenuSettings) => void;
  onDirty: (d: boolean) => void;
}) {
  const { refresh, can } = useAuth();
  const toast = useToast();
  const f = useSectionForm('stock', settings.stock, onSaved);
  const mf = useSectionForm('menu', settings.menu, onMenuSaved);
  const [tracking, setTracking] = useState(false);
  const dirty = f.dirty || mf.dirty;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const save = async () => {
    // The sidebar shows the stock and menu pages only while they are on.
    const a = f.dirty ? await f.save('Stock settings saved') : false;
    const b = mf.dirty ? await mf.save('Menu settings saved') : false;
    if (a || b) await refresh();
  };
  useHotkeys({ 'ctrl+s': () => void save() }, [f.save, mf.save]);
  const d = f.draft;
  const md = mf.draft;
  if (!d || !md) return null;
  const on = settings.stock.enabled;
  const menuOn = settings.menu.enabled;
  const trackAll = async () => {
    setTracking(true);
    try {
      const r = await call('stock.trackAll');
      toast.success(r.changed ? `Stock is now tracked for ${r.changed} more item${r.changed === 1 ? '' : 's'}` : 'All items were already tracked');
    } catch (e) {
      toast.error(e);
    } finally {
      setTracking(false);
    }
  };
  return (
    <form
      className="stack settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Card title="Stock / inventory">
        <div className="switch-list">
          <SwitchRow
            title="Track stock"
            hint="Bills take goods out of stock, purchases and returns bring them in. See stock levels, get low-stock alerts, and value your stock at the average purchase cost in Profit & loss and the Balance sheet."
          >
            <Switch checked={d.enabled} onChange={(v) => f.set('enabled', v)} />
          </SwitchRow>
        </div>
        {d.enabled !== on && (
          <Alert tone="blue">
            {d.enabled
              ? 'After saving: choose the items to track (or track all of them below), then enter your opening stock or do a stock count.'
              : 'Stock screens will be hidden, and from then on purchases are expenses when made. The stock left is taken out of the books today (a stock adjustment named "Stock tracking turned off"), so your profit stops counting stock nobody tracks. If you turn tracking on again, cancel that adjustment or do a stock count.'}
          </Alert>
        )}
      </Card>
      {on && (
        <Card title="Getting started">
          <div className="stack">
            <ol className="mt-0 mb-0">
              <li>
                Choose which items to track in <Link to="/sales/items">Items &amp; rates</Link> (services usually are not), and set a low-stock level for each.
              </li>
              <li>
                Enter the stock you had when your books started in <Link to="/stock/opening">Opening stock</Link>, or count your shelves now with a{' '}
                <Link to="/stock/adjustments/new?kind=count">stock count</Link>.
              </li>
              <li>In purchase bills, pick the item for each line so the goods come into stock at their cost.</li>
            </ol>
            {can('stock.manage') && (
              <div>
                <Button onClick={() => void trackAll()} loading={tracking}>
                  Track all items (except services)
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}
      <Card title="Restaurant menu">
        <div className="switch-list">
          <SwitchRow
            title="Menu with recipes"
            hint="For restaurants, cafés and sweet shops: add dishes (for example Butter Chicken) with a recipe listing the exact ingredients and quantities. With stock tracking on, selling a dish takes its ingredients out of stock."
          >
            <Switch checked={md.enabled} onChange={(v) => mf.set('enabled', v)} />
          </SwitchRow>
        </div>
        {md.enabled !== menuOn && (
          <Alert tone="blue">
            {md.enabled
              ? `After saving: add your ingredients and dishes in Sales > Menu & recipes (or put the items you already sell on the menu).${d.enabled ? '' : ' Turn on stock tracking too if selling dishes should take ingredients out of stock.'}`
              : 'The menu screens will be hidden. Your dishes stay on sale as normal items and their recipes are kept; selling them no longer takes ingredients out of stock.'}
          </Alert>
        )}
        {menuOn && (
          <p className="small muted mb-0">
            Manage dishes in <Link to="/menu">Menu &amp; recipes</Link> and raw materials in <Link to="/menu/ingredients">Ingredients</Link>.
          </p>
        )}
      </Card>
      {(f.error || mf.error) && <Alert tone="red">{f.error ?? mf.error}</Alert>}
      <SaveBar
        dirty={dirty}
        saving={f.saving || mf.saving}
        onUndo={() => {
          f.reset();
          mf.reset();
        }}
      />
    </form>
  );
}
