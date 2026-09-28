import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Briefcase, Check, CheckCircle2, FileSpreadsheet, FileText, FileUp, Package, Truck, Upload, Users, type LucideIcon } from 'lucide-react';
import { Alert, Badge, Button, Card, ErrorBox, Loading, Page, PageHeader, Stat, StatGrid, type Tone } from '../../components/ui';
import { Field, SegmentedControl, Select } from '../../components/forms';
import { useQuery } from '../../hooks';
import { useDialogs, useToast } from '../../feedback';
import { call, type ApiOutput } from '../../api';
import { formatIndianNumber } from '../../../shared/money';
import './admin.css';

type ImportType = 'items' | 'customers' | 'suppliers' | 'employees';
type Preview = ApiOutput<'import.preview'>;
type PreviewRow = Preview['rows'][number];
type Result = ApiOutput<'import.commit'>;

const ICONS: Record<ImportType, LucideIcon> = { items: Package, customers: Users, suppliers: Truck, employees: Briefcase };
const LIST_PAGE: Record<ImportType, string> = { items: '/sales/items', customers: '/customers', suppliers: '/suppliers', employees: '/employees' };
const STEPS = ['What to import', 'Choose file', 'Check the data', 'Done'];
const ACTION: Record<PreviewRow['action'], { label: string; tone: Tone }> = {
  create: { label: 'New', tone: 'green' },
  update: { label: 'Update', tone: 'blue' },
  skip: { label: 'Skip', tone: 'neutral' },
};
const PAGE = 100;
/** Long text columns that may wrap in the preview table. */
const WRAP_FIELDS = new Set(['address', 'name', 'contactPerson', 'designation', 'category']);

const n = (v: number) => formatIndianNumber(v, 0);

function Steps({ step }: { step: number }) {
  return (
    <ol className="steps import-steps">
      {STEPS.map((s, i) => (
        <li key={s} className={i === step ? 'active' : i < step ? 'done' : ''}>
          <span className="step-dot">{i < step ? <Check size={14} /> : i + 1}</span>
          {s}
        </li>
      ))}
    </ol>
  );
}

