import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Col, Form, Nav, Row, Tab, Table } from "react-bootstrap";
import { useWsClient } from "../../shared/api/ws.js";
import { mergeNonUndefined } from "../../shared/utils/merge.js";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";

const cleanPositions = (rows = []) => rows.filter((r) => Number(r?.size) !== 0);
const cleanHistory = (rows = []) => rows
  .filter((r) => Number.isFinite(Number(r?.closedPnl)))
  .sort((a, b) => Number(b?.updatedTime || b?.createdTime || 0) - Number(a?.updatedTime || a?.createdTime || 0))
  .slice(0, 100);

const fmt = (x, d = 6) => (Number.isFinite(Number(x)) ? Number(x).toFixed(d) : "—");
const fmtTs = (ts) => (Number.isFinite(Number(ts)) ? new Date(Number(ts)).toLocaleTimeString() : "—");
const fmtUptime = (startedAt) => { const sec = Math.max(0, Math.floor((Date.now() - Number(startedAt || 0)) / 1000)); const h = String(Math.floor(sec / 3600)).padStart(2, "0"); const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0"); const s = String(sec % 60).padStart(2, "0"); return `${h}:${m}:${s}`; };
const applyArrayPatch = (prev, next, { allowEmptyReplace = false } = {}) => {
  if (!Array.isArray(next)) return prev;
  if (!next.length && Array.isArray(prev) && prev.length && !allowEmptyReplace) return prev;
  return next;
};

export default function RangeMetricsPage() {
  const pendingRef = useRef(new Map());
  const symbolRef = useRef("BTCUSDT");
  const [mode, setMode] = useState("paper");
  const [realConfirmText, setRealConfirmText] = useState("");
  const [range, setRange] = useState(null);
  const [tradeState, setTradeState] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    symbolRef.current = range?.position?.symbol || range?.scan?.lastCandidate?.symbol || "BTCUSDT";
  }, [range]);

  const poll = async () => {
    const symbol = symbolRef.current;
    const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
    const [stateRes, posRes, ordRes, histRes] = await Promise.all([
      fetch(`${API_BASE}/api/trade/state`),
      fetch(`${API_BASE}/api/trade/positions${q}`),
      fetch(`${API_BASE}/api/trade/openOrders${q}`),
      fetch(`${API_BASE}/api/trade/history?limit=100`),
    ]);
    const state = await stateRes.json();
    const pos = await posRes.json();
    const ord = await ordRes.json();
    const hist = await histRes.json();
    setTradeState(state);
    setWarnings(pos.warnings || state.warnings || []);
    if (Array.isArray(pos.positions)) setPositions(cleanPositions(pos.positions));
    if (Array.isArray(ord.orders)) setOrders(ord.orders);
    if (Array.isArray(hist.history)) setHistory(cleanHistory(hist.history));
  };

  const onMessage = useMemo(() => (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const type = msg?.type === "event" ? msg.topic : msg.type;
    const payload = msg?.payload;

    if (type === "snapshot") {
      if (payload?.rangeState) setRange((prev) => mergeNonUndefined(prev, payload.rangeState));
      return;
    }
    if (type === "range.status" || type === "range.state") {
      if (!payload || typeof payload !== "object") return;
      setRange((prev) => {
        const merged = mergeNonUndefined(prev, payload);
        if (Array.isArray(payload.logs)) merged.logs = applyArrayPatch(prev?.logs, payload.logs, { allowEmptyReplace: payload?.clear === true });
        if (Array.isArray(payload.trades)) merged.trades = applyArrayPatch(prev?.trades, payload.trades, { allowEmptyReplace: payload?.clear === true });
        return merged;
      });
      return;
    }
    if (type === "range.log") {
      if (!payload) return;
      const queued = pendingRef.current.get("logs") || [];
      pendingRef.current.set("logs", [payload, ...queued].slice(0, 80));
      return;
    }
    if (type === "trade.positions") {
      if (Array.isArray(payload?.positions)) pendingRef.current.set("positions", cleanPositions(payload.positions));
      return;
    }
    if (type === "trade.orders") {
      if (Array.isArray(payload?.orders)) pendingRef.current.set("orders", payload.orders);
      return;
    }
    if (type === "trade.killswitch") {
      setTradeState((p) => mergeNonUndefined(p, { killSwitch: payload?.enabled }));
      return;
    }
    if (type === "range.start.ack" || type === "range.stop.ack") {
      if (payload?.state) setRange((prev) => mergeNonUndefined(prev, payload.state));
    }
  }, []);

  const { wsUrl, status: wsStatus, sendJson } = useWsClient({ onMessage, onOpen: () => sendJson({ type: "getRangeState" }) });

  useEffect(() => {
    const flushTimer = setInterval(() => {
      if (!pendingRef.current.size) return;
      const next = {};
      for (const [key, value] of pendingRef.current.entries()) next[key] = value;
      pendingRef.current.clear();
      if (Array.isArray(next.positions)) setPositions(next.positions);
      if (Array.isArray(next.orders)) setOrders(next.orders);
      if (Array.isArray(next.logs) && next.logs.length) {
        setRange((prev) => ({ ...(prev || {}), logs: [...next.logs, ...(prev?.logs || [])].slice(0, 300) }));
      }
    }, 350);

    const id = setInterval(() => {
      if (mode === "paper") return;
      poll().catch(() => {});
    }, 4000);

    return () => {
      clearInterval(flushTimer);
      clearInterval(id);
      pendingRef.current.clear();
    };
  }, [mode]);

  const start = () => {
    if (mode === "real" && realConfirmText !== "REAL") return;
    sendJson({ type: "startRangeTest", mode });
  };
  const stop = () => sendJson({ type: "stopRangeTest" });
  const realDisabled = tradeState?.tradeStatus && !tradeState.tradeStatus.realAllowed;
  const paperMode = mode === "paper" || tradeState?.tradeStatus?.executionMode === "paper";
  const candidate = range?.scan?.lastCandidate;
  const detailRows = Array.isArray(range?.trades) ? range.trades : [];
  const logs = Array.isArray(range?.logs) ? range.logs : [];
  const processLogs = logs.filter((l) => /scan|candidate|no entry|cooldown|wait|blocked/i.test(String(l?.msg || "")));

  return <Row className="g-3">
    <Col md={4}><Card><Card.Body className="d-grid gap-2">
      <div className="d-flex justify-content-between"><strong>Range (Metrics)</strong><Badge bg={wsStatus === "connected" ? "success" : "secondary"}>{wsStatus}</Badge></div>
      <Form.Select value={mode} onChange={(e) => setMode(e.target.value)}>
        <option value="paper">PAPER</option><option value="demo">DEMO</option><option value="real" disabled={realDisabled}>REAL</option>
      </Form.Select>
      {mode === "real" ? <Form.Control value={realConfirmText} onChange={(e) => setRealConfirmText(e.target.value)} placeholder="Type REAL" /> : null}
      {warnings.map((w, i) => <Alert key={i} variant={w.severity === "error" ? "danger" : "warning"} className="mb-0 py-2">{w.code}: {w.message}</Alert>)}
      <div className="d-flex gap-2"><Button onClick={start}>Start</Button><Button variant="outline-danger" onClick={stop}>Stop</Button></div>
      <div className="text-muted small">WS URL: {wsUrl}</div>
    </Card.Body></Card></Col>
    <Col md={8}><Card><Card.Body>
      {paperMode ? (
        <Tab.Container defaultActiveKey="summary"><Nav variant="tabs" className="mb-3">
          <Nav.Item><Nav.Link eventKey="summary">Кратко</Nav.Link></Nav.Item>
          <Nav.Item><Nav.Link eventKey="detail">Детально ({detailRows.length})</Nav.Link></Nav.Item>
          <Nav.Item><Nav.Link eventKey="logs">Логи ({logs.length})</Nav.Link></Nav.Item>
          <Nav.Item><Nav.Link eventKey="process">Process / Scanner ({processLogs.length})</Nav.Link></Nav.Item>
        </Nav><Tab.Content>
          <Tab.Pane eventKey="summary"><Table size="sm"><tbody>
            <tr><td>Status</td><td>{range?.status || "—"}</td></tr><tr><td>Started</td><td>{fmtTs(range?.startedAt)}</td></tr><tr><td>Uptime</td><td>{range?.status === "RUNNING" ? fmtUptime(range?.startedAt) : "—"}</td></tr>
            <tr><td>Candidate</td><td>{candidate?.symbol || "—"} ({candidate?.side || "—"})</td></tr>
            <tr><td>Range hi/lo/mid</td><td>{fmt(candidate?.rangeHigh)} / {fmt(candidate?.rangeLow)} / {fmt(candidate?.mid)}</td></tr>
                        <tr><td>Gates</td><td>{Array.isArray(candidate?.gates) && candidate.gates.length ? candidate.gates.map((g) => `${g.key || g.name}:${g.pass ? "ok" : "no"}`).join(", ") : "—"}</td></tr>
          </tbody></Table></Tab.Pane>
          <Tab.Pane eventKey="detail"><Table size="sm"><tbody>{detailRows.length ? detailRows.map((t, i) => <tr key={i}><td>{fmtTs(t.ts || t.t)}</td><td>{t.symbol}</td><td>{t.side}</td><td>{fmt(t.pnlUSDT, 4)}</td></tr>) : <tr><td className="text-muted">No trades yet</td></tr>}</tbody></Table></Tab.Pane>
          <Tab.Pane eventKey="logs"><div style={{ maxHeight: 360, overflow: "auto" }}><Table size="sm"><tbody>{logs.length ? logs.map((l, i) => <tr key={`${l.t || i}-${i}`}><td>{fmtTs(l.t)}</td><td>{l.level}</td><td>{l.msg}</td></tr>) : <tr><td className="text-muted">No logs yet</td></tr>}</tbody></Table></div></Tab.Pane>
          <Tab.Pane eventKey="process"><div style={{ maxHeight: 360, overflow: "auto" }}><Table size="sm"><tbody>{processLogs.length ? processLogs.map((l, i) => <tr key={`${l.t || i}-${i}`}><td>{fmtTs(l.t)}</td><td>{l.level}</td><td>{l.msg}</td></tr>) : <tr><td className="text-muted">No scanner logs yet</td></tr>}</tbody></Table></div></Tab.Pane>
        </Tab.Content></Tab.Container>
      ) : (
        <Tab.Container defaultActiveKey="orders"><Nav variant="tabs" className="mb-3">
          <Nav.Item><Nav.Link eventKey="orders">Orders ({orders.length})</Nav.Link></Nav.Item>
          <Nav.Item><Nav.Link eventKey="positions">Positions ({positions.length})</Nav.Link></Nav.Item>
          <Nav.Item><Nav.Link eventKey="history">History ({history.length})</Nav.Link></Nav.Item>
        </Nav><Tab.Content>
          <Tab.Pane eventKey="orders"><Table size="sm"><tbody>{orders.length ? orders.map((r) => <tr key={r.orderId}><td>{r.symbol}</td><td>{r.side}</td><td>{fmt(r.qty, 4)}</td><td>{fmt(r.price)}</td></tr>) : <tr><td className="text-muted">No open orders</td></tr>}</tbody></Table></Tab.Pane>
          <Tab.Pane eventKey="positions"><Table size="sm"><tbody>{positions.length ? positions.map((r, i) => <tr key={i}><td>{r.symbol}</td><td>{r.side}</td><td>{fmt(r.size, 4)}</td><td>{fmt(r.avgPrice)}</td><td>{r.positionIdx}</td></tr>) : <tr><td className="text-muted">No positions</td></tr>}</tbody></Table></Tab.Pane>
          <Tab.Pane eventKey="history"><Table size="sm"><tbody>{history.length ? history.map((r, i) => <tr key={i}><td>{r.symbol}</td><td>{fmt(r.closedPnl, 4)}</td></tr>) : <tr><td className="text-muted">No history yet</td></tr>}</tbody></Table></Tab.Pane>
        </Tab.Content></Tab.Container>
      )}
    </Card.Body></Card></Col>
  </Row>;
}
