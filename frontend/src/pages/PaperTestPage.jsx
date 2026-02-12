import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Col, Form, Row, Table } from "react-bootstrap";

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

export default function PaperTestPage() {
  const wsRef = useRef(null);

  const [wsStatus, setWsStatus] = useState("disconnected");

  const [paper, setPaper] = useState(null);
  const [presetText, setPresetText] = useState("");

  const [logs, setLogs] = useState([]); // newest first
  const [trades, setTrades] = useState([]);
  const [position, setPosition] = useState(null);
  const [pending, setPending] = useState(null);

  const [elapsedMs, setElapsedMs] = useState(0);

  const wsUrl = useMemo(() => toWsUrl(API_BASE), []);

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
        const p = msg.payload || {};
        if (p.paperState) {
          setPaper(p.paperState);
          setTrades(Array.isArray(p.paperState.trades) ? [...p.paperState.trades].reverse().slice(0, 100) : []);
          setLogs(Array.isArray(p.paperState.logs) ? p.paperState.logs : []);
          setPosition(p.paperState.position || null);
          setPending(p.paperState.pending || null);
          setPresetText(p.paperState.preset ? JSON.stringify(p.paperState.preset, null, 2) : "");
        }
        return;
      }

      if (msg.type === "paper.status") {
        setPaper(msg.payload || null);
        if (msg.payload?.preset) setPresetText(JSON.stringify(msg.payload.preset, null, 2));
        setPosition(msg.payload?.position || null);
        setPending(msg.payload?.pending || null);
        return;
      }

      if (msg.type === "paper.position") {
        setPosition(msg.payload || null);
        return;
      }

      if (msg.type === "paper.pending") {
        setPending(msg.payload || null);
        return;
      }

      if (msg.type === "paper.trade") {
        const t = msg.payload;
        if (!t) return;
        setTrades((prev) => [t, ...prev].slice(0, 200));
        return;
      }

      if (msg.type === "paper.log") {
        const l = msg.payload;
        if (!l) return;
        setLogs((prev) => [l, ...prev].slice(0, 300));
        return;
      }

      if (msg.type === "paper.state") {
        setPaper(msg.payload || null);
        setTrades(Array.isArray(msg.payload?.trades) ? [...msg.payload.trades].reverse().slice(0, 100) : []);
        setLogs(Array.isArray(msg.payload?.logs) ? msg.payload.logs : []);
        setPosition(msg.payload?.position || null);
        setPending(msg.payload?.pending || null);
        if (msg.payload?.preset) setPresetText(JSON.stringify(msg.payload.preset, null, 2));
        return;
      }
    };

    return () => {
      try {
        ws.close();
      } catch {}
    };
  }, [wsUrl]);

  // elapsed timer (ticks only while RUNNING)
  useEffect(() => {
    const t = setInterval(() => {
      if (paper?.status !== "RUNNING") return;
      const start = Number(paper?.startedAt);
      if (!Number.isFinite(start)) return;
      setElapsedMs(Date.now() - start);
    }, 250);

    return () => clearInterval(t);
  }, [paper?.status, paper?.startedAt]);

  const startPaper = () => {
    try {
      // preset can be edited later; for now send nothing (use backend defaults)
      wsRef.current?.send(JSON.stringify({ type: "startPaperTest" }));
    } catch {}
  };

  const stopPaper = () => {
    try {
      wsRef.current?.send(JSON.stringify({ type: "stopPaperTest" }));
    } catch {}
  };

  const refreshState = () => {
    try {
      wsRef.current?.send(JSON.stringify({ type: "getPaperState" }));
    } catch {}
  };

  const running = paper?.status === "RUNNING";

  return (
    <Row className="g-3">
      <Col md={4}>
        <Card>
          <Card.Body className="d-grid gap-2">
            <div className="d-flex align-items-center justify-content-between">
              <div className="fw-semibold">Paper Test</div>
              <Badge bg={wsStatus === "connected" ? "success" : wsStatus === "connecting" ? "warning" : "secondary"}>
                WS: {wsStatus}
              </Badge>
            </div>

            <div className="d-flex align-items-center justify-content-between">
              <div className="fw-semibold">Status</div>
              <Badge bg={statusBadge(paper?.status)}>
                {paper?.status || "—"}
              </Badge>
            </div>

            <div className="text-muted">
              WS URL: {wsUrl}
            </div>

            <div className="d-flex gap-2">
              <Button variant="primary" onClick={startPaper} disabled={wsStatus !== "connected" || running}>
                Start
              </Button>
              <Button variant="outline-danger" onClick={stopPaper} disabled={wsStatus !== "connected" || !paper || paper?.status === "STOPPED"}>
                Stop
              </Button>
              <Button variant="outline-secondary" onClick={refreshState} disabled={wsStatus !== "connected"}>
                Refresh
              </Button>
            </div>

            <hr className="my-2" />

            <div className="d-flex align-items-center justify-content-between">
              <div className="fw-semibold">Started</div>
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                {paper?.startedAt ? fmtTs(paper.startedAt) : "—"}
              </div>
            </div>

            <div className="d-flex align-items-center justify-content-between">
              <div className="fw-semibold">Elapsed</div>
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                {running ? `${(elapsedMs / 1000).toFixed(1)}s` : "—"}
              </div>
            </div>

            <hr className="my-2" />

            <div className="fw-semibold">Summary</div>
            <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
              trades: {paper?.stats?.trades ?? 0} | wins: {paper?.stats?.wins ?? 0} | losses: {paper?.stats?.losses ?? 0}
              <br />
              pnlUSDT: {fmtNum(paper?.stats?.pnlUSDT, 4)}
            </div>

            <hr className="my-2" />

            <div className="fw-semibold">Position</div>
            {!position ? (
              <div className="text-muted">—</div>
            ) : (
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                {position.side} {position.symbol}
                <br />
                entry: {fmtNum(position.entryPrice)} | tp: {fmtNum(position.tpPrice)} | sl: {fmtNum(position.slPrice)}
              </div>
            )}

            <hr className="my-2" />

            <div className="fw-semibold">Pending</div>
            {!pending ? (
              <div className="text-muted">—</div>
            ) : (
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                {pending.side} {pending.symbol}
                <br />
                execAt: {fmtTs(pending.executeAt)}
              </div>
            )}
          </Card.Body>
        </Card>

        <Card className="mt-3">
          <Card.Body>
            <div className="fw-semibold mb-2">Preset (current)</div>
            <Form.Control as="textarea" rows={12} value={presetText} readOnly style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }} />
          </Card.Body>
        </Card>
      </Col>

      <Col md={8}>
        <Card>
          <Card.Body>
            <div className="fw-semibold mb-2">Trades (latest)</div>
            <Table bordered size="sm" responsive>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>PnL USDT</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                {trades.slice(0, 20).map((t, i) => (
                  <tr key={i}>
                    <td>{fmtTs(t.closedAt)}</td>
                    <td>{t.symbol}</td>
                    <td>{t.side}</td>
                    <td>{fmtNum(t.entryPrice)}</td>
                    <td>{fmtNum(t.exitPrice)}</td>
                    <td>{fmtNum(t.pnlUSDT, 4)}</td>
                    <td>{t.reason}</td>
                  </tr>
                ))}
                {trades.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-muted">Пока нет сделок.</td>
                  </tr>
                ) : null}
              </tbody>
            </Table>
          </Card.Body>
        </Card>

        <Card className="mt-3">
          <Card.Body>
            <div className="d-flex align-items-center justify-content-between mb-2">
              <div className="fw-semibold">Logs (newest first)</div>
              <div className="text-muted">{logs.length} rows</div>
            </div>

            <div
              style={{
                height: 280,
                overflow: "auto",
                border: "1px solid #e5e7eb",
                borderRadius: 6,
                padding: 8,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                fontSize: 12,
                whiteSpace: "pre-wrap",
              }}
            >
              {logs.length === 0 ? (
                <div className="text-muted">—</div>
              ) : (
                logs.map((l, idx) => (
                  <div key={idx}>
                    [{fmtTs(l.ts)}] {l.level?.toUpperCase?.() || "INFO"} — {l.msg}
                  </div>
                ))
              )}
            </div>
          </Card.Body>
        </Card>
      </Col>
    </Row>
  );
}