function PreviewStep({
  type,
  label,
  singular,
  file,
  onBack,
  onDone,
}: {
  type: ImportType;
  label: string;
  singular: string;
  file: { path: string; fileName: string };
  onBack: () => void;
  onDone: (r: Result) => void;
}) {
  const [mapping, setMapping] = useState<Record<string, number | null> | null>(null);
  const [mode, setMode] = useState<'skip' | 'update'>('skip');
  const [filter, setFilter] = useState<'all' | 'errors' | 'create' | 'update' | 'skip'>('all');
  const [page, setPage] = useState(0);
  const [importing, setImporting] = useState(false);
  const dialogs = useDialogs();
  const toast = useToast();
  const q = useQuery('import.preview', { type, path: file.path, mapping, duplicateMode: mode });
  // Keep the last good preview on screen while a new one loads.
  const [shown, setShown] = useState<Preview | null>(null);
  useEffect(() => {
    if (q.data) setShown(q.data);
  }, [q.data]);
  useEffect(() => setPage(0), [filter, mapping, mode]);

  const p = shown;
  const rows = useMemo(() => {
    if (!p) return [];
    switch (filter) {
      case 'errors':
        return p.rows.filter((r) => r.errors.length);
      case 'create':
      case 'update':
        return p.rows.filter((r) => !r.errors.length && r.action === filter);
      case 'skip':
        return p.rows.filter((r) => !r.errors.length && r.action === 'skip');
      default:
        return p.rows;
    }
  }, [p, filter]);

  if (q.error && !p) {
    return (
      <div className="stack">
        <ErrorBox error={q.error} />
        <div className="row">
          <Button onClick={onBack}>Choose another file</Button>
        </div>
      </div>
    );
  }
  if (!p) return <Loading label="Reading the file…" />;

  const mappedFields = p.fields.filter((f) => p.mapping[f.key] !== null && p.mapping[f.key] !== undefined);
  const todo = p.counts.create + p.counts.update;
  const pageRows = rows.slice(page * PAGE, (page + 1) * PAGE);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));

  const runImport = async () => {
    const parts = [`${n(p.counts.create)} new`];
    if (p.counts.update) parts.push(`${n(p.counts.update)} updated`);
    const left = p.counts.errors + p.counts.skip;
    const ok = await dialogs.confirm({
      title: `Import ${n(todo)} ${label.toLowerCase()}?`,
      message: (
        <>
          {parts.join(', ')}.{left ? ` ${n(left)} row${left === 1 ? '' : 's'} will be left out (${[p.counts.errors ? `${n(p.counts.errors)} with errors` : '', p.counts.skip ? `${n(p.counts.skip)} already there` : ''].filter(Boolean).join(', ')}).` : ''}{' '}
          Everything is saved together, so if anything goes wrong nothing is imported.
        </>
      ),
      confirmText: 'Import',
    });
    if (!ok) return;
    setImporting(true);
    try {
      const res = await call('import.commit', { type, path: file.path, mapping: p.mapping, duplicateMode: mode });
      onDone(res);
    } catch (e) {
      toast.error(e);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="stack">
      <div className="import-file">
        <FileSpreadsheet size={22} />
        <div className="grow">
          <div className="import-file-name">{p.fileName}</div>
          <div className="muted small">
            {p.sheetName ? `Sheet "${p.sheetName}", ` : ''}column names in row {p.headerRowNo} · {n(p.counts.total)} row{p.counts.total === 1 ? '' : 's'} of data
          </div>
        </div>
        <Button size="sm" onClick={onBack}>
          Choose another file
        </Button>
      </div>

      {q.error && <Alert tone="red">{q.error}</Alert>}

      <StatGrid>
        <Stat label="New" value={n(p.counts.create)} tone={p.counts.create ? 'green' : undefined} hint="Will be added" onClick={() => setFilter('create')} />
        <Stat label="Update" value={n(p.counts.update)} tone={p.counts.update ? 'blue' : undefined} hint={mode === 'update' ? 'Existing records to update' : 'Existing records are skipped'} onClick={() => setFilter('update')} />
        <Stat label="Skip" value={n(p.counts.skip)} hint="Already there" onClick={() => setFilter('skip')} />
        <Stat label="Errors" value={n(p.counts.errors)} tone={p.counts.errors ? 'red' : undefined} hint={p.counts.errors ? 'Fix in the file and choose it again' : 'None'} onClick={() => setFilter('errors')} />
      </StatGrid>

      <Card title="Match the columns" actions={<span className="muted small">Billforce matched these by the column names in your file</span>}>
        <div className="stack">
          <div className="mapping-grid">
            {p.fields.map((f) => (
              <Field
                key={f.key}
                label={
                  <>
                    <span>
                      {f.label}
                      {f.required && <span className="req">*</span>}
                    </span>
                  </>
                }
                hint={f.hint ?? undefined}
                error={f.required && (p.mapping[f.key] === null || p.mapping[f.key] === undefined) ? 'Choose the column' : null}
              >
                <Select<number>
                  value={p.mapping[f.key] ?? -1}
                  onChange={(v) => setMapping({ ...p.mapping, [f.key]: v < 0 ? null : v })}
                  aria-label={`Column for ${f.label}`}
                  options={[
                    { value: -1, label: '— Not in file —' },
                    ...p.columns.map((c) => ({ value: c.index, label: `${c.header}${c.samples.length ? `  (e.g. ${c.samples[0].slice(0, 24)})` : ''}` })),
                  ]}
                />
              </Field>
            ))}
          </div>
          <div className="row-wrap">
            <span className="field-label">When {/^[aeiou]/.test(singular) ? 'an' : 'a'} {singular} already exists</span>
            <SegmentedControl<'skip' | 'update'>
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'skip', label: 'Skip it' },
                { value: 'update', label: 'Update it with the file' },
              ]}
            />
            <span className="field-hint">Blank cells never erase existing details.</span>
          </div>
        </div>
      </Card>

      <Card
        padded={false}
        title="Rows"
        actions={
          <SegmentedControl
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All (${n(p.counts.total)})` },
              { value: 'errors', label: `Errors (${n(p.counts.errors)})` },
              { value: 'create', label: `New (${n(p.counts.create)})` },
              { value: 'update', label: `Update (${n(p.counts.update)})` },
              { value: 'skip', label: `Skip (${n(p.counts.skip)})` },
            ]}
          />
        }
      >
        <div style={{ height: 12 }} />
        <div className={`table-wrap sticky${q.loading ? ' report is-loading' : ''}`} style={{ maxHeight: 520, overflow: 'auto' }}>
          <table className="table compact import-table">
            <thead>
              <tr>
                <th style={{ width: 56 }}>Row</th>
                {mappedFields.map((f) => (
                  <th key={f.key}>{f.label}</th>
                ))}
                <th style={{ minWidth: 220 }}>What will happen</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr>
                  <td colSpan={mappedFields.length + 2} className="table-empty">
                    No rows here
                  </td>
                </tr>
              ) : (
                pageRows.map((r) => (
                  <tr key={r.rowNo} className={r.errors.length ? 'row-error' : r.action === 'skip' ? 'row-skip' : ''}>
                    <td className="muted">{r.rowNo}</td>
                    {mappedFields.map((f) => (
                      <td key={f.key} className={`${r.fieldErrors[f.key] ? 'cell-error' : ''}${WRAP_FIELDS.has(f.key) ? '' : ' nowrap'}`} title={r.fieldErrors[f.key] ?? undefined}>
                        {r.values[f.key] ?? ''}
                      </td>
                    ))}
                    <td>
                      <Badge tone={r.errors.length ? 'red' : ACTION[r.action].tone}>{r.errors.length ? 'Error' : ACTION[r.action].label}</Badge>
                      <div className="row-messages">
                        {r.errors.map((e, i) => (
                          <div key={`e${i}`} className="err">
                            {e}
                          </div>
                        ))}
                        {!r.errors.length && r.note && <div className="info">{r.note}</div>}
                        {r.warnings.map((w, i) => (
                          <div key={`w${i}`} className="warn">
                            {w}
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {pages > 1 && (
          <div className="admin-card-footer">
            <span>
              Rows {n(page * PAGE + 1)}–{n(Math.min(rows.length, (page + 1) * PAGE))} of {n(rows.length)}
            </span>
            <div className="row">
              <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <Button size="sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      {p.missingRequired.length > 0 && <Alert tone="red">Choose which column has the {p.missingRequired.join(', ').toLowerCase()} before importing.</Alert>}
      <div className="row-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <div className="row">
          {p.counts.errors > 0 && todo > 0 && <span className="muted small">Rows with errors will be left out.</span>}
          <Button variant="primary" size="lg" icon={<Upload size={17} />} loading={importing} disabled={!todo || q.loading || p.missingRequired.length > 0} onClick={runImport}>
            {todo ? `Import ${n(todo)} ${todo === 1 ? 'row' : 'rows'}` : 'Nothing to import'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ImportPage() {
  const navigate = useNavigate();
  const types = useQuery('import.types', undefined);
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [type, setType] = useState<ImportType | null>(null);
  const [file, setFile] = useState<{ path: string; fileName: string } | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!type && types.data) {
      const first = types.data.find((t) => t.allowed);
      if (first) setType(first.type as ImportType);
    }
  }, [types.data, type]);

  const def = types.data?.find((t) => t.type === type);

  const template = async (format: 'xlsx' | 'csv') => {
    if (!type) return;
    setBusy(format);
    try {
      const r = await call('import.template', { type, format });
      if (r.path) toast.success(`Template saved to ${r.path}`, { label: 'Open', onClick: () => void call('files.open', { path: r.path! }) });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const pick = async () => {
    setBusy('pick');
    try {
      const r = await call('import.pickFile');
      if (r.path && r.fileName) {
        setFile({ path: r.path, fileName: r.fileName });
        setStep(2);
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const restart = () => {
    setStep(0);
    setFile(null);
    setResult(null);
  };

  return (
    <Page wide={step === 2}>
      <PageHeader title="Import from Excel / CSV" subtitle="Bring in your items, customers, suppliers or employees from a spreadsheet" />
      <Steps step={step} />
      {types.error ? (
        <ErrorBox error={types.error} onRetry={types.reload} />
      ) : !types.data ? (
        <Loading />
      ) : step === 0 ? (
        <div className="stack">
          <div className="import-types">
            {types.data.map((t) => {
              const Icon = ICONS[t.type as ImportType];
              return (
                <button
                  key={t.type}
                  type="button"
                  className={`import-type${type === t.type ? ' active' : ''}`}
                  disabled={!t.allowed}
                  title={t.allowed ? undefined : `You do not have permission to add ${t.label.toLowerCase()}`}
                  onClick={() => setType(t.type as ImportType)}
                  onDoubleClick={() => t.allowed && setStep(1)}
                >
                  <span className="import-type-icon">
                    <Icon size={19} />
                  </span>
                  <span className="import-type-title">{t.label}</span>
                  <span className="import-type-fields">{t.fields.map((f) => f.label).join(', ')}</span>
                </button>
              );
            })}
          </div>
          {def && (
            <Card title={`Importing ${def.label.toLowerCase()}`}>
              <div className="stack">
                <ul className="import-notes">
                  {def.notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
                <div className="row-wrap">
                  <span className="muted">Start from a template with the right columns:</span>
                  <Button size="sm" icon={<FileSpreadsheet size={15} />} loading={busy === 'xlsx'} onClick={() => void template('xlsx')}>
                    Excel template
                  </Button>
                  <Button size="sm" icon={<FileText size={15} />} loading={busy === 'csv'} onClick={() => void template('csv')}>
                    CSV template
                  </Button>
                </div>
                <p className="muted small mt-0 mb-0">Your own file works too: Billforce matches columns such as "Customer Name", "Mobile No" or "Opening Balance" automatically.</p>
              </div>
            </Card>
          )}
          <div className="row-between">
            <span />
            <Button variant="primary" size="lg" disabled={!def?.allowed} onClick={() => setStep(1)}>
              Next: choose file
            </Button>
          </div>
        </div>
      ) : step === 1 ? (
        <div className="stack settings-form">
          <Card>
            <div className="import-done">
              <div className="import-type-icon" style={{ width: 52, height: 52 }}>
                <FileUp size={26} />
              </div>
              <div className="backup-hero-title">Choose the file with your {def?.label.toLowerCase()}</div>
              <p className="muted mt-0">Excel (.xlsx) or CSV (.csv). The first sheet is used; the first row should have the column names.</p>
              <Button variant="primary" size="lg" icon={<FileUp size={17} />} loading={busy === 'pick'} onClick={pick}>
                Choose file…
              </Button>
              {file && <div className="muted small">Last chosen: {file.fileName}</div>}
            </div>
          </Card>
          <div className="row-between">
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            {file && (
              <Button variant="primary" onClick={() => setStep(2)}>
                Next: check {file.fileName}
              </Button>
            )}
          </div>
        </div>
      ) : step === 2 && type && file ? (
        <PreviewStep
          type={type}
          label={def?.label ?? ''}
          singular={def?.singular ?? 'record'}
          file={file}
          onBack={() => setStep(1)}
          onDone={(r) => {
            setResult(r);
            setStep(3);
          }}
        />
      ) : result ? (
        <Card>
          <div className="import-done">
            <CheckCircle2 size={44} color="var(--success)" />
            <div className="backup-hero-title">Import finished</div>
            <p className="muted mt-0">
              From <b>{result.fileName}</b>: {n(result.created)} added{result.updated ? `, ${n(result.updated)} updated` : ''}
              {result.skipped ? `, ${n(result.skipped)} skipped` : ''}
              {result.errors ? `, ${n(result.errors)} left out because of errors` : ''}.
            </p>
            <div className="row">
              <Button onClick={restart}>Import another file</Button>
              <Button variant="primary" onClick={() => navigate(LIST_PAGE[result.type as ImportType])}>
                View {def?.label.toLowerCase()}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </Page>
  );
}
