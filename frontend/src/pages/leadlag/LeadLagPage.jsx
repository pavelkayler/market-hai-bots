import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Col, Collapse, Form, Row, Tab, Table, Tabs } from "react-bootstrap";
import { useWsClient } from "../../shared/api/ws.js";
import { mergeNonUndefined } from "../../shared/utils/merge.js";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";

function fmtNum(x, d = 4) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(d);
}

function fmtTs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return "—";
  return new Date(n).toLocaleTimeString();
}

function statusBadge(s) {
  if (s === "RUNNING") return "success";
  if (s === "STARTING" || s === "STOPPING") return "warning";
  return "secondary";
}

export default function LeadLagPage() {
  const ackTimerRef = useRef(null);
  const pendingRef = useRef(new Map());

  const [paper, setPaper] = useState(null);
  const [presetText, setPresetText] = useState("");
  const [logs, setLogs] = useState([]);
  const [trades, setTrades] = useState([]);
  const [position, setPosition] = useState(null);
  const [pending, setPending] = useState(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [ack, setAck] = useState(null);
  const [showPreset, setShowPreset] = useState(false);
  const [executionMode, setExecutionMode] = useState("paper");
  const [tuneChanges, setTuneChanges] = useState([]);

  const showAck = (variant, text) => {
    setAck({ variant, text });
    if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    ackTimerRef.current = setTimeout(() => setAck(null), 2000);
  };

  const onMessage = useMemo(() => (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === "snapshot") {
      const p = msg.payload || {};
      if (p.paperState && typeof p.paperState === "object") {
        setPaper(p.paperState);
        if (Array.isArray(p.paperState.trades)) setTrades([...p.paperState.trades].reverse().slice(0, 100));
        if (Array.isArray(p.paperState.logs)) setLogs([...p.paperState.logs].reverse());
        setPosition(p.paperState.position || null);
        setPending(p.paperState.pending || null);
        setPresetText(p.paperState.sessionPreset ? JSON.stringify(p.paperState.sessionPreset, null, 2) : "");
        if (Array.isArray(p.paperState.tuneChanges)) setTuneChanges(p.paperState.tuneChanges);
      }
      return;
    }

    if (msg.type === "paper.state") {
      const payload = msg.payload;
      if (!payload || typeof payload !== "object") return;
      setPaper((prev) => mergeNonUndefined(prev, payload));
      if (Array.isArray(payload.logs)) setLogs([...payload.logs].reverse());
      if (Array.isArray(payload.trades)) setTrades([...payload.trades].reverse().slice(0, 100));
      if (Array.isArray(payload.tuneChanges)) setTuneChanges(payload.tuneChanges);
      if (Object.prototype.hasOwnProperty.call(payload, "position")) setPosition(payload.position || null);
      if (Object.prototype.hasOwnProperty.call(payload, "pending")) setPending(payload.pending || null);
      return;
    }

    if (msg.type === "paper.status") {
      const payload = msg.payload;
      if (!payload || typeof payload !== "object") return;
      setPaper((prev) => mergeNonUndefined(prev, payload));
      if (payload?.sessionPreset) setPresetText(JSON.stringify(payload.sessionPreset, null, 2));
      if (Object.prototype.hasOwnProperty.call(payload, "position")) setPosition(payload.position || null);
      if (Object.prototype.hasOwnProperty.call(payload, "pending")) setPending(payload.pending || null);
      return;
    }

    if (msg.type === "paper.start.ack") {
      if (msg.payload?.state) setPaper((prev) => mergeNonUndefined(prev, msg.payload.state));
      if (msg.payload?.ok) showAck("success", "Тест запущен");
      else showAck("danger", msg.payload?.error || "Start failed");
      return;
    }

    if (msg.type === "paper.stop.ack") {
      if (msg.payload?.state) setPaper((prev) => mergeNonUndefined(prev, msg.payload.state));
      if (msg.payload?.ok) showAck("success", "Тест остановлен");
      else showAck("danger", msg.payload?.error || "Stop failed");
      return;
    }

    if (msg.type === "paper.position") {
      pendingRef.current.set("position", msg.payload || null);
      return;
    }
    if (msg.type === "paper.pending") {
      pendingRef.current.set("pending", msg.payload || null);
      return;
    }
    if (msg.type === "paper.tune") {
      if (msg.payload) pendingRef.current.set("tuneChange", msg.payload);
      return;
    }
    if (msg.type === "paper.trade") {
      if (!msg.payload) return;
      const queued = pendingRef.current.get("trades") || [];
      pendingRef.current.set("trades", [msg.payload, ...queued].slice(0, 30));
      return;
    }
    if (msg.type === "paper.log") {
      if (!msg.payload) return;
      const queued = pendingRef.current.get("logs") || [];
      pendingRef.current.set("logs", [msg.payload, ...queued].slice(0, 80));
    }
  }, []);

  const { wsUrl, status: wsStatus, sendJson } = useWsClient({
    apiBase: API_BASE,
    onOpen: () => {
      sendJson({ type: "getPaperState" });
    },
    onMessage,
  });

  useEffect(() => {
    const flushTimer = setInterval(() => {
      if (!pendingRef.current.size) return;
      const next = {};
      for (const [key, value] of pendingRef.current.entries()) next[key] = value;
      pendingRef.current.clear();

      if (Array.isArray(next.trades)) setTrades((prev) => [...next.trades, ...prev].slice(0, 200));
      if (Array.isArray(next.logs)) setLogs((prev) => [...next.logs, ...prev].slice(0, 300));
      if (next.position !== undefined) setPosition(next.position || null);
      if (next.pending !== undefined) setPending(next.pending || null);
      if (next.tuneChange) setTuneChanges((prev) => [next.tuneChange, ...prev].slice(0, 10));
    }, 350);

    return () => {
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      clearInterval(flushTimer);
      pendingRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      if (paper?.status !== "RUNNING") return;
      const start = Number(paper?.startedAt);
      if (!Number.isFinite(start)) return;
      setElapsedMs(Date.now() - start);
    }, 250);
    return () => clearInterval(t);
  }, [paper?.status, paper?.startedAt]);

  const startPaper = () => sendJson({ type: "startPaperTest", mode: executionMode });
  const stopPaper = () => sendJson({ type: "stopPaperTest" });
  const refreshState = () => sendJson({ type: "getPaperState" });

  const status = paper?.status || "STOPPED";
  const running = status === "RUNNING";
  const startDisabled = wsStatus !== "connected" || ["RUNNING", "STARTING"].includes(status);
  const stopDisabled = wsStatus !== "connected" || ["STOPPED", "STOPPING"].includes(status);
  const monoStyle = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" };
  const noEntryReasons = Array.isArray(paper?.lastNoEntryReasons) ? paper.lastNoEntryReasons.slice(0, 3) : [];

  return (
    <Row className="g-3">
      <Col md={4}>
        <Card>
          <Card.Body className="d-grid gap-2">
            <div className="d-flex align-items-center justify-content-between">
              <div className="fw-semibold">LeadLag ({executionMode.toUpperCase()})</div>
              <Badge bg={wsStatus === "connected" ? "success" : wsStatus === "connecting" ? "warning" : wsStatus === "error" ? "danger" : "secondary"}>WS: {wsStatus}</Badge>
            </div>
            <div className="d-flex align-items-center justify-content-between">
              <div className="fw-semibold">Status</div>
              <Badge bg={statusBadge(paper?.status)}>{paper?.status || "—"}</Badge>
            </div>
            {ack ? <Alert variant={ack.variant} className="mb-0 py-2">{ack.text}</Alert> : null}
            <div className="text-muted">WS URL: {wsUrl}</div>
            <Form.Select size="sm" value={executionMode} onChange={(e) => setExecutionMode(e.target.value)}>
              <option value="paper">PAPER</option><option value="demo">DEMO</option><option value="real">REAL</option>
            </Form.Select>
            <div className="d-flex gap-2">
              <Button variant="primary" onClick={startPaper} disabled={startDisabled}>Start</Button>
              <Button variant="outline-danger" onClick={stopPaper} disabled={stopDisabled}>Stop</Button>
              <Button variant="outline-secondary" onClick={refreshState} disabled={wsStatus !== "connected"}>Refresh</Button>
            </div>
          </Card.Body>
        </Card>

        <Card className="mt-3">
          <Card.Body>
            <Button variant="outline-secondary" size="sm" onClick={() => setShowPreset((p) => !p)} aria-controls="paper-preset" aria-expanded={showPreset} className="mb-2">
              {showPreset ? "Hide preset" : "Show preset"}
            </Button>
            <Collapse in={showPreset}>
              <div id="paper-preset">
                <div className="fw-semibold mb-2">Preset (current)</div>
                <Form.Control as="textarea" rows={12} value={presetText} readOnly style={monoStyle} />
              </div>
            </Collapse>
          </Card.Body>
        </Card>
      </Col>

      <Col md={8}>
        <Card>
          <Card.Body>
            <Tabs defaultActiveKey="summary" id="paper-tabs" className="mb-3">
              <Tab eventKey="summary" title="Кратко">
                <div className="mb-2">Active preset: <b>{paper?.activePreset?.name || "—"}</b> | Session preset: <b>{paper?.sessionPreset?.name || "—"}</b></div>
                <div className="d-grid gap-2">
                  <div className="d-flex align-items-center justify-content-between"><div className="fw-semibold">Started</div><div style={monoStyle}>{paper?.startedAt ? fmtTs(paper.startedAt) : "—"}</div></div>
                  <div className="d-flex align-items-center justify-content-between"><div className="fw-semibold">Elapsed</div><div style={monoStyle}>{running ? `${(elapsedMs / 1000).toFixed(1)}s` : paper?.endedAt && paper?.startedAt ? `${((paper.endedAt - paper.startedAt) / 1000).toFixed(1)}s` : "—"}</div></div>
                  <div className="fw-semibold mt-2">Summary</div>
                  <div style={monoStyle}>trades: {paper?.stats?.trades ?? 0} | winRate: {fmtNum(paper?.stats?.winRate, 2)}%<br />pnlUSDT: {fmtNum(paper?.stats?.pnlUSDT, 4)}</div>

                  <div className="fw-semibold mt-2">No Entry: top reasons</div>
                  {!noEntryReasons.length ? <div className="text-muted">—</div> : (
                    <Table size="sm" className="mb-0" responsive>
                      <thead><tr><th>Reason</th><th>Count</th><th>Detail</th></tr></thead>
                      <tbody>{noEntryReasons.map((r, i) => <tr key={`${r.key}-${i}`}><td>{r.key}</td><td>{r.count}</td><td>{r.detail || "—"}</td></tr>)}</tbody>
                    </Table>
                  )}

                  <div className="fw-semibold mt-2">Position</div>
                  {!position ? <div className="text-muted">—</div> : <div style={monoStyle}>{position.side} {position.symbol}<br />entry: {fmtNum(position.entryPrice)} | tp: {fmtNum(position.tpPrice)} | sl: {fmtNum(position.slPrice)}</div>}
                  <div className="fw-semibold mt-2">Pending</div>
                  {!pending ? <div className="text-muted">—</div> : <div style={monoStyle}>{pending.side} {pending.symbol}<br />entry: {fmtNum(pending.entryPrice)} | tp: {fmtNum(pending.tpPrice)} | sl: {fmtNum(pending.slPrice)}</div>}
                </div>
              </Tab>

              <Tab eventKey="logs" title={`Logs (${logs.length})`}>
                <div style={{ maxHeight: 360, overflow: "auto" }}>
                  <Table size="sm" hover>
                    <tbody>{logs.length ? logs.map((l, i) => <tr key={`${l.ts || i}-${i}`}><td className="text-nowrap" style={monoStyle}>{fmtTs(l.ts)}</td><td><Badge bg={l.level === "error" ? "danger" : "secondary"}>{l.level || "info"}</Badge></td><td style={monoStyle}>{l.msg || ""}</td></tr>) : <tr><td className="text-muted">No logs yet</td></tr>}</tbody>
                  </Table>
                </div>
              </Tab>

              <Tab eventKey="trades" title={`Trades (${trades.length})`}>
                <div style={{ maxHeight: 360, overflow: "auto" }}>
                  <Table size="sm" hover>
                    <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>PnL</th></tr></thead>
                    <tbody>{trades.length ? trades.map((t, i) => <tr key={`${t.ts || i}-${i}`}><td style={monoStyle}>{fmtTs(t.ts)}</td><td>{t.symbol || "—"}</td><td>{t.side || "—"}</td><td>{fmtNum(t.entryPrice)}</td><td>{fmtNum(t.exitPrice)}</td><td>{fmtNum(t.pnlUSDT)}</td></tr>) : <tr><td colSpan={6} className="text-muted">No trades yet</td></tr>}</tbody>
                  </Table>
                </div>
              </Tab>

              <Tab eventKey="tune" title={`Auto-tune (${tuneChanges.length})`}>
                <Table size="sm" hover>
                  <thead><tr><th>Time</th><th>Param</th><th>From</th><th>To</th><th>Reason</th></tr></thead>
                  <tbody>{tuneChanges.length ? tuneChanges.map((c, i) => <tr key={`${c.ts || i}-${i}`}><td style={monoStyle}>{fmtTs(c.ts)}</td><td>{c.param}</td><td>{fmtNum(c.from, 6)}</td><td>{fmtNum(c.to, 6)}</td><td>{c.reason || "—"}</td></tr>) : <tr><td colSpan={5} className="text-muted">No tune changes yet</td></tr>}</tbody>
                </Table>
              </Tab>
            </Tabs>
          </Card.Body>
        </Card>
      </Col>
    </Row>
  );
}
