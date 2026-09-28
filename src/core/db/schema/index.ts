import { CORE_SCHEMA } from './core';
import { ACCOUNTING_SCHEMA } from './accounting';
import { MASTERS_SCHEMA } from './masters';
import { SALES_SCHEMA } from './sales';
import { PURCHASES_SCHEMA } from './purchases';
import { EMPLOYEES_SCHEMA } from './employees';

/** Complete schema for database version 1, in dependency order. */
export const SCHEMA_V1 = [CORE_SCHEMA, ACCOUNTING_SCHEMA, MASTERS_SCHEMA, SALES_SCHEMA, PURCHASES_SCHEMA, EMPLOYEES_SCHEMA].join('\n');
