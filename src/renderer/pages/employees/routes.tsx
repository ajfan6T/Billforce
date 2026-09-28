import type { AppRoute } from '../../routing';
import { EmployeesListPage } from './EmployeesList';
import { EmployeeDetailPage } from './EmployeeDetail';
import { AttendancePage } from './AttendancePage';
import { SalaryPage } from './SalaryPage';
import { SalaryDetailPage } from './SalaryDetail';
import { AdvancesPage } from './AdvancesPage';

export const employeesPages: AppRoute[] = [
  { path: '/employees', element: <EmployeesListPage />, perm: 'employees.view' },
  { path: '/employees/attendance', element: <AttendancePage />, perm: 'employees.attendance' },
  { path: '/employees/salary', element: <SalaryPage />, perm: 'employees.salary' },
  { path: '/employees/salary/:id', element: <SalaryDetailPage />, perm: 'employees.salary' },
  { path: '/employees/advances', element: <AdvancesPage />, perm: 'employees.salary' },
  { path: '/employees/:id', element: <EmployeeDetailPage />, perm: 'employees.view' },
];
