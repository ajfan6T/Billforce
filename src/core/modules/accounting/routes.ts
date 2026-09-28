import { z } from 'zod';
import { route, zDate, zId, zOptText, zPaise, zPaymentMode, zPositivePaise, zRange, zSettlementMode } from '../../api/router';
import { VOUCHER_TYPES } from '../../../shared/constants';
import * as accounts from './accounts';
import * as chart from './chart';
import * as journals from './journals';
import * as vouchers from './vouchers';
import * as expenses from './expenses';
import * as loans from './loans';
import * as books from './books';
import * as yearEnd from './yearend';

const zAccountId = z.number({ error: 'Choose an account' }).int().positive('Choose an account');
const zOptAccountId = z.number().int().positive().nullish();
const zAmount = zPositivePaise.refine((v) => v <= 1_000_000_000_00, 'Amount is too large');
const zOptDate = zDate.nullish();
const zReason = z.string({ error: 'Enter the reason' }).trim().min(1, 'Enter the reason').max(500);
const zOpening = z.object({ amount: zPaise, side: z.enum(['debit', 'credit']) });
const zVoucherType = z.enum(VOUCHER_TYPES);
const zPartyType = z.enum(['customer', 'supplier', 'employee']);

const zAccountName = z.string({ error: 'Enter the account name' }).trim().min(1, 'Enter the account name').max(80, 'Name is too long (max 80 characters)');
const zCode = z.string().trim().max(20, 'Code is too long (max 20 characters)').nullish();

const zJournalLine = z.object({
  accountId: zAccountId,
  debit: zPaise.optional(),
  credit: zPaise.optional(),
  partyType: zPartyType.nullish(),
  partyId: z.number().int().positive().nullish(),
  memo: zOptText(200),
});
const zJournal = z.object({
  date: zOptDate,
  narration: z.string().trim().max(500, 'Narration is too long (max 500 characters)').default(''),
  lines: z.array(zJournalLine).min(2, 'Add at least two lines').max(100, 'Too many lines (max 100)'),
});

const zExpense = z.object({
  date: zOptDate,
  accountId: z.number({ error: 'Choose the expense head' }).int().positive('Choose the expense head'),
  amount: z.number({ error: 'Enter the amount' }).pipe(zAmount),
  mode: zPaymentMode,
  payAccountId: zOptAccountId,
  supplierId: z.number().int().positive().nullish(),
  payee: zOptText(120),
  reference: zOptText(60),
  remarks: zOptText(500),
});

const zLoanTx = z.object({
  loanId: zId,
  date: zOptDate,
  kind: z.enum(['receive', 'repay', 'give', 'collect']),
  principal: zPaise.default(0),
  interest: zPaise.default(0),
  mode: zSettlementMode,
  accountId: zOptAccountId,
  narration: zOptText(500),
});

const zRate = z.number().min(0, 'Interest rate cannot be negative').max(100, 'Interest rate must be at most 100%').nullish();

const BOOKS = 'accounts.view' as const;
const VIEW = ['accounts.view', 'accounts.manage'] as const;
const CHART_VIEW = ['accounts.view', 'accounts.chart'] as const;
const EXPENSE_VIEW = ['expenses.manage', 'accounts.view'] as const;

