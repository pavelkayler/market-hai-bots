import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Col, Form, Row, Table } from "react-bootstrap";

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

function wsBadgeVariant(status) {
  if (status === "connected") return "success";
  if (status === "connecting") return "warning";
  if (status === "error") return "danger";
  return "secondary";
}

export default function PullbackTestPage() {
  const wsRef = useRef(null);
  const ackTimerRef = useRef(null);

  const [wsStatus, setWsStatus] = useState("disconnected");
  const [mode, setMode] = useState("paper");
  const [pb, setPb] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [tradeStatus, setTradeStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [trades, setTrades] = useState([]);
  const [ack, setAck] = useState(null);
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);

  const wsUrl = useMemo(() => toWsUrl(API_BASE), []);

  const showAck = (variant, text) => {
    setAck({ variant, text });
    if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    ackTimerRef.current = setTimeout(() => setAck(null), 2000);
  };

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setWsStatus("connecting");

    ws.onopen = () => setWsStatus("connected");
    ws.onclose = () => setWsStatus("disconnected");
    ws.onerror = () => setWsStatus("error");

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === "snapshot") {
        setPb(msg.payload?.pullbackState || null);
        setWarnings(msg.payload?.warnings || []);
        setTradeStatus(msg.payload?.tradeStatus || null);
        setLogs(msg.payload?.pullbackState?.logs || []);
        setTrades([...(msg.payload?.pullbackState?.trades || [])].reverse());
        setPositions(msg.payload?.tradePositions || []);
        setOrders(msg.payload?.tradeOrders || []);
      }

      if (msg.type === "pullback.status" || msg.type === "pullback.state") {
        setPb(msg.payload || null);
        setLogs(msg.payload?.logs || []);
        setTrades([...(msg.payload?.trades || [])].reverse());
      }

      if (msg.type === "pullback.start.ack") {
        if (msg.payload?.ok) showAck("success", "Тест запущен");
        else showAck("danger", msg.payload?.error || "Start failed");
      }

      if (msg.type === "pullback.stop.ack") {
        if (msg.payload?.ok) showAck("success", "Тест остановлен");
        else showAck("danger", msg.payload?.error || "Stop failed");
      }

      if (msg.type === "pullback.log") setLogs((prev) => [msg.payload, ...prev].slice(0, 300));
      if (msg.type === "pullback.trade") setTrades((prev) => [msg.payload, ...prev].slice(0, 200));
    };

    return () => {
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      ws.close();
    };
  }, [wsUrl]);

  const start = () => wsRef.current?.send(JSON.stringify({ type: "startPullbackTest", mode }));
  const stop = () => wsRef.current?.send(JSON.stringify({ type: "stopPullbackTest" }));
  const refresh = () => wsRef.current?.send(JSON.stringify({ type: "getPullbackState" }));



  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const symbol = pb?.position?.symbol || pb?.scan?.lastCandidate?.symbol || "";
        const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
        const res = await fetch(`${API_BASE}/api/trade/positions${q}`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setPositions(data.positions || []);
        setOrders(data.orders || []);
        setTradeStatus(data.tradeStatus || null);
        setWarnings(data.warnings || []);
      } catch (e) {
        console.debug(e);
      }
    };
    const id = setInterval(poll, 3000);
    poll();
    return () => { cancelled = true; clearInterval(id); };
  }, [pb?.position?.symbol, pb?.scan?.lastCandidate?.symbol]);

  const wsConnected = wsStatus === "connected";
  const status = pb?.status || "STOPPED";
  const startDisabled = !wsConnected || status === "RUNNING" || status === "STARTING";
  const stopDisabled = !wsConnected || status === "STOPPED" || status === "STOPPING";

  return <Row className="g-3">
    <Col md={4}>
      <Card><Card.Body className="d-grid gap-2">
        <div className="d-flex justify-content-between"><strong>Pullback</strong><Badge bg={wsBadgeVariant(wsStatus)}>{wsStatus}</Badge></div>
        <div className="d-flex justify-content-between"><span>Status</span><Badge bg={pb?.status === "RUNNING" ? "success" : pb?.status === "STARTING" || pb?.status === "STOPPING" ? "warning" : "secondary"}>{status}</Badge></div>
        <Form.Select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="paper">paper</option>
          <option value="demo">demo</option>
        </Form.Select>
        {mode === "demo" && !tradeStatus?.enabled ? <Alert variant="danger" className="mb-0 py-2">Demo disabled: missing BYBIT keys.</Alert> : null}
        <div className="small">trade: {tradeStatus?.enabled ? "enabled" : "disabled"} | base: {tradeStatus?.baseUrl || "—"}</div>
        {(warnings || []).map((w, i) => <Alert key={i} variant={w.severity === "error" ? "danger" : "warning"} className="mb-0 py-2">{w.code}: {w.message}</Alert>)}
        {ack ? <Alert variant={ack.variant} className="mb-0 py-2">{ack.text}</Alert> : null}
        <div className="d-flex gap-2">
          <Button onClick={start} disabled={startDisabled}>Start</Button>
          <Button variant="outline-danger" onClick={stop} disabled={stopDisabled}>Stop</Button>
          <Button variant="outline-secondary" onClick={refresh} disabled={!wsConnected}>Refresh</Button>
        </div>
      </Card.Body></Card>
    </Col>
    <Col md={8}>
      <Card className="mb-3"><Card.Body>
        <strong>Summary</strong>
        <div className="small mb-2">context={pb?.scan?.lastCandidate?.trend || "—"} level={fmtNum(pb?.scan?.lastCandidate?.level)} status={pb?.position ? "IN_TRADE" : status === "RUNNING" ? (pb?.scan?.lastCandidate?.trigger ? "ARMED" : "SEARCHING") : status}</div>
        <strong>Trades</strong>
        <Table size="sm"><thead><tr><th style={{ width: "24%" }}>t</th><th>sym</th><th>side</th><th className="text-end" style={{ width: "20%" }}>price</th><th className="text-end" style={{ width: "20%" }}>pnl</th></tr></thead><tbody>
          {trades.slice(0, 50).map((t, i) => <tr key={i}><td>{fmtTs(t.tClose || t.t)}</td><td>{t.symbol}</td><td>{t.side}</td><td className="text-end font-monospace">{fmtNum(t.price || t.entryPrice)}</td><td className="text-end font-monospace">{fmtNum(t.pnlUSDT, 4)}</td></tr>)}
        </tbody></Table>
      </Card.Body></Card>

      <Card className="mb-3"><Card.Body>
        <strong>Positions</strong>
        <Table size="sm"><thead><tr><th>Symbol</th><th>Side</th><th className="text-end">Size</th><th className="text-end">Avg</th></tr></thead><tbody>
          {positions.slice(0, 20).map((r, i) => <tr key={i}><td>{r.symbol}</td><td>{r.side}</td><td className="text-end font-monospace">{fmtNum(r.size,4)}</td><td className="text-end font-monospace">{fmtNum(r.avgPrice)}</td></tr>)}
        </tbody></Table>
        <strong>Open orders</strong>
        <Table size="sm"><thead><tr><th>ID</th><th>Side</th><th className="text-end">Qty</th><th className="text-end">Price</th></tr></thead><tbody>
          {orders.slice(0, 20).map((r, i) => <tr key={i}><td>{r.orderId?.slice(0,10) || "—"}</td><td>{r.side}</td><td className="text-end font-monospace">{fmtNum(r.qty,4)}</td><td className="text-end font-monospace">{fmtNum(r.price)}</td></tr>)}
        </tbody></Table>
      </Card.Body></Card>
      <Card><Card.Body>
        <div className="d-flex justify-content-between align-items-center mb-2"><strong>Logs (newest first)</strong><span className="text-muted">{logs.length}</span></div>
        <div style={{ minHeight: 220, maxHeight: 420, overflow: "auto", resize: "vertical", border: "1px solid #e5e7eb", borderRadius: 6, padding: 8, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace", fontSize: 12 }}>
          {logs.map((l, i) => <div key={i}>[{fmtTs(l.ts || l.t)}] {l.msg || "—"}</div>)}
        </div>
      </Card.Body></Card>
    </Col>
  </Row>;
}
