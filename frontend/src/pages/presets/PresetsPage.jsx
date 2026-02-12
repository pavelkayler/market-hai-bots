import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Col, Form, Row, Table } from "react-bootstrap";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";
const PARAMS = ["impulseZ", "minSamples", "minImpulses", "minCorr", "entryWindowMs", "cooldownSec", "edgeMult", "confirmZ", "riskQtyMultiplier"];

const emptyPreset = {
  name: "",
  shortlistMax: 10,
  params: {
    impulseZ: 2,
    minSamples: 200,
    minImpulses: 5,
    minCorr: 0.12,
    entryWindowMs: 3000,
    cooldownSec: 15,
    edgeMult: 1,
    confirmZ: 1,
    riskQtyMultiplier: 1,
  },
  bounds: {
    impulseZ: { min: 1, max: 5 },
    minSamples: { min: 30, max: 2000 },
    minImpulses: { min: 1, max: 200 },
    minCorr: { min: 0.02, max: 0.95 },
    entryWindowMs: { min: 250, max: 15000 },
    cooldownSec: { min: 0, max: 600 },
    edgeMult: { min: 0.5, max: 5 },
    confirmZ: { min: 0.2, max: 5 },
    riskQtyMultiplier: { min: 0.1, max: 5 },
  },
  excludedCoins: [],
};

async function api(path, init) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { "content-type": "application/json" }, ...init });
  return res.json();
}

function normalizeForEdit(preset) {
  return {
    ...emptyPreset,
    ...preset,
    params: { ...emptyPreset.params, ...(preset?.params || {}) },
    bounds: { ...emptyPreset.bounds, ...(preset?.bounds || {}) },
    excludedCoins: Array.isArray(preset?.excludedCoins) ? preset.excludedCoins : [],
  };
}

