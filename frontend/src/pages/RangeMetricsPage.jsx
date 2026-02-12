import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Col, Form, Nav, Row, Tab, Table } from "react-bootstrap";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";

function toWsUrl(apiBase) {
  const u = new URL(apiBase);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/ws`;
}

const fmt = (x, d = 6) => (Number.isFinite(Number(x)) ? Number(x).toFixed(d) : "—");

export default function RangeMetricsPage() {
  const wsRef = useRef(null);
  const pendingRef = useRef(new Map());
  const [wsStatus, setWsStatus] = useState("connecting");
  const [mode, setMode] = useState("paper");
  const [realConfirmText, setRealConfirmText] = useState("");
  const [range, setRange] = useState(null);
  const [tradeState, setTradeState] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [history, setHistory] = useState([]);
  const wsUrl = useMemo(() => toWsUrl(API_BASE), [API_BASE]);
  const symbolRef = useRef("BTCUSDT");

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
    setWarnings(pos.warnings || []);
    setPositions(pos.positions || []);
    setOrders(ord.orders || []);
    setHistory(Array.isArray(hist.history) ? hist.history.filter((x) => x && typeof x === "object") : []);
  };

  useEffect(() => {
    let shouldClose = false;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    const flushTimer = setInterval(() => {
      if (!pendingRef.current.size) return;
      const next = {};
      for (const [key, value] of pendingRef.current.entries()) next[key] = value;
      pendingRef.current.clear();

      if (next.positions !== undefined) setPositions(next.positions || []);
      if (next.orders !== undefined) setOrders(next.orders || []);
    }, 400);

    ws.onopen = () => {
      if (shouldClose) {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.close(1000, "cleanup"); } catch { /* ignore */ }
        }
        return;
      }
      setWsStatus("connected");
      try {
        ws.send(JSON.stringify({ type: "getRangeState" }));
      } catch {
        // ignore
      }
      poll().catch(() => {});
    };
    ws.onclose = () => setWsStatus("disconnected");
    ws.onerror = () => setWsStatus("error");
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      const type = msg?.type === "event" ? msg.topic : msg.type;
      const payload = msg?.type === "event" ? msg.payload : msg.payload;
      if (type === "snapshot") {
        if (payload?.rangeState) {
          setRange(payload.rangeState);
        }
      }
      if (type === "range.status" || type === "range.state") {
        if (!payload || typeof payload !== "object") return;
        setRange((prev) => ({ ...(prev || {}), ...payload }));
      }
      if (type === "trade.positions") pendingRef.current.set("positions", Array.isArray(payload?.positions) ? payload.positions : []);
      if (type === "trade.orders") pendingRef.current.set("orders", Array.isArray(payload?.orders) ? payload.orders : []);
      if (type === "range.start.ack" || type === "range.stop.ack") {
        if (payload?.state) setRange((prev) => ({ ...(prev || {}), ...payload.state }));
      }
    };
    const id = setInterval(() => poll().catch(() => {}), 4000);
    return () => {
      shouldClose = true;
      clearInterval(flushTimer);
      clearInterval(id);
      pendingRef.current.clear();
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.close(1000, "cleanup");
        } catch {
          // ignore
        }
      }
    };
  }, [wsUrl]);

  const start = () => {
    if (mode === "real" && realConfirmText !== "REAL") return;
    wsRef.current?.send(JSON.stringify({ type: "startRangeTest", mode }));
  };
  const stop = () => wsRef.current?.send(JSON.stringify({ type: "stopRangeTest" }));
  const realDisabled = tradeState?.tradeStatus && !tradeState.tradeStatus.realAllowed;

  return <Row className="g-3">
    <Col md={4}><Card><Card.Body className="d-grid gap-2">
      <div className="d-flex justify-content-between"><strong>Range (Metrics)</strong><Badge bg={wsStatus === "connected" ? "success" : "secondary"}>{wsStatus}</Badge></div>
      <Form.Select value={mode} onChange={(e) => setMode(e.target.value)}>
        <option value="paper">PAPER</option><option value="demo">DEMO</option><option value="real" disabled={realDisabled}>REAL</option>
      </Form.Select>
      {mode === "real" ? <Form.Control value={realConfirmText} onChange={(e) => setRealConfirmText(e.target.value)} placeholder="Type REAL" /> : null}
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
        <Tab.Pane eventKey="history"><Table size="sm"><tbody>{history.length ? history.map((r,i)=><tr key={i}><td>{r.symbol}</td><td>{fmt(r.closedPnl,4)}</td></tr>)  : <tr><td className="text-muted">No history yet</td></tr>}</tbody></Table></Tab.Pane>
      </Tab.Content></Tab.Container>
    </Card.Body></Card></Col>
  </Row>;
}
