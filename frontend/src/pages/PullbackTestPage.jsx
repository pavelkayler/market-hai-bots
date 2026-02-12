import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Col, Form, Nav, Row, Tab, Table } from "react-bootstrap";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";

function toWsUrl(apiBase) {
  try {
    const u = new URL(apiBase);
    const proto = u.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${u.host}/ws`;
  } catch {
    return "ws://localhost:8080/ws";
  }
}

const fmtNum = (x, d = 6) => (Number.isFinite(Number(x)) ? Number(x).toFixed(d) : "—");
const fmtTs = (ts) => (Number.isFinite(Number(ts)) ? new Date(Number(ts)).toLocaleTimeString() : "—");
const modeBadge = (m) => (m === "real" ? "danger" : m === "demo" ? "warning" : "secondary");

export default function PullbackTestPage() {
  const wsRef = useRef(null);
  const shouldCloseRef = useRef(false);
  const ackTimerRef = useRef(null);
  const [wsStatus, setWsStatus] = useState("connecting");
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

  const wsUrl = useMemo(() => toWsUrl(API_BASE), []);
  const symbol = pb?.position?.symbol || pb?.scan?.lastCandidate?.symbol || "BTCUSDT";

  const showAck = (variant, text) => {
    setAck({ variant, text });
    if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    ackTimerRef.current = setTimeout(() => setAck(null), 2500);
  };

  const pollTrade = async () => {
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
    setPositions(pos.positions || []);
    setOrders(ord.orders || []);
    setHistory(hist.history || []);
  };

  useEffect(() => {
    let stopped = false;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus("connected");
      if (shouldCloseRef.current) ws.close();
    };
    ws.onclose = () => setWsStatus("disconnected");
    ws.onerror = () => setWsStatus("error");
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const type = msg?.type === "event" ? msg.topic : msg.type;
      const payload = msg?.type === "event" ? msg.payload : msg.payload;
      if (type === "snapshot") {
        setPb(payload?.pullbackState || null);
        setTradeStatus(payload?.tradeStatus || null);
        setWarnings(payload?.warnings || []);
      }
      if (type === "pullback.status" || type === "pullback.state") {
        setPb(payload || null);
      }
      if (type === "trade.positions") setPositions(payload?.positions || []);
      if (type === "trade.orders") setOrders(payload?.orders || []);
      if (type === "trade.killswitch") setTradeState((p) => ({ ...(p || {}), killSwitch: payload?.enabled }));
      if (type === "pullback.start.ack") showAck(payload?.ok ? "success" : "danger", payload?.ok ? "Тест запущен" : (payload?.error || "Start failed"));
      if (type === "pullback.stop.ack") showAck(payload?.ok ? "success" : "danger", payload?.ok ? "Тест остановлен" : (payload?.error || "Stop failed"));
    };

    const id = setInterval(() => { if (!stopped) pollTrade().catch(() => {}); }, 4000);
    return () => {
      stopped = true;
      clearInterval(id);
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      shouldCloseRef.current = true;
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };
  }, [wsUrl, symbol]);

  const start = () => {
    if (mode === "real" && realConfirmText !== "REAL") return showAck("warning", "Введите REAL для подтверждения.");
    wsRef.current?.send(JSON.stringify({ type: "startPullbackTest", mode }));
  };
  const stop = () => wsRef.current?.send(JSON.stringify({ type: "stopPullbackTest" }));

  const setKillSwitch = async (enabled) => {
    const res = await fetch(`${API_BASE}/api/trade/killswitch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
    const data = await res.json();
    setTradeState((p) => ({ ...(p || {}), killSwitch: data.enabled }));
  };

  const realDisabled = tradeStatus && !tradeStatus.realAllowed;
  const status = pb?.status || "STOPPED";

  return <Row className="g-3">
    <Col md={4}><Card><Card.Body className="d-grid gap-2">
      <div className="d-flex justify-content-between"><strong>Pullback</strong><Badge bg={wsStatus === "connected" ? "success" : "secondary"}>{wsStatus}</Badge></div>
      <div className="d-flex justify-content-between"><span>Status</span><Badge bg={status === "RUNNING" ? "success" : "secondary"}>{status}</Badge></div>
      <div className="d-flex justify-content-between"><span>Execution</span><Badge bg={modeBadge(mode)}>{mode.toUpperCase()}</Badge></div>
      <Form.Select value={mode} onChange={(e) => setMode(e.target.value)}>
        <option value="paper">PAPER</option><option value="demo">DEMO</option><option value="real" disabled={realDisabled}>REAL</option>
      </Form.Select>
      {mode === "real" ? <Form.Control value={realConfirmText} onChange={(e) => setRealConfirmText(e.target.value)} placeholder="Type REAL to confirm" /> : null}
      {warnings.map((w, i) => <Alert key={i} variant={w.severity === "error" ? "danger" : "warning"} className="py-2 mb-0">{w.code}: {w.message}</Alert>)}
      {ack ? <Alert variant={ack.variant} className="mb-0 py-2">{ack.text}</Alert> : null}
      <div className="d-flex gap-2"><Button onClick={start}>Start</Button><Button variant="outline-danger" onClick={stop}>Stop</Button></div>
      <Button variant={tradeState?.killSwitch ? "danger" : "outline-danger"} onClick={() => setKillSwitch(!tradeState?.killSwitch)}>{tradeState?.killSwitch ? "Kill-switch ON" : "Kill-switch OFF"}</Button>
    </Card.Body></Card></Col>
    <Col md={8}>
      <Card><Card.Body>
        <Tab.Container defaultActiveKey="orders"><Nav variant="tabs" className="mb-3">
          <Nav.Item><Nav.Link eventKey="orders">Orders ({orders.length})</Nav.Link></Nav.Item>
          <Nav.Item><Nav.Link eventKey="positions">Positions ({positions.length})</Nav.Link></Nav.Item>
          <Nav.Item><Nav.Link eventKey="history">History ({history.length})</Nav.Link></Nav.Item>
        </Nav><Tab.Content>
          <Tab.Pane eventKey="orders"><Table size="sm"><tbody>{orders.length ? orders.map((r)=><tr key={r.orderId}><td>{r.symbol}</td><td>{r.side}</td><td>{fmtNum(r.qty,4)}</td><td>{fmtNum(r.price)}</td></tr>) : <tr><td className="text-muted">No open orders</td></tr>}</tbody></Table></Tab.Pane>
          <Tab.Pane eventKey="positions"><Table size="sm"><tbody>{positions.length ? positions.map((r,i)=><tr key={`${r.symbol}-${i}`}><td>{r.symbol}</td><td>{r.side}</td><td>{fmtNum(r.size,4)}</td><td>{fmtNum(r.avgPrice)}</td></tr>) : <tr><td className="text-muted">No positions</td></tr>}</tbody></Table></Tab.Pane>
          <Tab.Pane eventKey="history"><Table size="sm"><tbody>{history.length ? history.map((r,i)=><tr key={i}><td>{fmtTs(r.updatedTime || r.createdTime)}</td><td>{r.symbol}</td><td>{fmtNum(r.closedPnl,4)}</td></tr>) : <tr><td className="text-muted">No history</td></tr>}</tbody></Table></Tab.Pane>
        </Tab.Content></Tab.Container>
      </Card.Body></Card>
    </Col>
  </Row>;
}
