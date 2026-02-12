import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Col, Collapse, Form, Row, Tab, Table, Tabs } from "react-bootstrap";
import { useWsClient } from "../../shared/api/ws.js";
import { mergeNonUndefined } from "../../shared/utils/merge.js";

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

function applyArrayPatch(prevArray, incomingArray, { allowEmptyReplace = false } = {}) {
  if (!Array.isArray(incomingArray)) return prevArray;
  if (!incomingArray.length && Array.isArray(prevArray) && prevArray.length && !allowEmptyReplace) return prevArray;
  return incomingArray;
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

  const showAck = useCallback((variant, text) => {
    setAck({ variant, text });
    if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    ackTimerRef.current = setTimeout(() => setAck(null), 2000);
  }, []);

  const applyState = useCallback((payload, { allowEmptyReplace = false } = {}) => {
    if (!payload || typeof payload !== "object") return;
    setPaper((prev) => mergeNonUndefined(prev, payload));

    if (Array.isArray(payload.logs)) {
      setLogs((prev) => [...applyArrayPatch(prev, [...payload.logs].reverse(), { allowEmptyReplace })].slice(0, 300));
    }
    if (Array.isArray(payload.trades)) {
      setTrades((prev) => [...applyArrayPatch(prev, [...payload.trades].reverse(), { allowEmptyReplace })].slice(0, 200));
    }
    if (Array.isArray(payload.tuneChanges)) {
      setTuneChanges((prev) => applyArrayPatch(prev, payload.tuneChanges, { allowEmptyReplace }).slice(0, 30));
    }
    if (Object.prototype.hasOwnProperty.call(payload, "position")) setPosition(payload.position || null);
    if (Object.prototype.hasOwnProperty.call(payload, "pending")) setPending(payload.pending || null);
    if (payload?.sessionPreset) setPresetText(JSON.stringify(payload.sessionPreset, null, 2));
  }, []);

  const onMessage = useMemo(() => (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    const type = msg.type;
    const payload = msg.payload;

    if (type === "snapshot") {
      const leadLagState = payload?.leadlagState || payload?.paperState;
      applyState(leadLagState, { allowEmptyReplace: false });
      return;
    }

    if (["leadlag.state", "paper.state", "leadlag.status", "paper.status"].includes(type)) {
      applyState(payload, { allowEmptyReplace: payload?.clear === true });
      return;
    }

    if (["leadlag.start.ack", "paper.start.ack"].includes(type)) {
      if (payload?.state) applyState(payload.state, { allowEmptyReplace: payload?.clear === true });
      showAck(payload?.ok ? "success" : "danger", payload?.ok ? "Тест запущен" : (payload?.error || "Start failed"));
      return;
    }

    if (["leadlag.stop.ack", "paper.stop.ack"].includes(type)) {
      if (payload?.state) applyState(payload.state, { allowEmptyReplace: payload?.clear === true });
      showAck(payload?.ok ? "success" : "danger", payload?.ok ? "Тест остановлен" : (payload?.error || "Stop failed"));
      return;
    }

    if (["leadlag.position", "paper.position"].includes(type)) {
      pendingRef.current.set("position", payload || null);
      return;
    }
    if (["leadlag.pending", "paper.pending"].includes(type)) {
      pendingRef.current.set("pending", payload || null);
      return;
    }
    if (["leadlag.tune", "paper.tune"].includes(type)) {
      if (payload) pendingRef.current.set("tuneChange", payload);
      return;
    }
    if (["leadlag.trade", "paper.trade"].includes(type)) {
      if (!payload) return;
      const queued = pendingRef.current.get("trades") || [];
      pendingRef.current.set("trades", [payload, ...queued].slice(0, 50));
      return;
    }
    if (["leadlag.log", "paper.log"].includes(type)) {
      if (!payload) return;
      const queued = pendingRef.current.get("logs") || [];
      pendingRef.current.set("logs", [payload, ...queued].slice(0, 120));
    }
  }, [applyState, showAck]);

  const { wsUrl, status: wsStatus, sendJson } = useWsClient({
    onOpen: () => sendJson({ type: "getLeadLagState" }),
    onMessage,
  });

  useEffect(() => {
    const flushTimer = setInterval(() => {
      if (!pendingRef.current.size) return;
      const next = {};
      for (const [key, value] of pendingRef.current.entries()) next[key] = value;
      pendingRef.current.clear();

      if (Array.isArray(next.trades) && next.trades.length) setTrades((prev) => [...next.trades, ...prev].slice(0, 200));
      if (Array.isArray(next.logs) && next.logs.length) setLogs((prev) => [...next.logs, ...prev].slice(0, 300));
      if (next.position !== undefined) setPosition(next.position || null);
      if (next.pending !== undefined) setPending(next.pending || null);
      if (next.tuneChange) {
        setTuneChanges((prev) => [next.tuneChange, ...prev].slice(0, 30));
      }
    }, 350);

    return () => {
      clearInterval(flushTimer);
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
      pendingRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (!paper?.startedAt) return;
      const end = paper?.endedAt || Date.now();
      setElapsedMs(Math.max(0, end - paper.startedAt));
    }, 300);
    return () => clearInterval(id);
  }, [paper?.startedAt, paper?.endedAt]);

  const running = paper?.status === "RUNNING" || paper?.status === "STARTING";
  const startDisabled = wsStatus !== "connected" || running;
  const stopDisabled = wsStatus !== "connected" || !running;
  const noEntryReasons = Array.isArray(paper?.lastNoEntryReasons) ? paper.lastNoEntryReasons.slice(0, 3) : [];

  const startPaper = () => sendJson({ type: "startLeadLag", mode: executionMode });
  const stopPaper = () => sendJson({ type: "stopLeadLag" });
  const refreshState = () => sendJson({ type: "getLeadLagState" });

  const monoStyle = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace", fontSize: 12 };

  return (
    <Row className="g-3">
      <Col md={4}>
        <Card>
          <Card.Body className="d-grid gap-2">
            <div className="d-flex justify-content-between"><strong>LeadLag (PAPER)</strong><Badge bg={wsStatus === "connected" ? "success" : "secondary"}>{wsStatus}</Badge></div>
            <div className="d-flex justify-content-between"><span>Status</span><Badge bg={statusBadge(paper?.status)}>{paper?.status || "—"}</Badge></div>
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
                  <div style={monoStyle}>trades: {paper?.stats?.trades ?? 0} | winRate: {fmtNum(paper?.stats?.winRate, 2)}%<br />pnlUSDT: {fmtNum(paper?.stats?.pnlUSDT, 4)}<br />signals/h: {fmtNum(paper?.quality?.signalsPerHour, 2)} | entries/h: {fmtNum(paper?.quality?.entriesPerHour, 2)} | avgPnL: {fmtNum(paper?.quality?.avgPnL, 4)} | maxDD: {fmtNum(paper?.quality?.maxDrawdownUSDT, 4)}</div>
                  <div style={monoStyle}>position: {position?.symbol ? `${position.symbol} ${position.side}` : 'none'} | pending: {pending ? 'yes' : 'no'}</div>
                  <div className="fw-semibold mt-2">No Entry: top reasons</div>
                  {!noEntryReasons.length ? <div className="text-muted">—</div> : (
                    <Table size="sm" className="mb-0" responsive>
                      <thead><tr><th>Reason</th><th>Count</th><th>Detail</th></tr></thead>
                      <tbody>{noEntryReasons.map((r, i) => <tr key={`${r.key}-${i}`}><td>{r.key}</td><td>{r.count}</td><td>{r.detail || "—"}</td></tr>)}</tbody>
                    </Table>
                  )}
                </div>
              </Tab>

              <Tab eventKey="logs" title={`Логи (${logs.length})`}>
                <div style={{ maxHeight: 360, overflow: "auto" }}>
                  <Table size="sm" hover>
                    <tbody>{logs.length ? logs.map((l, i) => <tr key={`${l.ts || i}-${i}`}><td className="text-nowrap" style={monoStyle}>{fmtTs(l.ts)}</td><td><Badge bg={l.level === "error" ? "danger" : "secondary"}>{l.level || "info"}</Badge></td><td style={monoStyle}>{l.msg || ""}</td></tr>) : <tr><td className="text-muted">No logs yet</td></tr>}</tbody>
                  </Table>
                </div>
              </Tab>

              <Tab eventKey="trades" title={`Детально (${trades.length})`}>
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
