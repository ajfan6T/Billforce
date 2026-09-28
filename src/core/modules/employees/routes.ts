import { z } from 'zod';
import { route } from '../../api/router';
import * as employees from './service';

export const employeesRoutes = {
  /** CONTRACT: employee picker. */
  'employees.search': route({
    access: ['employees.view', 'employees.attendance', 'employees.salary'],
    input: z.object({ q: z.string().optional(), includeInactive: z.boolean().optional() }),
    handler: (ctx, input) => employees.searchEmployees(ctx, input.q, input.includeInactive),
  }),
};
