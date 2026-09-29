/**
 * Migration 3: GST. Adds tax columns to items, parties and documents. Every
 * column has a default that means "no GST", so bills, returns and purchases
 * made before the update (or while the business is unregistered) read exactly
 * as before.
 */
export const GST_COLUMNS: Array<[table: string, column: string, definition: string]> = [
  // Items: HSN / SAC code and GST rate (NULL = the business's default rate).
  ['items', 'hsn', 'TEXT'],
  ['items', 'gst_rate', 'REAL'],
  // Parties: GSTIN and state (place of supply; NULL = same state as the business).
  ['customers', 'gstin', 'TEXT'],
  ['customers', 'state_code', 'TEXT'],
  ['suppliers', 'gstin', 'TEXT'],
  ['suppliers', 'state_code', 'TEXT'],
  // Bills: the GST treatment when the bill was made, and its tax totals.
  ['bills', 'gst_mode', "TEXT NOT NULL DEFAULT 'none' CHECK (gst_mode IN ('none', 'regular', 'composition'))"],
  ['bills', 'gst_inclusive', 'INTEGER NOT NULL DEFAULT 0'],
  ['bills', 'seller_gstin', 'TEXT'],
  ['bills', 'customer_gstin', 'TEXT'],
  ['bills', 'place_of_supply', 'TEXT'],
  ['bills', 'taxable_total', 'INTEGER'],
  ['bills', 'cgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['bills', 'sgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['bills', 'igst', 'INTEGER NOT NULL DEFAULT 0'],
  // Bill lines: amount = qty x rate - discount (as before); taxable + tax = value after the bill discount.
  ['bill_items', 'hsn', 'TEXT'],
  ['bill_items', 'gst_rate', 'REAL'],
  ['bill_items', 'taxable', 'INTEGER'],
  ['bill_items', 'cgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['bill_items', 'sgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['bill_items', 'igst', 'INTEGER NOT NULL DEFAULT 0'],
  // Returns: tax taken back.
  ['credit_notes', 'taxable_total', 'INTEGER'],
  ['credit_notes', 'cgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['credit_notes', 'sgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['credit_notes', 'igst', 'INTEGER NOT NULL DEFAULT 0'],
  ['credit_note_items', 'gst_rate', 'REAL'],
  ['credit_note_items', 'taxable', 'INTEGER'],
  ['credit_note_items', 'cgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['credit_note_items', 'sgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['credit_note_items', 'igst', 'INTEGER NOT NULL DEFAULT 0'],
  // Purchases: tax on the supplier's bill and whether input tax credit is claimed.
  ['purchases', 'gst_mode', "TEXT NOT NULL DEFAULT 'none' CHECK (gst_mode IN ('none', 'regular', 'composition'))"],
  ['purchases', 'gst_inclusive', 'INTEGER NOT NULL DEFAULT 0'],
  ['purchases', 'itc', 'INTEGER NOT NULL DEFAULT 0'],
  ['purchases', 'supplier_gstin', 'TEXT'],
  ['purchases', 'place_of_supply', 'TEXT'],
  ['purchases', 'taxable_total', 'INTEGER'],
  ['purchases', 'cgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['purchases', 'sgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['purchases', 'igst', 'INTEGER NOT NULL DEFAULT 0'],
  ['purchase_items', 'hsn', 'TEXT'],
  ['purchase_items', 'gst_rate', 'REAL'],
  ['purchase_items', 'taxable', 'INTEGER'],
  ['purchase_items', 'cgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['purchase_items', 'sgst', 'INTEGER NOT NULL DEFAULT 0'],
  ['purchase_items', 'igst', 'INTEGER NOT NULL DEFAULT 0'],
];

export const GST_INDEXES = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_bills_gst ON bills (gst_mode, date);
CREATE INDEX IF NOT EXISTS idx_purchases_gst ON purchases (gst_mode, date);
`;