export default function PresetsPage() {
  const [data, setData] = useState({ presets: [], activePresetId: null });
  const [edit, setEdit] = useState(emptyPreset);
  const [editingId, setEditingId] = useState(null);
  const [msg, setMsg] = useState("");

  const activeName = useMemo(() => data.presets.find((p) => p.id === data.activePresetId)?.name || "—", [data]);

  async function load() {
    const x = await api("/api/presets");
    setData(x);
  }

  useEffect(() => { load(); }, []);

  const save = async () => {
    if (editingId) await api(`/api/presets/${editingId}`, { method: "PUT", body: JSON.stringify(edit) });
    else await api("/api/presets", { method: "POST", body: JSON.stringify(edit) });
    setEdit(emptyPreset);
    setEditingId(null);
    setMsg("Saved");
    load();
  };

  const selectPreset = async (id) => {
    await api(`/api/presets/${id}/select`, { method: "POST" });
    load();
  };

  const clonePreset = async (p) => {
    const next = { ...p, id: undefined, name: `${p.name} copy` };
    await api("/api/presets", { method: "POST", body: JSON.stringify(next) });
    load();
  };

  const delPreset = async (id) => {
    await api(`/api/presets/${id}`, { method: "DELETE" });
    load();
  };

  const addExcluded = () => setEdit((prev) => ({ ...prev, excludedCoins: [...(prev.excludedCoins || []), { symbol: "", source: "ANY", attempts: 0, reason: "", updatedAt: Date.now() }] }));

  return (
    <Row className="g-3">
      <Col md={7}>
        <Card>
          <Card.Body>
            <div className="d-flex align-items-center justify-content-between mb-2">
              <h5 className="m-0">Пресеты</h5>
              <Badge bg="secondary">Active: {activeName}</Badge>
            </div>
            <Table bordered size="sm">
              <thead><tr><th>Name</th><th>PnL</th><th>ROI%</th><th>Actions</th></tr></thead>
              <tbody>
                {data.presets.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name} {p.isSessionClone ? <Badge bg="info">session</Badge> : null}</td>
                    <td>{Number(p.stats?.pnlUsdt || 0).toFixed(2)}</td>
                    <td>{Number(p.stats?.roiPct || 0).toFixed(2)}</td>
                    <td className="d-flex gap-1 flex-wrap">
                      <Button size="sm" onClick={() => selectPreset(p.id)} variant={p.id === data.activePresetId ? "success" : "outline-success"}>Select</Button>
                      <Button size="sm" variant="outline-primary" onClick={() => { setEdit(normalizeForEdit(p)); setEditingId(p.id); }}>Edit</Button>
                      <Button size="sm" variant="outline-secondary" onClick={() => clonePreset(p)}>Clone</Button>
                      <Button size="sm" variant="outline-danger" onClick={() => delPreset(p.id)}>Delete</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card.Body>
        </Card>
      </Col>
      <Col md={5}>
        <Card>
          <Card.Body className="d-grid gap-2">
            <h6>{editingId ? "Edit preset" : "Create preset"}</h6>
            {msg ? <Alert className="py-2 mb-1">{msg}</Alert> : null}
            <Form.Control value={edit.name || ""} placeholder="Name" onChange={(e) => setEdit((p) => ({ ...p, name: e.target.value }))} />
            <Form.Group><Form.Label>shortlistMax</Form.Label><Form.Control type="number" value={edit.shortlistMax} onChange={(e) => setEdit((p) => ({ ...p, shortlistMax: Number(e.target.value) }))} /></Form.Group>
            <div className="fw-semibold mt-1">Params</div>
            {PARAMS.map((k) => (
              <Form.Group key={k}><Form.Label>{k}</Form.Label><Form.Control type="number" value={edit.params?.[k]} onChange={(e) => setEdit((p) => ({ ...p, params: { ...(p.params || {}), [k]: Number(e.target.value) } }))} /></Form.Group>
            ))}
            <details>
              <summary className="fw-semibold">Bounds (advanced)</summary>
              <div className="mt-2 d-grid gap-1">
                {PARAMS.map((k) => (
                  <Row key={k} className="g-1">
                    <Col xs={4} className="small">{k}</Col>
                    <Col><Form.Control type="number" placeholder="min" value={edit.bounds?.[k]?.min} onChange={(e) => setEdit((p) => ({ ...p, bounds: { ...(p.bounds || {}), [k]: { ...(p.bounds?.[k] || {}), min: Number(e.target.value) } } }))} /></Col>
                    <Col><Form.Control type="number" placeholder="max" value={edit.bounds?.[k]?.max} onChange={(e) => setEdit((p) => ({ ...p, bounds: { ...(p.bounds || {}), [k]: { ...(p.bounds?.[k] || {}), max: Number(e.target.value) } } }))} /></Col>
                  </Row>
                ))}
              </div>
            </details>
            <div className="fw-semibold">Excluded coins</div>
            {(edit.excludedCoins || []).map((row, i) => (
              <Row key={i} className="g-1">
                <Col><Form.Control placeholder="symbol" value={row.symbol} onChange={(e) => setEdit((p) => ({ ...p, excludedCoins: p.excludedCoins.map((x, ix) => ix === i ? { ...x, symbol: e.target.value } : x) }))} /></Col>
                <Col>
                  <Form.Select value={row.source} onChange={(e) => setEdit((p) => ({ ...p, excludedCoins: p.excludedCoins.map((x, ix) => ix === i ? { ...x, source: e.target.value } : x) }))}>
                    <option>ANY</option><option>BT</option><option>BNB</option>
                  </Form.Select>
                </Col>
                <Col><Form.Control placeholder="reason" value={row.reason} onChange={(e) => setEdit((p) => ({ ...p, excludedCoins: p.excludedCoins.map((x, ix) => ix === i ? { ...x, reason: e.target.value } : x) }))} /></Col>
              </Row>
            ))}
            <Button size="sm" variant="outline-secondary" onClick={addExcluded}>+ Add excluded</Button>
            <div className="d-flex gap-2">
              <Button onClick={save}>Save</Button>
              <Button variant="outline-secondary" onClick={() => { setEdit(emptyPreset); setEditingId(null); }}>Reset</Button>
            </div>
          </Card.Body>
        </Card>
      </Col>
    </Row>
  );
}
