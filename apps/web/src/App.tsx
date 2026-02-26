import { useEffect, useState } from "react";

type LoginResp =
  | { ok: true; token: string; user: { id: string; email: string; role: string } }
  | { ok: false; message: string };

type MeResp =
  | { ok: true; user: { sub: string; email: string; role: string } }
  | { ok: false; message: string };

type Audit = {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  site: string;
  standard: string;
  auditor: string;
  userId: string | null;
};

type ListAuditsResp =
  | { ok: true; audits: Audit[] }
  | { ok: false; message: string };

type CreateAuditResp =
  | { ok: true; audit: Audit }
  | { ok: false; message: string };

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3001";

function getToken() {
  return localStorage.getItem("token");
}
function setToken(t: string) {
  localStorage.setItem("token", t);
}
function clearToken() {
  localStorage.removeItem("token");
}

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(opts.headers);

  if (!headers.has("content-type") && opts.body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);

  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });

  const text = await res.text();
  const json = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const msg = json?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}

export default function App() {
  const [email, setEmail] = useState("kevin@test.com");
  const [password, setPassword] = useState("Password123!");
  const [authUser, setAuthUser] = useState<{ id: string; email: string; role: string } | null>(null);

  const [status, setStatus] = useState<string>("");
  const [audits, setAudits] = useState<Audit[]>([]);
  const [loadingAudits, setLoadingAudits] = useState(false);

  const [newTitle, setNewTitle] = useState("My First Audit");
  const [newSite, setNewSite] = useState("JHB-DC-01");
  const [newStandard, setNewStandard] = useState("TIA-942");
  const [newAuditor, setNewAuditor] = useState("Kevin");

  async function login() {
    setStatus("");
    try {
      const resp = await apiFetch<LoginResp>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      if (!resp.ok) throw new Error(resp.message);

      setToken(resp.token);
      setAuthUser(resp.user);
      setStatus("✅ Logged in");

      await loadAudits();
    } catch (e: any) {
      clearToken();
      setAuthUser(null);
      setStatus(`❌ Login failed: ${e?.message ?? "unknown error"}`);
    }
  }

  async function logout() {
    clearToken();
    setAuthUser(null);
    setAudits([]);
    setStatus("Logged out");
  }

  async function loadAudits() {
    setLoadingAudits(true);
    try {
      const resp = await apiFetch<ListAuditsResp>("/audits");
      if (!resp.ok) throw new Error(resp.message);
      setAudits(resp.audits);
    } catch (e: any) {
      setStatus(`❌ Failed to load audits: ${e?.message ?? "unknown error"}`);
    } finally {
      setLoadingAudits(false);
    }
  }

  async function createAudit() {
    setStatus("");
    try {
      const resp = await apiFetch<CreateAuditResp>("/audits", {
        method: "POST",
        body: JSON.stringify({
          title: newTitle,
          site: newSite,
          standard: newStandard,
          auditor: newAuditor,
        }),
      });
      if (!resp.ok) throw new Error(resp.message);

      setStatus("✅ Audit created");
      await loadAudits();
    } catch (e: any) {
      setStatus(`❌ Failed to create audit: ${e?.message ?? "unknown error"}`);
    }
  }

  // Auto-resume session from token
  useEffect(() => {
    const t = getToken();
    if (!t) return;

    (async () => {
      try {
        const me = await apiFetch<MeResp>("/auth/me");
        if (me.ok) {
          setAuthUser({ id: me.user.sub, email: me.user.email, role: me.user.role });
          await loadAudits();
        } else {
          clearToken();
        }
      } catch {
        clearToken();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tokenExists = !!getToken();

  return (
    <div style={{ padding: 32, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <h1 style={{ margin: 0, fontSize: 44 }}>SC-Audit-Copilot</h1>
      <p style={{ color: "#b00020", minHeight: 24 }}>{status}</p>

      {!tokenExists ? (
        <div style={{ maxWidth: 420 }}>
          <div style={{ display: "grid", gap: 8 }}>
            <label>
              Email
              <input value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: "100%" }} />
            </label>

            <label>
              Password
              <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" style={{ width: "100%" }} />
            </label>

            <button onClick={login} style={{ padding: 10 }}>
              Login
            </button>
          </div>

          <div style={{ marginTop: 16, color: "#666", fontSize: 13 }}>
            API: <code>{API_BASE}</code>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 18, maxWidth: 900 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 600 }}>
                Welcome{authUser?.email ? `, ${authUser.email}` : ""}
              </div>
              <div style={{ color: "#666" }}>Role: {authUser?.role ?? "unknown"}</div>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={loadAudits} disabled={loadingAudits} style={{ padding: 10 }}>
                {loadingAudits ? "Loading..." : "Refresh audits"}
              </button>
              <button onClick={logout} style={{ padding: 10 }}>
                Logout
              </button>
            </div>
          </div>

          <hr style={{ margin: "18px 0" }} />

          <h2 style={{ marginTop: 0 }}>Create Audit</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <label>
              Title
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} style={{ width: "100%" }} />
            </label>
            <label>
              Site
              <input value={newSite} onChange={(e) => setNewSite(e.target.value)} style={{ width: "100%" }} />
            </label>
            <label>
              Standard
              <input value={newStandard} onChange={(e) => setNewStandard(e.target.value)} style={{ width: "100%" }} />
            </label>
            <label>
              Auditor
              <input value={newAuditor} onChange={(e) => setNewAuditor(e.target.value)} style={{ width: "100%" }} />
            </label>
          </div>

          <button onClick={createAudit} style={{ marginTop: 10, padding: 10 }}>
            Create
          </button>

          <hr style={{ margin: "18px 0" }} />

          <h2 style={{ marginTop: 0 }}>Audits</h2>

          {audits.length === 0 ? (
            <div style={{ color: "#666" }}>No audits yet. Create one above, then refresh.</div>
          ) : (
            <div style={{ border: "1px solid #eee", borderRadius: 8, overflow: "hidden" }}>
              {audits.map((a) => (
                <div key={a.id} style={{ padding: 12, borderBottom: "1px solid #eee" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <div style={{ fontWeight: 700 }}>{a.title}</div>
                      <div style={{ color: "#666", fontSize: 13 }}>
                        {a.site} • {a.standard} • {a.auditor}
                      </div>
                    </div>
                    <div style={{ color: "#666", fontSize: 12 }}>
                      <div>ID: {a.id}</div>
                      <div>User: {a.userId ?? "null"}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 16, color: "#666", fontSize: 13 }}>
            API: <code>{API_BASE}</code>
          </div>
        </div>
      )}
    </div>
  );
}
