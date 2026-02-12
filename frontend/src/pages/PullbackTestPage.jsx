import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Col, Form, Row, Table } from "react-bootstrap";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";
const wsUrlFromApi = (api) => { try { const u = new URL(api); return `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}/ws`; } catch { return "ws://localhost:8080/ws"; } };
const fmtNum = (x, d = 6) => Number.isFinite(Number(x)) ? Number(x).toFixed(d) : "—";
const fmtTs = (ts) => Number.isFinite(Number(ts)) ? new Date(Number(ts)).toLocaleTimeString() : "—";

export default function PullbackTestPage() {
  const wsRef = useRef(null);
  const [wsStatus, setWsStatus] = useState("disconnected");
  const [mode, setMode] = useState("paper");
  const [pb, setPb] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [tradeStatus, setTradeStatus] = useState(null);
  const [logs, setLogs] = useState([]);
  const [trades, setTrades] = useState([]);

  const wsUrl = useMemo(() => wsUrlFromApi(API_BASE), []);

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setWsStatus("connecting");
    ws.onopen = () => setWsStatus("connected");
    ws.onclose = () => setWsStatus("disconnected");
    ws.onerror = () => setWsStatus("error");
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "snapshot") {
        setPb(msg.payload?.pullbackState || null);
        setWarnings(msg.payload?.warnings || []);
        setTradeStatus(msg.payload?.tradeStatus || null);
        setLogs(msg.payload?.pullbackState?.logs || []);
        setTrades([...(msg.payload?.pullbackState?.trades || [])].reverse());
      }
      if (msg.type === "pullback.status" || msg.type === "pullback.state") {
        setPb(msg.payload || null);
        setLogs(msg.payload?.logs || []);
        setTrades([...(msg.payload?.trades || [])].reverse());
      }
      if (msg.type === "pullback.log") setLogs((prev) => [msg.payload, ...prev].slice(0, 300));
      if (msg.type === "pullback.trade") setTrades((prev) => [msg.payload, ...prev].slice(0, 200));
    };
    return () => ws.close();
  }, [wsUrl]);

  const start = () => wsRef.current?.send(JSON.stringify({ type: "startPullbackTest", mode }));
  const stop = () => wsRef.current?.send(JSON.stringify({ type: "stopPullbackTest" }));

  return <Row className="g-3">
    <Col md={4}>
      <Card><Card.Body className="d-grid gap-2">
        <div className="d-flex justify-content-between"><strong>Pullback</strong><Badge bg={wsStatus === "connected" ? "success" : "secondary"}>{wsStatus}</Badge></div>
        <div className="d-flex justify-content-between"><span>Status</span><Badge bg={pb?.status === "RUNNING" ? "success" : "secondary"}>{pb?.status || "STOPPED"}</Badge></div>
        <Form.Select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="paper">paper</option>
          <option value="demo">demo</option>
        </Form.Select>
        {mode === "demo" && !tradeStatus?.enabled ? <Alert variant="danger" className="mb-0 py-2">Demo disabled: missing BYBIT keys.</Alert> : null}
        <div className="small">trade: {tradeStatus?.enabled ? "enabled" : "disabled"} | base: {tradeStatus?.baseUrl || "—"}</div>
        {(warnings || []).map((w, i) => <Alert key={i} variant={w.severity === "error" ? "danger" : "warning"} className="mb-0 py-2">{w.code}: {w.message}</Alert>)}
        <div className="d-flex gap-2">
          <Button onClick={start} disabled={wsStatus !== "connected"}>Start</Button>
          <Button variant="outline-danger" onClick={stop} disabled={wsStatus !== "connected"}>Stop</Button>
        </div>
      </Card.Body></Card>
    </Col>
    <Col md={8}>
      <Card className="mb-3"><Card.Body>
        <strong>Trades</strong>
        <Table size="sm"><thead><tr><th>t</th><th>sym</th><th>side</th><th>pnl</th></tr></thead><tbody>
          {trades.slice(0, 50).map((t, i) => <tr key={i}><td>{fmtTs(t.tClose || t.t)}</td><td>{t.symbol}</td><td>{t.side}</td><td>{fmtNum(t.pnlUSDT, 4)}</td></tr>)}
        </tbody></Table>
      </Card.Body></Card>
      <Card><Card.Body><strong>Logs (newest first)</strong>
        <div style={{ maxHeight: 420, overflow: "auto" }}>{logs.map((l, i) => <div key={i}><span className="text-muted">{fmtTs(l.t)} </span>{l.msg}</div>)}</div>
      </Card.Body></Card>
    </Col>
  </Row>;
}
