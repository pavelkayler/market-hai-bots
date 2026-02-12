import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Col, Form, Row, Table } from "react-bootstrap";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";
const wsUrlFromApi = (api) => { try { const u = new URL(api); return `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}/ws`; } catch { return "ws://localhost:8080/ws"; } };
const fmt = (x, d = 4) => Number.isFinite(Number(x)) ? Number(x).toFixed(d) : "—";

export default function RangeMetricsPage() {
  const wsRef = useRef(null);
  const [mode, setMode] = useState("paper");
  const [range, setRange] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [tradeStatus, setTradeStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [gates, setGates] = useState([]);
  const [trades, setTrades] = useState([]);
  const wsUrl = useMemo(() => wsUrlFromApi(API_BASE), []);

  useEffect(() => {
    const ws = new WebSocket(wsUrl); wsRef.current = ws;
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "snapshot") {
        setRange(msg.payload?.rangeState || null);
        setWarnings(msg.payload?.warnings || []);
        setTradeStatus(msg.payload?.tradeStatus || null);
        setLogs(msg.payload?.rangeState?.logs || []);
        setTrades([...(msg.payload?.rangeState?.trades || [])].reverse());
      }
      if (msg.type === "range.status" || msg.type === "range.state") {
        setRange(msg.payload || null);
        setLogs(msg.payload?.logs || []);
        setTrades([...(msg.payload?.trades || [])].reverse());
      }
      if (msg.type === "range.log") setLogs((p) => [msg.payload, ...p].slice(0, 300));
      if (msg.type === "range.trade") setTrades((p) => [msg.payload, ...p].slice(0, 200));
      if (msg.type === "range.gates") setGates(msg.payload || []);
    };
    return () => ws.close();
  }, [wsUrl]);

  return <Row className="g-3">
    <Col md={4}><Card><Card.Body className="d-grid gap-2">
      <div className="d-flex justify-content-between"><strong>Range (Metrics)</strong><Badge bg={range?.status === "RUNNING" ? "success" : "secondary"}>{range?.status || "STOPPED"}</Badge></div>
      <Form.Select value={mode} onChange={(e) => setMode(e.target.value)}><option value="paper">paper</option><option value="demo">demo</option></Form.Select>
      {mode === "demo" && !tradeStatus?.enabled ? <Alert variant="danger" className="mb-0 py-2">Demo disabled.</Alert> : null}
      {(warnings || []).map((w, i) => <Alert key={i} variant={w.severity === "error" ? "danger" : "warning"} className="mb-0 py-2">{w.code}: {w.message}</Alert>)}
      <div className="d-flex gap-2">
        <Button onClick={() => wsRef.current?.send(JSON.stringify({ type: "startRangeTest", mode }))}>Start</Button>
        <Button variant="outline-danger" onClick={() => wsRef.current?.send(JSON.stringify({ type: "stopRangeTest" }))}>Stop</Button>
      </div>
      <div className="small">Current range: {range?.scan?.lastCandidate?.symbol || "—"} / atr={fmt(range?.position?.meta?.range?.size)}</div>
    </Card.Body></Card></Col>
    <Col md={8}>
      <Card className="mb-3"><Card.Body><strong>Gates</strong>
        <Table size="sm"><thead><tr><th>Gate</th><th>Value</th><th>Threshold</th><th>PASS</th></tr></thead><tbody>
          {gates.map((g, i) => <tr key={i}><td>{g.gateName}</td><td>{fmt(g.value)}</td><td>{fmt(g.threshold)}</td><td>{g.pass ? "PASS" : "FAIL"}</td></tr>)}
        </tbody></Table>
      </Card.Body></Card>
      <Card className="mb-3"><Card.Body><strong>Trades</strong>
        <Table size="sm"><thead><tr><th>Symbol</th><th>Side</th><th>PnL</th></tr></thead><tbody>
          {trades.slice(0,50).map((t, i) => <tr key={i}><td>{t.symbol}</td><td>{t.side}</td><td>{fmt(t.pnlUSDT)}</td></tr>)}
        </tbody></Table>
      </Card.Body></Card>
      <Card><Card.Body><strong>Logs</strong><div style={{ maxHeight: 300, overflow: "auto" }}>{logs.map((l, i) => <div key={i}>{l.msg}</div>)}</div></Card.Body></Card>
    </Col>
  </Row>;
}
