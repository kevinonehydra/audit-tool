import { useEffect, useMemo, useState } from "react";
import { api, clearToken, getToken, setToken } from "./lib/api";

type LoginResp = {
  ok: boolean;
  token: string;
  user: { id: string; email: string; role: string };
};

type Audit = {
  id: string;
  title: string;
  site: string;
  standard: string;
  auditor: string;
  userId: string | null;
  createdAt: string;
};

type Finding = {
  id: string;
  auditId: string;
  title: string;
  severity?: string | null;
  status?: string | null;
  description?: string | null;
  createdAt: string;
};

function isoToLocal(s: string) {
  try {
    return new Date(s).toLocaleString();
  } catch {
    return s;
  }
}

export default function App() {
  const [email, setEmail] = useState("kevin@test.com");
  const [password, setPassword] = useState("Password123!");
  const [token, setTok] = useState<string | null>(getToken());

  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [audits, setAudits] = useState<Audit[]>([]);
  const [selectedAuditId, setSelectedAuditId] = useState<string | null>(null);

  const [findings, setFindings] = useState<Finding[]>([]);
  const [findingTitle, setFindingTitle] = useState("UPS Maintenance Finding");
  const [findingSeverity, setFindingSeverity] = useState("medium");
  const [findingStatus, setFindingStatus] = useState("open");
  const [findingDescription, setFindingDescription] = useState(
    "Observed gap in UPS maintenance records."
  );

  const [newTitle, setNewTitle] = useState("My First Web Audit");
  const [newSite, setNewSite] = useState("JHB-DC-01");
  const [newStandard, setNewStandard] = useState("TIA-942");
  const [newAuditor, setNewAuditor] = useState("Kevin");

  const authed = useMemo(() => !!token, [token]);

  async function login() {
    setLoading(true);
    setMsg(null);
    try {
      const { data } = await api.post<LoginResp>("/auth/login", { email, password });
      if (!data?.ok || !data.token) throw new Error("Login failed");
      setToken(data.token);
      setTok(data.token);
      setMsg("Logged in ✅");
    } catch (e: any) {
      setMsg(e?.response?.data?.message ?? e?.message ?? "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function loadAudits() {
    setLoading(true);
    setMsg(null);
    try {
      const { data } = await api.get<{ ok: boolean; audits: Audit[] }>("/audits");
      setAudits(data.audits ?? []);
    } catch (e: any) {
      setMsg(e?.response?.data?.message ?? e?.message ?? "Failed to load audits");
    } finally {
      setLoading(false);
    }
  }

  async function createAudit() {
    setLoading(true);
    setMsg(null);
    try {
      const { data } = await api.post<{ ok: boolean; audit: Audit }>("/audits", {
        title: newTitle,
        site: newSite,
        standard: newStandard,
        auditor: newAuditor,
      });
      setMsg("Audit created ✅");
      setAudits((prev) => [data.audit, ...prev]);
    } catch (e: any) {
      setMsg(e?.response?.data?.message ?? e?.message ?? "Failed to create audit");
    } finally {
      setLoading(false);
    }
  }

  async function loadFindings(auditId: string) {
    setLoading(true);
    setMsg(null);
    try {
      const { data } = await api.get<{ ok: boolean; findings: Finding[] }>(
        `/audits/${auditId}/findings`
      );
      setFindings(data.findings ?? []);
    } catch (e: any) {
      setMsg(e?.response?.data?.message ?? e?.message ?? "Failed to load findings");
      setFindings([]);
    } finally {
      setLoading(false);
    }
  }

  async function createFinding() {
    if (!selectedAuditId) {
      setMsg("Select an audit first.");
      return;
    }
    setLoading(true);
    setMsg(null);
    try {
      const { data } = await api.post<{ ok: boolean; finding: Finding }>(
        `/audits/${selectedAuditId}/findings`,
        {
          title: findingTitle,
          severity: findingSeverity,
          status: findingStatus,
          description: findingDescription,
        }
      );
      setMsg("Finding created ✅");
      setFindings((prev) => [data.finding, ...prev]);
    } catch (e: any) {
      setMsg(
        e?.response?.data?.message ??
          e?.message ??
          "Failed to create finding (check API route)"
      );
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    clearToken();
    setTok(null);
    setAudits([]);
    setSelectedAuditId(null);
    setFindings([]);
    setMsg("Logged out 👋");
  }

  useEffect(() => {
    if (authed) loadAudits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial", padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ margin: 0 }}>sc-audit-copilot</h1>
      <p style={{ marginTop: 8, opacity: 0.8 }}>Stage 8: Web UI → Audits → Findings</p>

      {msg && (
        <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 10, margin: "12px 0" }}>
          {msg}
        </div>
      )}

      {!authed ? (
        <div style={{ display: "grid", gap: 10, maxWidth: 420, padding: 16, border: "1px solid #eee", borderRadius: 12 }}>
          <h2 style={{ margin: 0 }}>Login</h2>

          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: "100%", padding: 10, marginTop: 6 }} />
          </label>

          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: "100%", padding: 10, marginTop: 6 }} />
          </label>

          <button onClick={login} disabled={loading} style={{ padding: 10 }}>
            {loading ? "Working..." : "Login"}
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
            <button onClick={loadAudits} disabled={loading} style={{ padding: 10 }}>
              Refresh audits
            </button>
            <button onClick={logout} style={{ padding: 10 }}>
              Logout
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 16 }}>
            <div style={{ padding: 16, border: "1px solid #eee", borderRadius: 12 }}>
              <h2 style={{ marginTop: 0 }}>Create audit</h2>

              <label>
                Title
                <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} style={{ width: "100%", padding: 10, marginTop: 6 }} />
              </label>

              <label>
                Site
                <input value={newSite} onChange={(e) => setNewSite(e.target.value)} style={{ width: "100%", padding: 10, marginTop: 6 }} />
              </label>

              <label>
                Standard
                <input value={newStandard} onChange={(e) => setNewStandard(e.target.value)} style={{ width: "100%", padding: 10, marginTop: 6 }} />
              </label>

              <label>
                Auditor
                <input value={newAuditor} onChange={(e) => setNewAuditor(e.target.value)} style={{ width: "100%", padding: 10, marginTop: 6 }} />
              </label>

              <button onClick={createAudit} disabled={loading} style={{ padding: 10, marginTop: 10 }}>
                {loading ? "Working..." : "Create"}
              </button>

              <hr style={{ margin: "16px 0" }} />

              <h2 style={{ marginTop: 0 }}>Audits ({audits.length})</h2>

              <div style={{ display: "grid", gap: 10, maxHeight: 420, overflow: "auto" }}>
                {audits.map((a) => {
                  const active = a.id === selectedAuditId;
                  return (
                    <button
                      key={a.id}
                      onClick={() => {
                        setSelectedAuditId(a.id);
                        loadFindings(a.id);
                      }}
                      style={{
                        textAlign: "left",
                        border: active ? "2px solid #111" : "1px solid #f0f0f0",
                        borderRadius: 10,
                        padding: 12,
                        background: "white",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontWeight: 800 }}>{a.title}</div>
                      <div style={{ opacity: 0.8 }}>{a.site} • {a.standard} • {a.auditor}</div>
                      <div style={{ opacity: 0.6, fontSize: 12 }}>id: <code>{a.id}</code></div>
                      <div style={{ opacity: 0.6, fontSize: 12 }}>
                        created: {isoToLocal(a.createdAt)} • userId: <code>{String(a.userId)}</code>
                      </div>
                    </button>
                  );
                })}
                {audits.length === 0 && <div style={{ opacity: 0.7 }}>No audits yet.</div>}
              </div>
            </div>

            <div style={{ padding: 16, border: "1px solid #eee", borderRadius: 12 }}>
              <h2 style={{ marginTop: 0 }}>Findings</h2>

              {!selectedAuditId ? (
                <div style={{ opacity: 0.7 }}>Select an audit to load findings.</div>
              ) : (
                <>
                  <div style={{ opacity: 0.7, marginBottom: 10 }}>
                    Audit: <code>{selectedAuditId}</code>
                  </div>

                  <div style={{ padding: 12, border: "1px solid #f0f0f0", borderRadius: 10 }}>
                    <div style={{ fontWeight: 700, marginBottom: 8 }}>Create finding</div>

                    <label>
                      Title
                      <input value={findingTitle} onChange={(e) => setFindingTitle(e.target.value)} style={{ width: "100%", padding: 10, marginTop: 6 }} />
                    </label>

                    <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                      <label style={{ flex: 1 }}>
                        Severity
                        <input value={findingSeverity} onChange={(e) => setFindingSeverity(e.target.value)} style={{ width: "100%", padding: 10, marginTop: 6 }} />
                      </label>
                      <label style={{ flex: 1 }}>
                        Status
                        <input value={findingStatus} onChange={(e) => setFindingStatus(e.target.value)} style={{ width: "100%", padding: 10, marginTop: 6 }} />
                      </label>
                    </div>

                    <label style={{ display: "block", marginTop: 10 }}>
                      Description
                      <textarea value={findingDescription} onChange={(e) => setFindingDescription(e.target.value)} rows={3} style={{ width: "100%", padding: 10, marginTop: 6 }} />
                    </label>

                    <button onClick={createFinding} disabled={loading} style={{ padding: 10, marginTop: 10 }}>
                      {loading ? "Working..." : "Create finding"}
                    </button>

                    <div style={{ fontSize: 12, opacity: 0.65, marginTop: 6 }}>
                      Calls <code>POST /api/audits/:id/findings</code>
                    </div>
                  </div>

                  <div style={{ display: "grid", gap: 10, marginTop: 12, maxHeight: 360, overflow: "auto" }}>
                    {findings.map((f) => (
                      <div key={f.id} style={{ border: "1px solid #f0f0f0", borderRadius: 10, padding: 12 }}>
                        <div style={{ fontWeight: 800 }}>{f.title}</div>
                        <div style={{ opacity: 0.8 }}>{f.severity ?? "—"} • {f.status ?? "—"}</div>
                        {f.description ? <div style={{ marginTop: 6, opacity: 0.85 }}>{f.description}</div> : null}
                        <div style={{ opacity: 0.6, fontSize: 12, marginTop: 6 }}>
                          id: <code>{f.id}</code> • created: {isoToLocal(f.createdAt)}
                        </div>
                      </div>
                    ))}

                    {findings.length === 0 ? (
                      <div style={{ opacity: 0.7 }}>No findings yet for this audit.</div>
                    ) : null}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
