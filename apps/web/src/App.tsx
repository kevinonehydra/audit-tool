import { useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE_URL;

export default function App() {
  const [email, setEmail] = useState("kevin@test.com");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<any>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email, password })
      });

      if (!res.ok) {
        throw new Error(`Login failed (${res.status})`);
      }

      const data = await res.json();
      localStorage.setItem("token", data.token);
      setUser(data.user);
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (user) {
    return (
      <div style={{ padding: 40 }}>
        <h1>Logged in</h1>
        <pre>{JSON.stringify(user, null, 2)}</pre>
      </div>
    );
  }

  return (
    <div style={{ padding: 40 }}>
      <h1>SC-Audit-Copilot</h1>

      {error && (
        <div style={{ color: "red", marginBottom: 10 }}>
          {error}
        </div>
      )}

      <form onSubmit={handleLogin}>
        <div>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
          />
        </div>

        <div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
          />
        </div>

        <button type="submit">Login</button>
      </form>
    </div>
  );
}
