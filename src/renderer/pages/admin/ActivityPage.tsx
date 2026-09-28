import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ChevronLeft, ChevronRight, ExternalLink, FileDown, FileSpreadsheet, FileText, History, Printer } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBox, IconButton, KeyValues, Page, PageHeader } from '../../components/ui';
import { SearchInput, Select } from '../../components/forms';
import { DataTable, type Column } from '../../components/table';
import { DateRangePicker, rangeFromPreset, type RangeValue } from '../../components/report';
import { Modal } from '../../components/modal';
import { useDebounced, useQuery, useStoredState } from '../../hooks';
import { useToast } from '../../feedback';
import { useAuth } from '../../auth';
import { call, exportReport, type ApiInput, type ApiOutput } from '../../api';
import { linkPath } from '../../links';
import { ACTIVITY_MODULES } from '../../../shared/activity';
import { formatDateTime } from '../../../shared/dates';
import { formatIndianNumber } from '../../../shared/money';
import type { ExportFormat } from '../../../shared/report';
import './admin.css';

type Row = ApiOutput<'activity.list'>['rows'][number];

const PAGE_SIZE = 100;

/** Export / print buttons that fetch the full filtered report only when clicked. */
function LazyExport({ filters, disabled }: { filters: ApiInput<'activity.report'>['filters']; disabled?: boolean }) {
  const toast = useToast();
  const { can } = useAuth();
  const [busy, setBusy] = useState<ExportFormat | 'print' | null>(null);
  const run = async (what: ExportFormat | 'print') => {
    setBusy(what);
    try {
      const report = await call('activity.report', { filters });
      if (what === 'print') await call('files.printReport', { report });
      else {
        const path = await exportReport(report, what);
        if (path) toast.success(`Saved ${what.toUpperCase()} to ${path}`, { label: 'Open', onClick: () => void call('files.open', { path }) });
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="export-bar">
      {can('reports.export') && (
        <>
          <Button size="sm" icon={<FileSpreadsheet size={15} />} loading={busy === 'xlsx'} disabled={disabled} onClick={() => run('xlsx')}>
            Excel
          </Button>
          <Button size="sm" icon={<FileText size={15} />} loading={busy === 'csv'} disabled={disabled} onClick={() => run('csv')}>
            CSV
          </Button>
          <Button size="sm" icon={<FileDown size={15} />} loading={busy === 'pdf'} disabled={disabled} onClick={() => run('pdf')}>
            PDF
          </Button>
        </>
      )}
      <Button size="sm" icon={<Printer size={15} />} loading={busy === 'print'} disabled={disabled} onClick={() => run('print')}>
        Print
      </Button>
    </div>
  );
}

type Detail = ApiOutput<'activity.get'>;

/**
 * The details in plain words (worked out by the core: ₹ amounts, DD-MM-YYYY dates, readable labels, internal
 * fields left out), with the stored data behind "Technical details" for whoever needs it.
 */
function DetailsView({ d }: { d: Detail }) {
  const { changes, facts } = d.view;
  return (
    <>
      {changes.length > 0 && (
        <div>
          <div className="section-title mt-0">What changed</div>
          <div className="table-wrap">
            <table className="table compact change-table">
              <thead>
                <tr>
                  <th>What</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c, i) => (
                  <tr key={i}>
                    <td>{c.label}</td>
                    <td className="change-old detail-value">{c.before}</td>
                    <td className="change-new detail-value">{c.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {facts.length > 0 && (
        <div>
          <div className="section-title mt-0">Details</div>
          <KeyValues items={facts.map((f) => [f.label, <span className="detail-value" key={f.label}>{f.value}</span>])} />
        </div>
      )}
      <details className="tech-details">
        <summary>Technical details</summary>
        <div className="stack-sm mt-1">
          <div className="muted small">
            Code: <span className="perm-key">{d.action}</span>
            {d.entityType && d.entityId ? ` · ${d.entityType} #${d.entityId}` : ''}
          </div>
          {d.details !== null && d.details !== undefined && (
            <pre className="detail-json">{typeof d.details === 'string' ? d.details : JSON.stringify(d.details, null, 2)}</pre>
          )}
          <div className="muted small">Amounts here are in paise (₹1 = 100 paise) and dates are year-month-day.</div>
        </div>
      </details>
    </>
  );
}

function ActivityDetailModal({ id, onClose }: { id: number | null; onClose: () => void }) {
  const q = useQuery('activity.get', id ? { id } : null);
  const navigate = useNavigate();
  const d = q.data;
  return (
    <Modal
      open={!!id}
      title={d ? d.actionLabel : 'Activity'}
      onClose={onClose}
      width={620}
      footer={
        <>
          {d?.link && (
            <Button icon={<ExternalLink size={15} />} onClick={() => navigate(linkPath(d.link!))}>
              Open record
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {q.error ? (
        <ErrorBox error={q.error} />
      ) : !d ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="stack">
          <KeyValues
            items={[
              ['When', formatDateTime(d.at)],
              ['Who', d.username && d.userName !== d.username ? `${d.userName} (${d.username})` : d.userName],
              ['Action', d.actionLabel],
            ]}
          />
          <div>
            <div className="section-title mt-0">What happened</div>
            <p className="mt-0">{d.summary}</p>
          </div>
          <DetailsView d={d} />
        </div>
      )}
    </Modal>
  );
}

export function ActivityPage() {
  const navigate = useNavigate();
  const [range, setRange] = useStoredState<RangeValue>('admin.activity.range', rangeFromPreset('last_7_days'));
  const [userId, setUserId] = useState<number | 0>(0);
  const [moduleKey, setModuleKey] = useState('');
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const users = useQuery('activity.users', undefined);

  // Presets like "last 7 days" move with the calendar.
  const effectiveRange = useMemo(() => (range.preset === 'custom' ? range : rangeFromPreset(range.preset)), [range]);
  const filters = useMemo(
    () => ({
      from: effectiveRange.from,
      to: effectiveRange.to,
      userId: userId || null,
      action: moduleKey ? ACTIVITY_MODULES.find((m) => m.key === moduleKey)?.prefixes ?? null : null,
      q: dq.trim() || null,
    }),
    [effectiveRange, userId, moduleKey, dq],
  );
  useEffect(() => setPage(0), [filters]);
  const list = useQuery('activity.list', { ...filters, limit: PAGE_SIZE, offset: page * PAGE_SIZE });

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = !!(userId || moduleKey || dq);

  const columns: Array<Column<Row>> = [
    { key: 'at', label: 'When', width: 150, render: (r) => <span className="activity-when">{formatDateTime(r.at)}</span> },
    { key: 'userName', label: 'User', width: 130 },
    { key: 'actionLabel', label: 'Action', width: 170, render: (r) => <span className="activity-action">{r.actionLabel}</span> },
    { key: 'summary', label: 'Details', sortable: false, render: (r) => <div className="activity-summary">{r.summary}</div> },
    {
      key: 'link',
      label: '',
      sortable: false,
      width: 48,
      align: 'right',
      render: (r) =>
        r.link ? (
          <span onClick={(e) => e.stopPropagation()}>
            <IconButton label="Open record" icon={<ExternalLink size={15} />} onClick={() => navigate(linkPath(r.link!))} />
          </span>
        ) : null,
    },
  ];

  let body: ReactNode;
  if (list.error) body = <div className="card-body"><ErrorBox error={list.error} onRetry={list.reload} /></div>;
  else if (!list.loading && total === 0)
    body = (
      <EmptyState
        icon={<History size={34} />}
        title={filtered ? 'Nothing matches these filters' : 'No activity in this period'}
        message={filtered ? 'Try another user, action or search, or choose a longer period.' : 'Choose a longer period to see older activity.'}
      />
    );
  else
    body = (
      <DataTable
        columns={columns}
        rows={list.data?.rows}
        loading={list.loading}
        rowKey={(r) => r.id}
        onRowClick={(r) => setOpenId(r.id)}
        maxHeight="calc(100vh - 330px)"
      />
    );

  return (
    <Page wide>
      <PageHeader title="Activity log" subtitle="Who did what and when. Every change in Billforce is recorded here and cannot be edited." />
      <Card padded={false}>
        <div className="admin-card-toolbar activity-filters">
            <DateRangePicker value={effectiveRange} onChange={setRange} />
            <Select<number>
              value={userId}
              onChange={(v) => setUserId(v)}
              aria-label="User"
              options={[{ value: 0, label: 'All users' }, ...(users.data ?? []).map((u) => ({ value: u.id, label: u.isActive ? u.name : `${u.name} (inactive)` }))]}
            />
            <Select<string>
              value={moduleKey}
              onChange={setModuleKey}
              aria-label="What"
              options={[{ value: '', label: 'Everything' }, ...ACTIVITY_MODULES.map((m) => ({ value: m.key, label: m.label }))]}
            />
            <SearchInput value={q} onChange={setQ} placeholder="Search details, bill no, name…" />
            <span className="grow" />
            <LazyExport filters={filters} disabled={!total} />
        </div>
        {body}
        {total > 0 && (
          <div className="admin-card-footer">
            <span>
              {total > PAGE_SIZE
                ? `Showing ${formatIndianNumber(page * PAGE_SIZE + 1, 0)}–${formatIndianNumber(Math.min(total, (page + 1) * PAGE_SIZE), 0)} of ${formatIndianNumber(total, 0)} entries`
                : `${formatIndianNumber(total, 0)} ${total === 1 ? 'entry' : 'entries'}`}
            </span>
            {pages > 1 && (
              <div className="row">
                <Button size="sm" icon={<ChevronLeft size={15} />} disabled={page === 0} onClick={() => setPage(page - 1)}>
                  Newer
                </Button>
                <span>
                  Page {page + 1} of {pages}
                </span>
                <Button size="sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
                  Older <ChevronRight size={15} />
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
      <ActivityDetailModal id={openId} onClose={() => setOpenId(null)} />
    </Page>
  );
}
