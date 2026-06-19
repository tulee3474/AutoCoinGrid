import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import Strategy from './components/Strategy';
import Backtest from './components/Backtest';
import PaperTrading from './components/PaperTrading';
import LiveTrading from './components/LiveTrading';
import Guide from './components/Guide';
import Login from './pages/Login';
import Admin from './pages/Admin';
import Profile from './pages/Profile';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  const { token } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={token ? <Navigate to="/dashboard" replace /> : <Login />}
      />

      <Route path="/admin" element={<Admin />} />

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
        <Route path="strategy"  element={<Strategy />} />
        <Route path="backtest"  element={<Backtest />} />
        <Route path="paper"     element={<PaperTrading />} />
        <Route path="live"      element={<LiveTrading />} />
        <Route path="profile"   element={<Profile />} />
        <Route path="guide"     element={<Guide />} />
      </Route>

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
