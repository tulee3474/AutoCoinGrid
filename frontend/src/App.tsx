import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import Scanner from './components/Scanner';
import Strategy from './components/Strategy';
import Backtest from './components/Backtest';
import Positions from './components/Positions';
import PaperTrading from './components/PaperTrading';
import Guide from './components/Guide';
import Login from './pages/Login';
import Admin from './pages/Admin';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const { token } = useAuth();

  return (
    <Routes>
      {/* 로그인 — 이미 인증된 경우 대시보드로 */}
      <Route
        path="/login"
        element={token ? <Navigate to="/dashboard" replace /> : <Login />}
      />

      {/* 관리자 — Layout 밖, 별도 인증 */}
      <Route path="/admin" element={<Admin />} />

      {/* 일반 사용자 페이지 — 인증 필요 */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="scanner"   element={<Scanner />} />
        <Route path="strategy"  element={<Strategy />} />
        <Route path="backtest"  element={<Backtest />} />
        <Route path="positions" element={<Positions />} />
        <Route path="paper"     element={<PaperTrading />} />
        <Route path="guide"     element={<Guide />} />
      </Route>

      {/* 매칭되지 않는 경로 */}
      <Route path="*" element={<Navigate to={token ? '/dashboard' : '/login'} replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
