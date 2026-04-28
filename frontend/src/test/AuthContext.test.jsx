import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { AuthProvider, useAuth } from '../context/AuthContext';

// Mock the api/client module
vi.mock('../api/client', () => ({
  setAccessToken: vi.fn(),
  clearAccessToken: vi.fn(),
  api: {
    refresh: vi.fn(),
    logout: vi.fn(),
    getMe: vi.fn(),
  },
}));

import { api, setAccessToken } from '../api/client';

function UserDisplay() {
  const { user, loading } = useAuth();
  if (loading) return <span>loading</span>;
  if (!user) return <span>no user</span>;
  return <span>{user.role}</span>;
}

afterEach(() => vi.clearAllMocks());

describe('AuthContext — session restore', () => {
  it('sets user from server response, not token payload', async () => {
    api.refresh.mockResolvedValue('fake.token.here');
    api.getMe.mockResolvedValue({ id: 1, name: 'Alice', email: 'a@test.com', role: 'farmer' });

    render(<AuthProvider><UserDisplay /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('farmer')).toBeInTheDocument());
    expect(api.getMe).toHaveBeenCalledTimes(1);
  });

  it('modified token payload does not grant elevated UI access', async () => {
    // Attacker crafts a token with role=admin in the payload (base64-encoded)
    const fakeAdminPayload = btoa(JSON.stringify({ id: 1, role: 'admin' }));
    const tamperedToken = `header.${fakeAdminPayload}.signature`;

    // refresh returns the tampered token, but getMe returns the real DB role
    api.refresh.mockResolvedValue(tamperedToken);
    api.getMe.mockResolvedValue({ id: 1, name: 'Alice', email: 'a@test.com', role: 'farmer' });

    render(<AuthProvider><UserDisplay /></AuthProvider>);
    await waitFor(() => expect(screen.queryByText('loading')).not.toBeInTheDocument());

    // UI must show the server-verified role, not the tampered payload role
    expect(screen.getByText('farmer')).toBeInTheDocument();
    expect(screen.queryByText('admin')).not.toBeInTheDocument();
  });

  it('stays logged out when refresh fails', async () => {
    api.refresh.mockRejectedValue(new Error('no cookie'));

    render(<AuthProvider><UserDisplay /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('no user')).toBeInTheDocument());
    expect(api.getMe).not.toHaveBeenCalled();
  });
});
