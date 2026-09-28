import QRCode from 'qrcode';
import type { BusinessSettings, ReceiptSettings } from '../../shared/settings';
import { escapeHtml } from '../export/format';

/**
 * Generic layout for 80 mm / 58 mm thermal receipts. Bills, credit notes,
 * payment receipts and salary slips all describe themselves as a ReceiptDoc
 * so every printout looks consistent.
 */
export interface ReceiptItem {
  name: string;
  qty?: string;
  rate?: string;
  amount: string;
  /** Small second line, e.g. "Disc 10%  -5.00". */
  note?: string;
}

export interface ReceiptTotal {
  label: string;
  value: string;
  bold?: boolean;
  /** Large type, for the grand total. */
  big?: boolean;
}

export interface ReceiptDoc {
  /** Heading such as "BILL", "SALES RETURN", "PAYMENT RECEIPT". */
  title: string;
  duplicate?: boolean;
  cancelled?: boolean;
  meta: Array<[string, string]>;
  party?: { label: string; name: string; phone?: string | null; extra?: string | null };
  items?: ReceiptItem[];
  totals: ReceiptTotal[];
  /** Free text lines after the totals (amount in words, remarks, balance). */
  lines?: string[];
  qr?: { data: string; caption: string };
  signature?: string;
}

/** SVG for a QR code (drawn synchronously, no external services). */
export function qrSvg(data: string, sizeMm: number): string {
  const qr = QRCode.create(data, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 2;
  let path = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.modules.get(y, x)) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  const dim = n + quiet * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${sizeMm}mm" height="${sizeMm}mm" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

/** UPI deep link understood by every UPI app (GPay, PhonePe, Paytm, BHIM ...). */
export function upiLink(upiId: string, payee: string, amountPaise: number, note: string): string {
  const params = new URLSearchParams({ pa: upiId, pn: payee, am: (amountPaise / 100).toFixed(2), cu: 'INR', tn: note });
  return `upi://pay?${params.toString().replace(/\+/g, '%20')}`;
}

const FONT_PX: Record<ReceiptSettings['fontSize'], number> = { small: 11, normal: 12.5, large: 14 };

export function renderReceiptHtml(doc: ReceiptDoc, business: BusinessSettings, receipt: ReceiptSettings): string {
  const width = receipt.paperWidth === 58 ? 48 : 72; // printable width in mm
  const narrow = receipt.paperWidth === 58;
  const fs = FONT_PX[receipt.fontSize] ?? 12.5;
  const e = escapeHtml;
  const multiline = (s: string) => e(s).replace(/\n/g, '<br>');

  const header = [
    business.name ? `<div class="biz">${e(business.name)}</div>` : '',
    business.address ? `<div class="c">${multiline(business.address)}</div>` : '',
    business.phone ? `<div class="c">Ph: ${e(business.phone)}</div>` : '',
    receipt.header ? `<div class="c hdr">${multiline(receipt.header)}</div>` : '',
  ].join('');

  const meta = doc.meta.map(([k, v]) => `<div class="row"><span>${e(k)}</span><span>${e(v)}</span></div>`).join('');

  const party = doc.party
    ? `<div class="party"><div><b>${e(doc.party.label)}:</b> ${e(doc.party.name)}</div>${
        doc.party.phone ? `<div>Ph: ${e(doc.party.phone)}</div>` : ''
      }${doc.party.extra ? `<div>${e(doc.party.extra)}</div>` : ''}</div>`
    : '';

  let items = '';
  if (doc.items?.length) {
    if (narrow) {
      items = doc.items
        .map(
          (it) =>
            `<div class="it"><div class="nm">${e(it.name)}</div><div class="row"><span>${e(it.qty ?? '')}${
              it.rate ? ` x ${e(it.rate)}` : ''
            }</span><span>${e(it.amount)}</span></div>${it.note ? `<div class="note">${e(it.note)}</div>` : ''}</div>`,
        )
        .join('');
    } else {
      items = `<table><thead><tr><th class="l">Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>${doc.items
        .map(
          (it) =>
            `<tr><td class="l">${e(it.name)}${it.note ? `<div class="note">${e(it.note)}</div>` : ''}</td><td>${e(it.qty ?? '')}</td><td>${e(
              it.rate ?? '',
            )}</td><td>${e(it.amount)}</td></tr>`,
        )
        .join('')}</tbody></table>`;
    }
    items = `<div class="sep"></div>${items}`;
  }

  const totals = doc.totals
    .map((t) => `<div class="row${t.bold ? ' b' : ''}${t.big ? ' big' : ''}"><span>${e(t.label)}</span><span>${e(t.value)}</span></div>`)
    .join('');
  const lines = doc.lines?.length ? `<div class="lines">${doc.lines.map((l) => `<div>${multiline(l)}</div>`).join('')}</div>` : '';
  const qr = doc.qr
    ? `<div class="qr">${qrSvg(doc.qr.data, narrow ? 30 : 34)}<div>${e(doc.qr.caption)}</div></div>`
    : '';
  const footer = receipt.footer ? `<div class="sep"></div><div class="c foot">${multiline(receipt.footer)}</div>` : '';
  const flags = [doc.duplicate ? 'DUPLICATE' : '', doc.cancelled ? 'CANCELLED' : ''].filter(Boolean).join(' / ');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${e(doc.title)}</title><style>
@page { size: ${receipt.paperWidth}mm auto; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
body { width: ${width}mm; margin: 0 auto; padding: 2mm 0 4mm; font-family: "Segoe UI", Arial, "Nirmala UI", sans-serif; font-size: ${fs}px; color: #000; line-height: 1.3; }
.biz { font-size: ${fs + 5}px; font-weight: 700; text-align: center; }
.c { text-align: center; }
.hdr { margin-top: 2px; }
.title { text-align: center; font-weight: 700; margin: 4px 0 2px; letter-spacing: 1px; }
.flag { text-align: center; font-weight: 700; border: 1px solid #000; margin: 3px 0; padding: 1px; }
.sep { border-top: 1px dashed #000; margin: 4px 0; }
.row { display: flex; justify-content: space-between; gap: 6px; }
.row span:last-child { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.row.b { font-weight: 700; }
.row.big { font-size: ${fs + 4}px; font-weight: 700; border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 2px 0; margin: 2px 0; }
.sep + .row.big { border-top: 0; }
.party { margin-top: 2px; }
table { width: 100%; border-collapse: collapse; }
th { font-weight: 700; border-bottom: 1px dashed #000; text-align: right; padding: 1px 0 2px 3px; }
td { text-align: right; vertical-align: top; padding: 2px 0 1px 3px; font-variant-numeric: tabular-nums; white-space: nowrap; }
th.l, td.l { text-align: left; padding-left: 0; white-space: normal; word-break: break-word; }
.note { font-size: ${fs - 2}px; }
.it { margin-bottom: 2px; }
.nm { font-weight: 600; }
.lines { margin-top: 4px; font-size: ${fs - 1}px; }
.qr { text-align: center; margin-top: 6px; }
.qr svg { display: block; margin: 0 auto 2px; }
.foot { margin-top: 2px; }
.sign { margin-top: 18px; text-align: right; }
</style></head><body>
${header}
<div class="title">${e(doc.title)}</div>
${flags ? `<div class="flag">${flags}</div>` : ''}
<div class="sep"></div>
${meta}
${party}
${items}
<div class="sep"></div>
${totals}
${lines}
${qr}
${doc.signature ? `<div class="sign">${e(doc.signature)}</div>` : ''}
${footer}
</body></html>`;
}
