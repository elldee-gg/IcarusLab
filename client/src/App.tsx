import { Route, Routes } from 'react-router-dom';
import { AdminAccounts, AdminDashboard, AdminSettings, AdminShell, AdminTelemetry } from './AdminPage';
import { AuthProvider, SessionGate } from './auth';
import { CalendarPage } from './CalendarPage';
import { DrivePage } from './DrivePage';
import { LoginPage } from './LoginPage';
import { SetupPage } from './SetupPage';
import { UserLayout } from './shell';
import { AppearanceProvider, UserSettings } from './theme';

export function App() {
  return (
    <AuthProvider>
    <AppearanceProvider>
      <SessionGate>
        <Routes>
          <Route path="/" element={<LoginPage />} />
          <Route path="/setup-account" element={<SetupPage />} />
          <Route path="/admin" element={<AdminShell />}>
            <Route index element={<AdminDashboard />} />
            <Route path="accounts" element={<AdminAccounts />} />
            <Route path="telemetry" element={<AdminTelemetry />} />
            <Route path="settings" element={<AdminSettings />} />
          </Route>
          <Route element={<UserLayout />}>
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/dashboard/settings" element={<UserSettings />} />
            <Route path="/dashboard" element={<DrivePage />} />
            <Route path="/dashboard/folder/:folderId" element={<DrivePage />} />
            <Route path="/dashboard/shared" element={<DrivePage />} />
            <Route path="/dashboard/trash" element={<DrivePage />} />
            <Route path="/dashboard/search" element={<DrivePage />} />
          </Route>
        </Routes>
      </SessionGate>
    </AppearanceProvider>
    </AuthProvider>
  );
}
