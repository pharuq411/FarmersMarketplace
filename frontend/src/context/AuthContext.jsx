import React, { createContext, useContext, useState, useEffect } from 'react';
import { api, setAccessToken, clearAccessToken } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true); // wait for silent refresh on mount

  // On mount: attempt silent refresh to restore session from HttpOnly cookie
  useEffect(() => {
    api.refresh()
      .then((token) => {
        if (token) return api.getMe();
      })
      .then((userData) => {
        if (userData) setUser(userData);
      })
      .catch(() => {}) // no cookie or expired — stay logged out
      .finally(() => setLoading(false));
  }, []);

  function login(token, userData) {
    setAccessToken(token);
    setUser(userData);
  }

  async function logout() {
    try { await api.logout(); } catch { /* best-effort */ }
    clearAccessToken();
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, login, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
