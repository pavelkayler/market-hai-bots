import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Col, Form, Nav, Row, Tab, Table } from "react-bootstrap";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";
const toWsUrl = (apiBase) => { try { const u = new URL(apiBase); return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}/ws`; } catch { return "ws://localhost:8080/ws"; } };
const fmt = (x, d = 6) => (Number.isFinite(Number(x)) ? Number(x).toFixed(d) : "—");

export default function RangeMetricsPage() {
  const wsRef = useRef(null);
  const [wsStatus, setWsStatus] = useState("connecting");
  const [mode, setMode] = useState("paper");
  const [realConfirmText, setRealConfirmText] = useState("");
  const [range, setRange] = useState(null);
  const [tradeState, setTradeState] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [history, setHistory] = useState([]);
  const [logs, setLogs] = useState([]);
  const [detectedMode, setDetectedMode] = useState("—");
  const wsUrl = useMemo(() => toWsUrl(API_BASE), []);
  const symbol = range?.position?.symbol || range?.scan?.lastCandidate?.symbol || "BTCUSDT";

  const poll = async () => {
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
    setWarnings(pos.warnings || []);
    setPositions(pos.positions || []);
    setOrders(ord.orders || []);
    setHistory(hist.history || []);
    const idx = new Set((pos.positions || []).map((x) => Number(x.positionIdx)));
    setDetectedMode(idx.has(1) || idx.has(2) ? "HEDGE" : "ONE_WAY");
  };

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    ws.onopen = () => setWsStatus("connected");
    ws.onclose = () => setWsStatus("disconnected");
    ws.onerror = () => setWsStatus("error");
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      const type = msg?.type === "event" ? msg.topic : msg.type;
      const payload = msg?.type === "event" ? msg.payload : msg.payload;
      if (type === "snapshot") { setRange(payload?.rangeState || null); setLogs(payload?.rangeState?.logs || []); }
      if (type === "range.status" || type === "range.state") { setRange(payload || null); setLogs(payload?.logs || []); }
      if (type === "trade.positions") setPositions(payload?.positions || []);
      if (type === "trade.orders") setOrders(payload?.orders || []);
      if (type === "range.log") setLogs((p) => [payload, ...p].slice(0, 200));
    };
    const id = setInterval(() => poll().catch(() => {}), 4000);
    return () => { clearInterval(id); if (ws.readyState === WebSocket.OPEN) ws.close(); };
  }, [wsUrl, symbol]);

  const start = () => {
    if (mode === "real" && realConfirmText !== "REAL") return;
    wsRef.current?.send(JSON.stringify({ type: "startRangeTest", mode }));
  };
  const stop = () => wsRef.current?.send(JSON.stringify({ type: "stopRangeTest" }));
  const realDisabled = tradeState?.tradeStatus && !tradeState.tradeStatus.realAllowed;
  const has10001 = logs.some((l) => String(l?.msg || "").includes("10001"));

  return <Row className="g-3">
    <Col md={4}><Card><Card.Body className="d-grid gap-2">
      <div className="d-flex justify-content-between"><strong>Range (Hedge)</strong><Badge bg={wsStatus === "connected" ? "success" : "secondary"}>{wsStatus}</Badge></div>
      <Form.Select value={mode} onChange={(e) => setMode(e.target.value)}>
        <option value="paper">PAPER</option><option value="demo">DEMO</option><option value="real" disabled={realDisabled}>REAL</option>
      </Form.Select>
      {mode === "real" ? <Form.Control value={realConfirmText} onChange={(e) => setRealConfirmText(e.target.value)} placeholder="Type REAL" /> : null}
      <div>Detected position mode: <Badge bg={detectedMode === "HEDGE" ? "info" : "secondary"}>{detectedMode}</Badge></div>
      {has10001 ? <Alert variant="warning" className="mb-0 py-2">Your account is in HEDGE mode; use positionIdx=1/2 for LONG/SHORT.</Alert> : null}
      {warnings.map((w, i) => <Alert key={i} variant={w.severity === "error" ? "danger" : "warning"} className="mb-0 py-2">{w.code}: {w.message}</Alert>)}
      <div className="d-flex gap-2"><Button onClick={start}>Start</Button><Button variant="outline-danger" onClick={stop}>Stop</Button></div>
    </Card.Body></Card></Col>
    <Col md={8}><Card><Card.Body>
      <Tab.Container defaultActiveKey="orders"><Nav variant="tabs" className="mb-3">
        <Nav.Item><Nav.Link eventKey="orders">Orders ({orders.length})</Nav.Link></Nav.Item>
        <Nav.Item><Nav.Link eventKey="positions">Positions ({positions.length})</Nav.Link></Nav.Item>
        <Nav.Item><Nav.Link eventKey="history">History ({history.length})</Nav.Link></Nav.Item>
      </Nav><Tab.Content>
        <Tab.Pane eventKey="orders"><Table size="sm"><tbody>{orders.length ? orders.map((r)=><tr key={r.orderId}><td>{r.symbol}</td><td>{r.side}</td><td>{fmt(r.qty,4)}</td><td>{fmt(r.price)}</td></tr>) : <tr><td className="text-muted">No open orders</td></tr>}</tbody></Table></Tab.Pane>
        <Tab.Pane eventKey="positions"><Table size="sm"><tbody>{positions.length ? positions.map((r,i)=><tr key={i}><td>{r.symbol}</td><td>{r.side}</td><td>{fmt(r.size,4)}</td><td>{fmt(r.avgPrice)}</td><td>{r.positionIdx}</td></tr>) : <tr><td className="text-muted">No positions</td></tr>}</tbody></Table></Tab.Pane>
        <Tab.Pane eventKey="history"><Table size="sm"><tbody>{history.length ? history.map((r,i)=><tr key={i}><td>{r.symbol}</td><td>{fmt(r.closedPnl,4)}</td></tr>) : <tr><td className="text-muted">No history</td></tr>}</tbody></Table></Tab.Pane>
      </Tab.Content></Tab.Container>
    </Card.Body></Card></Col>
  </Row>;
}
