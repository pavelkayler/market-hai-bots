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

const fmtNum = (x, d = 6) => (Number.isFinite(Number(x)) ? Number(x).toFixed(d) : "—");
const fmtTs = (ts) => (Number.isFinite(Number(ts)) ? new Date(Number(ts)).toLocaleTimeString() : "—");
const modeBadge = (m) => (m === "real" ? "danger" : m === "demo" ? "warning" : "secondary");
const applyArrayPatch = (prev, next, { allowEmptyReplace = false } = {}) => {
  if (!Array.isArray(next)) return prev;
  if (!next.length && Array.isArray(prev) && prev.length && !allowEmptyReplace) return prev;
  return next;
};

export default function PullbackPage() {
  const ackTimerRef = useRef(null);
  const pendingRef = useRef(new Map());
  const symbolRef = useRef("BTCUSDT");

  const [mode, setMode] = useState("paper");
  const [realConfirmText, setRealConfirmText] = useState("");
  const [pb, setPb] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [tradeStatus, setTradeStatus] = useState(null);
  const [tradeState, setTradeState] = useState(null);
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [history, setHistory] = useState([]);
  const [ack, setAck] = useState(null);

  useEffect(() => {
    symbolRef.current = pb?.position?.symbol || pb?.scan?.lastCandidate?.symbol || "BTCUSDT";
  }, [pb]);

  const showAck = (variant, text) => {
    setAck({ variant, text });
    if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    ackTimerRef.current = setTimeout(() => setAck(null), 2500);
  };

  const pollTrade = async () => {
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
    setTradeStatus(pos.tradeStatus || state.tradeStatus || null);
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
      if (payload?.pullbackState) setPb((prev) => mergeNonUndefined(prev, payload.pullbackState));
      setTradeStatus(payload?.tradeStatus || null);
      setWarnings(payload?.warnings || []);
      return;
    }

    if (type === "pullback.status" || type === "pullback.state") {
      if (!payload || typeof payload !== "object") return;
      setPb((prev) => {
        const merged = mergeNonUndefined(prev, payload);
        if (Array.isArray(payload.logs)) merged.logs = applyArrayPatch(prev?.logs, payload.logs, { allowEmptyReplace: payload?.clear === true });
        if (Array.isArray(payload.trades)) merged.trades = applyArrayPatch(prev?.trades, payload.trades, { allowEmptyReplace: payload?.clear === true });
        return merged;
      });
      return;
    }

    if (type === "pullback.log") {
      if (!payload) return;
      const queued = pendingRef.current.get("logs") || [];
      pendingRef.current.set("logs", [payload, ...queued].slice(0, 60));
      return;
    }

    if (type === "trade.positions") {
      if (Array.isArray(payload?.positions)) pendingRef.current.set("positions", cleanPositions(payload.positions));
      pendingRef.current.set("tradeStatus", payload?.tradeStatus || null);
      pendingRef.current.set("warnings", payload?.warnings || []);
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

    if (type === "pullback.start.ack") {
      if (payload?.state) setPb((prev) => mergeNonUndefined(prev, payload.state));
      showAck(payload?.ok ? "success" : "danger", payload?.ok ? "Тест запущен" : (payload?.error || "Start failed"));
      return;
    }
    if (type === "pullback.stop.ack") {
      if (payload?.state) setPb((prev) => mergeNonUndefined(prev, payload.state));
      showAck(payload?.ok ? "success" : "danger", payload?.ok ? "Тест остановлен" : (payload?.error || "Stop failed"));
    }
  }, []);

  const { wsUrl, status: wsStatus, sendJson } = useWsClient({ onMessage, onOpen: () => sendJson({ type: "getPullbackState" }) });

  useEffect(() => {
    const flushTimer = setInterval(() => {
      if (!pendingRef.current.size) return;
      const next = {};
      for (const [key, value] of pendingRef.current.entries()) next[key] = value;
      pendingRef.current.clear();

      if (next.pb !== undefined) setPb(next.pb);
      if (Array.isArray(next.positions)) setPositions(next.positions);
      if (Array.isArray(next.orders)) setOrders(next.orders);
      if (next.warnings !== undefined) setWarnings(next.warnings || []);
      if (next.tradeStatus !== undefined) setTradeStatus(next.tradeStatus || null);
      if (Array.isArray(next.logs) && next.logs.length) {
        setPb((prev) => ({ ...(prev || {}), logs: [...next.logs, ...(prev?.logs || [])].slice(0, 300) }));
      }
    }, 350);

    const id = setInterval(() => {
      if (mode === "paper") return;
      pollTrade().catch(() => {});
    }, 4000);

    return () => {
      clearInterval(id);
      clearInterval(flushTimer);
      pendingRef.current.clear();
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    };
  }, [mode]);

  const start = () => {
    if (mode === "real" && realConfirmText !== "REAL") return showAck("warning", "Введите REAL для подтверждения.");
    sendJson({ type: "startPullbackTest", mode });
  };
  const stop = () => sendJson({ type: "stopPullbackTest" });

  const setKillSwitch = async (enabled) => {
    const res = await fetch(`${API_BASE}/api/trade/killswitch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
    const data = await res.json();
    setTradeState((p) => mergeNonUndefined(p, { killSwitch: data.enabled }));
  };

  const realDisabled = tradeStatus && !tradeStatus.realAllowed;
  const status = pb?.status || "STOPPED";
  const paperMode = mode === "paper" || tradeStatus?.executionMode === "paper";
  const detailRows = Array.isArray(pb?.trades) ? pb.trades : [];
  const logs = Array.isArray(pb?.logs) ? pb.logs : [];
  const processLogs = logs.filter((l) => /scan|candidate|no entry|cooldown|wait/i.test(String(l?.msg || "")));

  return <Row className="g-3">
    <Col md={4}><Card><Card.Body className="d-grid gap-2">
      <div className="d-flex justify-content-between"><strong>Pullback</strong><Badge bg={wsStatus === "connected" ? "success" : "secondary"}>{wsStatus}</Badge></div>
      <div className="d-flex justify-content-between"><span>Status</span><Badge bg={status === "RUNNING" ? "success" : "secondary"}>{status}</Badge></div>
      <div className="d-flex justify-content-between"><span>Execution</span><Badge bg={modeBadge(mode)}>{mode.toUpperCase()}</Badge></div>
      <Form.Select value={mode} onChange={(e) => setMode(e.target.value)}><option value="paper">PAPER</option><option value="demo">DEMO</option><option value="real" disabled={realDisabled}>REAL</option></Form.Select>
      {mode === "real" ? <Form.Control value={realConfirmText} onChange={(e) => setRealConfirmText(e.target.value)} placeholder="Type REAL to confirm" /> : null}
      {warnings.map((w, i) => <Alert key={i} variant={w.severity === "error" ? "danger" : "warning"} className="py-2 mb-0">{w.code}: {w.message}</Alert>)}
      {ack ? <Alert variant={ack.variant} className="mb-0 py-2">{ack.text}</Alert> : null}
      <div className="d-flex gap-2"><Button onClick={start}>Start</Button><Button variant="outline-danger" onClick={stop}>Stop</Button></div>
      {!paperMode && mode !== "real" ? <Button variant={tradeState?.killSwitch ? "danger" : "outline-danger"} onClick={() => setKillSwitch(!tradeState?.killSwitch)}>{tradeState?.killSwitch ? "Kill-switch ON" : "Kill-switch OFF"}</Button> : null}
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
          <Tab.Pane eventKey="summary"><div><strong>Strategy summary</strong><div className="text-muted">Started: {fmtTs(pb?.startedAt)} | Last scan: {fmtTs(pb?.scan?.lastScanAt)}</div></div>
            <Table size="sm" className="mb-0"><tbody>
              <tr><td>Status</td><td>{pb?.status || "—"}</td></tr><tr><td>Candidate</td><td>{pb?.scan?.lastCandidate?.symbol || "—"} ({pb?.scan?.lastCandidate?.side || "—"})</td></tr>
              <tr><td>Reason</td><td>{pb?.scan?.lastCandidate?.reason || "—"}</td></tr><tr><td>Trades</td><td>{pb?.stats?.trades ?? 0}</td></tr>
            </tbody></Table></Tab.Pane>
          <Tab.Pane eventKey="detail"><Table size="sm"><tbody>{detailRows.length ? detailRows.map((t, i) => <tr key={i}><td>{fmtTs(t.ts || t.t)}</td><td>{t.symbol}</td><td>{t.side}</td><td>{fmtNum(t.pnlUSDT, 4)}</td></tr>) : <tr><td className="text-muted">No trades yet</td></tr>}</tbody></Table></Tab.Pane>
          <Tab.Pane eventKey="logs"><div style={{ maxHeight: 360, overflow: "auto" }}><Table size="sm"><tbody>{logs.length ? logs.map((l, i) => <tr key={`${l.t || i}-${i}`}><td>{fmtTs(l.t)}</td><td>{l.level}</td><td>{l.msg}</td></tr>) : <tr><td className="text-muted">No logs yet</td></tr>}</tbody></Table></div></Tab.Pane>
          <Tab.Pane eventKey="process"><div style={{ maxHeight: 360, overflow: "auto" }}><Table size="sm"><tbody>{processLogs.length ? processLogs.map((l, i) => <tr key={`${l.t || i}-${i}`}><td>{fmtTs(l.t)}</td><td>{l.level}</td><td>{l.msg}</td></tr>) : <tr><td className="text-muted">No scanner logs yet</td></tr>}</tbody></Table></div></Tab.Pane>
        </Tab.Content></Tab.Container>
      ) : (
        <Tab.Container defaultActiveKey="orders"><Nav variant="tabs" className="mb-3">
          <Nav.Item><Nav.Link eventKey="orders">Orders ({orders.length})</Nav.Link></Nav.Item>
          <Nav.Item><Nav.Link eventKey="positions">Positions ({positions.length})</Nav.Link></Nav.Item>
          <Nav.Item><Nav.Link eventKey="history">History ({history.length})</Nav.Link></Nav.Item>
        </Nav><Tab.Content>
          <Tab.Pane eventKey="orders"><Table size="sm"><tbody>{orders.length ? orders.map((r) => <tr key={r.orderId}><td>{r.symbol}</td><td>{r.side}</td><td>{fmtNum(r.qty, 4)}</td><td>{fmtNum(r.price)}</td></tr>) : <tr><td className="text-muted">No open orders</td></tr>}</tbody></Table></Tab.Pane>
          <Tab.Pane eventKey="positions"><Table size="sm"><tbody>{positions.length ? positions.map((r, i) => <tr key={`${r.symbol}-${i}`}><td>{r.symbol}</td><td>{r.side}</td><td>{fmtNum(r.size, 4)}</td><td>{fmtNum(r.avgPrice)}</td></tr>) : <tr><td className="text-muted">No positions</td></tr>}</tbody></Table></Tab.Pane>
          <Tab.Pane eventKey="history"><Table size="sm"><tbody>{history.length ? history.map((r, i) => <tr key={i}><td>{fmtTs(r.updatedTime || r.createdTime)}</td><td>{r.symbol}</td><td>{fmtNum(r.closedPnl, 4)}</td></tr>) : <tr><td className="text-muted">No history</td></tr>}</tbody></Table></Tab.Pane>
        </Tab.Content></Tab.Container>
      )}
    </Card.Body></Card></Col>
  </Row>;
}
