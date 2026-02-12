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

const fmt = (x, d = 6) => (Number.isFinite(Number(x)) ? Number(x).toFixed(d) : "—");
const fmtTs = (ts) => (Number.isFinite(Number(ts)) ? new Date(Number(ts)).toLocaleTimeString() : "—");

function wsBadgeVariant(status) {
  if (status === "connected") return "success";
  if (status === "connecting") return "warning";
  if (status === "error") return "danger";
  return "secondary";
}

export default function RangeMetricsPage() {
  const wsRef = useRef(null);
  const ackTimerRef = useRef(null);

  const [wsStatus, setWsStatus] = useState("disconnected");
  const [mode, setMode] = useState("paper");
  const [range, setRange] = useState(null);
  const [tradeStatus, setTradeStatus] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [gates, setGates] = useState([]);
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
        setRange(msg.payload?.rangeState || null);
        setWarnings(msg.payload?.warnings || []);
        setTradeStatus(msg.payload?.tradeStatus || null);
        setLogs(msg.payload?.rangeState?.logs || []);
        setTrades([...(msg.payload?.rangeState?.trades || [])].reverse());
        setPositions(msg.payload?.tradePositions || []);
        setOrders(msg.payload?.tradeOrders || []);
      }

      if (msg.type === "range.status" || msg.type === "range.state") {
        setRange(msg.payload || null);
        setLogs(msg.payload?.logs || []);
        setTrades([...(msg.payload?.trades || [])].reverse());
      }

      if (msg.type === "range.start.ack") {
        if (msg.payload?.ok) showAck("success", "Тест запущен");
        else showAck("danger", msg.payload?.error || "Start failed");
      }

      if (msg.type === "range.stop.ack") {
        if (msg.payload?.ok) showAck("success", "Тест остановлен");
        else showAck("danger", msg.payload?.error || "Stop failed");
      }

      if (msg.type === "range.log") setLogs((p) => [msg.payload, ...p].slice(0, 300));
      if (msg.type === "range.trade") setTrades((p) => [msg.payload, ...p].slice(0, 200));
      if (msg.type === "range.gates") setGates(msg.payload || []);
    };

    return () => {
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      ws.close();
    };
  }, [wsUrl]);

  const start = () => wsRef.current?.send(JSON.stringify({ type: "startRangeTest", mode }));
  const stop = () => wsRef.current?.send(JSON.stringify({ type: "stopRangeTest" }));
  const refresh = () => wsRef.current?.send(JSON.stringify({ type: "getRangeState" }));



  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const symbol = range?.position?.symbol || range?.scan?.lastCandidate?.symbol || "";
        const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
        const res = await fetch(`${API_BASE}/api/trade/orders${q}`);
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
  }, [range?.position?.symbol, range?.scan?.lastCandidate?.symbol]);

  const status = range?.status || "STOPPED";
  const wsConnected = wsStatus === "connected";
  const startDisabled = !wsConnected || ["RUNNING", "STARTING"].includes(status);
  const stopDisabled = !wsConnected || ["STOPPED", "STOPPING"].includes(status);
  const topFails = gates.filter((g) => !g.pass).slice(0, 3).map((g) => g.name);

  return <Row className="g-3">
    <Col md={4}><Card><Card.Body className="d-grid gap-2">
      <div className="d-flex justify-content-between"><strong>Range (Metrics)</strong><Badge bg={status === "RUNNING" ? "success" : status === "STARTING" || status === "STOPPING" ? "warning" : "secondary"}>{status}</Badge></div>
      <div className="d-flex justify-content-between"><span>WS</span><Badge bg={wsBadgeVariant(wsStatus)}>{wsStatus}</Badge></div>
      <Form.Select value={mode} onChange={(e) => setMode(e.target.value)}><option value="paper">paper</option><option value="demo">demo</option></Form.Select>
      {mode === "demo" && !tradeStatus?.enabled ? <Alert variant="danger" className="mb-0 py-2">Demo disabled.</Alert> : null}
      {(warnings || []).map((w, i) => <Alert key={i} variant={w.severity === "error" ? "danger" : "warning"} className="mb-0 py-2">{w.code}: {w.message}</Alert>)}
      {ack ? <Alert variant={ack.variant} className="mb-0 py-2">{ack.text}</Alert> : null}
      <div className="d-flex gap-2">
        <Button onClick={start} disabled={startDisabled}>Start</Button>
        <Button variant="outline-danger" onClick={stop} disabled={stopDisabled}>Stop</Button>
        <Button variant="outline-secondary" onClick={refresh} disabled={!wsConnected}>Refresh</Button>
      </div>
      <div className="small">rangeLow={fmt(range?.scan?.lastCandidate?.rangeLow)} rangeHigh={fmt(range?.scan?.lastCandidate?.rangeHigh)} mid={fmt(range?.scan?.lastCandidate?.mid)} status={range?.position ? "IN_TRADE" : range?.scan?.lastCandidate?.trigger ? "ARMED" : "WAIT_BOUNDARY"}</div>
    </Card.Body></Card></Col>
    <Col md={8}>
      <Card className="mb-3"><Card.Body><strong>Gates</strong>
        <div className="small text-muted mb-2">Top fails: {topFails.length ? topFails.join(", ") : "All gates pass"}</div>
        <Table size="sm"><thead><tr><th>Gate</th><th className="text-end" style={{ width: "18%" }}>Value</th><th className="text-end" style={{ width: "18%" }}>Threshold</th><th style={{ width: "15%" }}>PASS</th></tr></thead><tbody>
          {gates.map((g, i) => <tr key={i}><td>{g.name}</td><td className="text-end font-monospace">{fmt(g.value)}</td><td className="text-end font-monospace">{fmt(g.threshold)}</td><td><Badge bg={g.pass ? "success" : "danger"}>{g.pass ? "PASS" : "FAIL"}</Badge></td></tr>)}
        </tbody></Table>
      </Card.Body></Card>
      <Card className="mb-3"><Card.Body><strong>Trades</strong>
        <Table size="sm"><thead><tr><th>Symbol</th><th>Side</th><th className="text-end" style={{ width: "22%" }}>PnL</th></tr></thead><tbody style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
          {trades.slice(0, 50).map((t, i) => <tr key={i}><td>{t.symbol}</td><td>{t.side}</td><td className="text-end">{fmt(t.pnlUSDT)}</td></tr>)}
        </tbody></Table>
      </Card.Body></Card>

      <Card className="mb-3"><Card.Body><strong>Positions</strong>
        <Table size="sm"><thead><tr><th>Symbol</th><th>Side</th><th className="text-end">Size</th><th className="text-end">Avg</th></tr></thead><tbody>
          {positions.slice(0,20).map((r,i)=><tr key={i}><td>{r.symbol}</td><td>{r.side}</td><td className="text-end font-monospace">{fmt(r.size,4)}</td><td className="text-end font-monospace">{fmt(r.avgPrice)}</td></tr>)}
        </tbody></Table>
        <strong>Open orders</strong>
        <Table size="sm"><thead><tr><th>ID</th><th>Side</th><th className="text-end">Qty</th><th className="text-end">Price</th></tr></thead><tbody>
          {orders.slice(0,20).map((r,i)=><tr key={i}><td>{r.orderId?.slice(0,10) || "—"}</td><td>{r.side}</td><td className="text-end font-monospace">{fmt(r.qty,4)}</td><td className="text-end font-monospace">{fmt(r.price)}</td></tr>)}
        </tbody></Table>
      </Card.Body></Card>
      <Card><Card.Body><strong>Logs (newest first)</strong><div style={{ minHeight: 220, maxHeight: 380, overflow: "auto", resize: "vertical", border: "1px solid #e5e7eb", borderRadius: 6, padding: 8, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace", fontSize: 12 }}>{logs.map((l, i) => <div key={i}>{l?.t || l?.ts ? `[${fmtTs(l.ts || l.t)}] ` : ""}{l.msg || "—"}</div>)}</div></Card.Body></Card>
    </Col>
  </Row>;
}
