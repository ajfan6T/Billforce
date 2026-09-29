import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Alert, Button, Card } from '../../components/ui';
import { Switch } from '../../components/forms';
import { useHotkeys } from '../../hooks';
import { useAuth } from '../../auth';
import { useToast } from '../../feedback';
import { call } from '../../api';
import type { AppSettings, StockSettings } from '../../../shared/settings';
import { useSectionForm } from './useSectionForm';
import { SaveBar, SwitchRow } from './common';

export function StockTab({ settings, onSaved, onDirty }: { settings: AppSettings; onSaved: (v: StockSettings) => void; onDirty: (d: boolean) => void }) {
  const { refresh, can } = useAuth();
  const toast = useToast();
  const f = useSectionForm('stock', settings.stock, onSaved);
  const [tracking, setTracking] = useState(false);
  useEffect(() => onDirty(f.dirty), [f.dirty, onDirty]);
  const save = async () => {
    // The menu shows the stock pages only while stock tracking is on.
    if (await f.save('Stock settings saved')) await refresh();
  };
  useHotkeys({ 'ctrl+s': () => void save() }, [f.save]);
  const d = f.draft;
  if (!d) return null;
  const on = settings.stock.enabled;
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
              : 'Stock screens will be hidden. Stock already recorded is kept and comes back if you turn tracking on again. While it is off, purchases are treated as expenses and stock is not valued in the reports.'}
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
      {f.error && <Alert tone="red">{f.error}</Alert>}
      <SaveBar dirty={f.dirty} saving={f.saving} onUndo={f.reset} />
    </form>
  );
}
