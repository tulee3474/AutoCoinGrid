import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { AuthUser, login as apiLogin, register as apiRegister, getMe } from '../utils/api';

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function loadFromStorage(): { user: AuthUser | null; token: string | null } {
  try {
    const token = localStorage.getItem('token');
    const raw   = localStorage.getItem('user');
    const user  = raw ? (JSON.parse(raw) as AuthUser) : null;
    return { token, user };
  } catch {
    return { token: null, user: null };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const initial = loadFromStorage();
  const [token, setToken]     = useState<string | null>(initial.token);
  const [user, setUser]       = useState<AuthUser | null>(initial.user);
  const [isLoading, setIsLoading] = useState(false);

  const persist = (t: string, u: AuthUser) => {
    localStorage.setItem('token', t);
    localStorage.setItem('user', JSON.stringify(u));
    setToken(t);
    setUser(u);
  };

  const login = useCallback(async (email: string, password: string) => {
    setIsLoading(true);
    try {
      const { token: t, user: u } = await apiLogin(email, password);
      persist(t, u);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    setIsLoading(true);
    try {
      const { token: t, user: u } = await apiRegister(email, password);
      persist(t, u);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setToken(null);
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const u = await getMe();
      setUser(u);
      localStorage.setItem('user', JSON.stringify(u));
    } catch { /* 토큰 만료 시 interceptor가 처리 */ }
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
