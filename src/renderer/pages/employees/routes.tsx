import type { AppRoute } from '../../routing';
import { Placeholder } from '../Placeholder';

export const employeesPages: AppRoute[] = [
  { path: '/employees', element: <Placeholder title="Employees" />, perm: 'employees.view' },
  { path: '/employees/attendance', element: <Placeholder title="Attendance" />, perm: 'employees.attendance' },
  { path: '/employees/salary', element: <Placeholder title="Salary" />, perm: 'employees.salary' },
  { path: '/employees/advances', element: <Placeholder title="Advances" />, perm: 'employees.salary' },
];