export const accountingRoutes = {
  /** CONTRACT: accounts for pickers and the chart of accounts. */
  'accounts.list': route({
    access: 'user',
    input: z.object({
      groups: z.array(z.string()).optional(),
      types: z.array(z.enum(['asset', 'liability', 'equity', 'income', 'expense'])).optional(),
      includeInactive: z.boolean().optional(),
      withBalances: z.boolean().optional(),
      asOf: zDate.optional(),
    }),
    handler: (ctx, input) => {
      // Balances are financial information: only for users who may see the books.
      const withBalances = input.withBalances && (ctx.session?.role === 'owner' || ctx.session?.permissions.includes('accounts.view'));
      return accounts.listAccounts(ctx, { ...input, withBalances });
    },
  }),
  /** CONTRACT: cash / bank accounts for payment mode pickers. */
  'accounts.paymentAccounts': route({ access: 'user', handler: (ctx) => accounts.paymentAccounts(ctx) }),

  /* ------------------------------ Chart of accounts ------------------------------ */
  'accounts.groups': route({ access: [...CHART_VIEW, 'expenses.manage'], handler: (ctx) => chart.listGroups(ctx) }),
  'accounts.chart': route({
    access: [...CHART_VIEW],
    input: z.object({ includeInactive: z.boolean().optional(), asOf: zDate.optional() }),
    handler: (ctx, input) => chart.chartTree(ctx, input),
  }),
  'accounts.get': route({ access: [...CHART_VIEW], input: z.object({ id: zId }), handler: (ctx, input) => chart.getAccountDetail(ctx, input.id) }),
  'accounts.create': route({
    access: 'accounts.chart',
    mutation: true,
    input: z.object({ name: zAccountName, groupCode: z.string({ error: 'Choose a group' }).min(1, 'Choose a group'), code: zCode, description: zOptText(300), openingBalance: zOpening.nullish() }),
    handler: (ctx, input) => chart.createAccount(ctx, input),
  }),
  'accounts.update': route({
    access: 'accounts.chart',
    mutation: true,
    input: z.object({ id: zId, name: zAccountName, code: zCode, description: zOptText(300), groupCode: z.string().nullish(), openingBalance: zOpening.nullish() }),
    handler: (ctx, { id, ...input }) => chart.updateAccount(ctx, id, input),
  }),
  'accounts.setActive': route({
    access: 'accounts.chart',
    mutation: true,
    input: z.object({ id: zId, active: z.boolean() }),
    handler: (ctx, input) => chart.setAccountActive(ctx, input.id, input.active),
  }),
  'accounts.remove': route({ access: 'accounts.chart', mutation: true, input: z.object({ id: zId }), handler: (ctx, input) => chart.removeAccount(ctx, input.id) }),
  'accounts.setPaymentDefaults': route({
    access: 'accounts.chart',
    mutation: true,
    input: z.object({ cashAccountId: zAccountId, upiAccountId: zAccountId, bankAccountId: zAccountId }),
    handler: (ctx, input) => chart.setPaymentDefaults(ctx, input),
  }),

  /* ------------------------------ Capital, drawings, transfers ------------------------------ */
  'accounts.capital': route({
    access: 'accounts.manage',
    mutation: true,
    input: z.object({ date: zOptDate, amount: zAmount, mode: zSettlementMode, accountId: zOptAccountId, capitalAccountId: zOptAccountId, narration: zOptText(500) }),
    handler: (ctx, input) => vouchers.addCapital(ctx, input),
  }),
  'accounts.drawings': route({
    access: 'accounts.manage',
    mutation: true,
    input: z.object({ date: zOptDate, amount: zAmount, mode: zSettlementMode.nullish(), accountId: zOptAccountId, narration: zOptText(500), goods: z.boolean().optional() }),
    handler: (ctx, input) => vouchers.recordDrawings(ctx, input),
  }),
  'accounts.capitalSummary': route({ access: [...VIEW], input: zRange, handler: (ctx, input) => vouchers.capitalSummary(ctx, input) }),
  'accounts.transfer': route({
    access: 'accounts.manage',
    mutation: true,
    input: z.object({ date: zOptDate, fromAccountId: zAccountId, toAccountId: zAccountId, amount: zAmount, narration: zOptText(500) }),
    handler: (ctx, input) => vouchers.transfer(ctx, input),
  }),
  'accounts.transfers': route({ access: [...VIEW], input: zRange, handler: (ctx, input) => vouchers.listTransfers(ctx, input) }),

  /* ------------------------------ Journal vouchers & entries ------------------------------ */
  'journals.create': route({ access: 'accounts.manage', mutation: true, input: zJournal, handler: (ctx, input) => journals.createJournal(ctx, input) }),
  'journals.update': route({
    access: 'accounts.manage',
    mutation: true,
    input: zJournal.extend({ entryId: zId, reason: zOptText(500) }),
    handler: (ctx, { entryId, ...input }) => journals.updateJournal(ctx, entryId, input),
  }),
  'journals.cancel': route({
    access: 'accounts.manage',
    mutation: true,
    input: z.object({ entryId: zId, reason: zReason }),
    handler: (ctx, input) => journals.cancelEntry(ctx, input.entryId, input.reason),
  }),
  /** Any journal entry, including those posted by bills, purchases, salaries ... */
  'journals.get': route({ access: [...VIEW], input: z.object({ entryId: zId }), handler: (ctx, input) => journals.getEntryDetail(ctx, input.entryId) }),
  'journals.list': route({
    access: [...VIEW],
    input: zRange.extend({
      voucherType: zVoucherType.nullish(),
      q: z.string().max(100).nullish(),
      accountId: zOptAccountId,
      status: z.enum(['all', 'active', 'cancelled']).optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    }),
    handler: (ctx, input) => journals.listEntries(ctx, input),
  }),

  /* ------------------------------ Expenses ------------------------------ */
  'expenses.create': route({ access: 'expenses.manage', mutation: true, input: zExpense, handler: (ctx, input) => expenses.createExpense(ctx, input) }),
  'expenses.update': route({
    access: 'expenses.manage',
    mutation: true,
    input: zExpense.extend({ id: zId, reason: zOptText(500) }),
    handler: (ctx, { id, ...input }) => expenses.updateExpense(ctx, id, input),
  }),
  'expenses.cancel': route({
    access: 'expenses.manage',
    mutation: true,
    input: z.object({ id: zId, reason: zReason }),
    handler: (ctx, input) => expenses.cancelExpense(ctx, input.id, input.reason),
  }),
  'expenses.get': route({ access: [...EXPENSE_VIEW], input: z.object({ id: zId }), handler: (ctx, input) => expenses.getExpense(ctx, input.id) }),
  'expenses.list': route({
    access: [...EXPENSE_VIEW],
    input: zRange.extend({ accountId: zOptAccountId, q: z.string().max(100).nullish(), status: z.enum(['active', 'cancelled']).nullish(), mode: zPaymentMode.nullish() }),
    handler: (ctx, input) => expenses.listExpenses(ctx, input),
  }),
  'expenses.summary': route({ access: [...EXPENSE_VIEW], input: zRange, handler: (ctx, input) => expenses.expenseSummary(ctx, input) }),
  /** Add a new expense head straight from the expense form. */
  'expenses.addHead': route({
    access: ['expenses.manage', 'accounts.chart'],
    mutation: true,
    input: z.object({ name: zAccountName, groupCode: z.enum(['indirect_expenses', 'direct_expenses']).optional() }),
    handler: (ctx, input) => expenses.addExpenseHead(ctx, input),
  }),

  /* ------------------------------ Loans ------------------------------ */
  'loans.create': route({
    access: 'accounts.manage',
    mutation: true,
    input: z.object({
      name: z.string({ error: 'Enter who the loan is from / to' }).trim().min(1, 'Enter who the loan is from / to').max(60, 'Name is too long (max 60 characters)'),
      direction: z.enum(['taken', 'given']),
      principal: zPaise,
      interestRate: zRate,
      startDate: zDate,
      notes: zOptText(1000),
      openingOutstanding: zPaise.nullish(),
      disburse: z.object({ date: zOptDate, mode: zSettlementMode, accountId: zOptAccountId, amount: zPaise }).nullish(),
    }),
    handler: (ctx, input) => loans.createLoan(ctx, input),
  }),
  'loans.list': route({ access: [...VIEW], input: z.object({ includeClosed: z.boolean().optional() }), handler: (ctx, input) => loans.listLoans(ctx, input) }),
  'loans.get': route({
    access: [...VIEW],
    input: z.object({ id: zId, from: zOptDate, to: zOptDate }),
    handler: (ctx, input) => loans.getLoan(ctx, input.id, input),
  }),
  'loans.transaction': route({ access: 'accounts.manage', mutation: true, input: zLoanTx, handler: (ctx, input) => loans.loanTransaction(ctx, input) }),
  'loans.update': route({
    access: 'accounts.manage',
    mutation: true,
    input: z.object({
      id: zId,
      name: z.string().trim().min(1, 'Enter who the loan is from / to').max(60),
      principal: zPaise.optional(),
      interestRate: zRate,
      startDate: zDate.nullish(),
      notes: zOptText(1000),
      isActive: z.boolean().optional(),
    }),
    handler: (ctx, { id, ...input }) => loans.updateLoan(ctx, id, input),
  }),

  /* ------------------------------ Books ------------------------------ */
  'books.cashBook': route({ access: BOOKS, input: zRange.extend({ accountId: zOptAccountId }), handler: (ctx, input) => books.cashBook(ctx, input) }),
  'books.bankBook': route({ access: BOOKS, input: zRange.extend({ accountId: zOptAccountId }), handler: (ctx, input) => books.bankBook(ctx, input) }),
  'books.dayBook': route({ access: BOOKS, input: zRange.extend({ voucherType: zVoucherType.nullish() }), handler: (ctx, input) => books.dayBook(ctx, input) }),
  'books.ledger': route({
    access: BOOKS,
    input: zRange.extend({ accountId: zOptAccountId, partyType: zPartyType.nullish(), partyId: z.number().int().positive().nullish() }),
    handler: (ctx, input) => books.ledger(ctx, input),
  }),

  /* ------------------------------ Year-end closing ------------------------------ */
  'yearEnd.list': route({ access: 'accounts.close_year', handler: (ctx) => yearEnd.listYears(ctx) }),
  'yearEnd.preview': route({
    access: 'accounts.close_year',
    input: z.object({ fyStart: zDate, transferDrawings: z.boolean().default(true) }),
    handler: (ctx, input) => yearEnd.previewClosing(ctx, input.fyStart, input.transferDrawings),
  }),
  /** Not a "mutation" route: it takes a safety backup first (outside any transaction), then closes the year in its own transaction. */
  'yearEnd.close': route({
    access: 'accounts.close_year',
    input: z.object({ fyStart: zDate, transferDrawings: z.boolean().default(true) }),
    handler: (ctx, input) => yearEnd.closeYear(ctx, input.fyStart, input.transferDrawings),
  }),
  'yearEnd.reopen': route({
    access: 'accounts.close_year',
    input: z.object({ fyStart: zDate, reason: zOptText(500) }),
    handler: (ctx, input) => yearEnd.reopenYear(ctx, input.fyStart, input.reason),
  }),
};
