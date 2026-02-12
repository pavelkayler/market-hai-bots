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

function fmtNum(x, d = 6) {
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

function uniBadge(s) {
  if (s === "ready") return "success";
  if (s === "loading") return "warning";
  if (s === "error") return "danger";
  return "secondary";
}

export default function PullbackTestPage() {
  const wsRef = useRef(null);

  const [wsStatus, setWsStatus] = useState("disconnected");
  const [universe, setUniverse] = useState(null);
  const [pb, setPb] = useState(null);
  const [logs, setLogs] = useState([]);
  const [trades, setTrades] = useState([]);
  const [position, setPosition] = useState(null);
  const [presetText, setPresetText] = useState("");

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
        if (p.universeStatus) setUniverse(p.universeStatus);
        if (p.pullbackState) {
          setPb(p.pullbackState);
          setPosition(p.pullbackState.position || null);
          setTrades(Array.isArray(p.pullbackState.trades) ? [...p.pullbackState.trades].reverse().slice(0, 200) : []);
          setLogs(Array.isArray(p.pullbackState.logs) ? p.pullbackState.logs : []);
          setPresetText(p.pullbackState.preset ? JSON.stringify(p.pullbackState.preset, null, 2) : "");
        }
        return;
      }

      if (msg.type === "universe.status") {
        setUniverse(msg.payload || null);
        return;
      }

      if (msg.type === "pullback.status") {
        setPb(msg.payload || null);
        setPosition(msg.payload?.position || null);
        setTrades(Array.isArray(msg.payload?.trades) ? [...msg.payload.trades].reverse().slice(0, 200) : []);
        setLogs(Array.isArray(msg.payload?.logs) ? msg.payload.logs : []);
        if (msg.payload?.preset) setPresetText(JSON.stringify(msg.payload.preset, null, 2));
        return;
      }

      if (msg.type === "pullback.position") {
        setPosition(msg.payload || null);
        return;
      }

      if (msg.type === "pullback.trade") {
        const t = msg.payload;
        if (!t) return;
        setTrades((prev) => [t, ...prev].slice(0, 300));
        return;
      }

      if (msg.type === "pullback.log") {
        const l = msg.payload;
        if (!l) return;
        setLogs((prev) => [l, ...prev].slice(0, 400));
        return;
      }

      if (msg.type === "pullback.state") {
        setPb(msg.payload || null);
        setPosition(msg.payload?.position || null);
        setTrades(Array.isArray(msg.payload?.trades) ? [...msg.payload.trades].reverse().slice(0, 200) : []);
        setLogs(Array.isArray(msg.payload?.logs) ? msg.payload.logs : []);
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

  useEffect(() => {
    const t = setInterval(() => {
      if (pb?.status !== "RUNNING") return;
      const start = Number(pb?.startedAt);
      if (!Number.isFinite(start)) return;
      setElapsedMs(Date.now() - start);
    }, 250);
    return () => clearInterval(t);
  }, [pb?.status, pb?.startedAt]);

  const start = () => {
    try {
      wsRef.current?.send(JSON.stringify({ type: "startPullbackTest" }));
    } catch {}
  };

  const stop = () => {
    try {
      wsRef.current?.send(JSON.stringify({ type: "stopPullbackTest" }));
    } catch {}
  };

  const refresh = () => {
    try {
      wsRef.current?.send(JSON.stringify({ type: "getPullbackState" }));
    } catch {}
  };

  const refreshUniverse = () => {
    try {
      wsRef.current?.send(JSON.stringify({ type: "refreshUniverse" }));
    } catch {}
  };

  const running = pb?.status === "RUNNING";

  return (
    <Row className="g-3">
      <Col md={4}>
        <Card>
          <Card.Body className="d-grid gap-2">
            <div className="d-flex align-items-center justify-content-between">
              <div className="fw-semibold">MTF Pullback (Paper)</div>
              <Badge bg={wsStatus === "connected" ? "success" : wsStatus === "connecting" ? "warning" : "secondary"}>
                WS: {wsStatus}
              </Badge>
            </div>

            <div className="d-flex align-items-center justify-content-between">
              <div className="fw-semibold">Status</div>
              <Badge bg={statusBadge(pb?.status)}>{pb?.status || "—"}</Badge>
            </div>

            <div className="text-muted">WS URL: {wsUrl}</div>

            <div className="d-flex gap-2">
              <Button variant="primary" onClick={start} disabled={wsStatus !== "connected" || running}>
                Start
              </Button>
              <Button variant="outline-danger" onClick={stop} disabled={wsStatus !== "connected" || !pb || pb?.status === "STOPPED"}>
                Stop
              </Button>
              <Button variant="outline-secondary" onClick={refresh} disabled={wsStatus !== "connected"}>
                Refresh
              </Button>
            </div>

            <hr className="my-2" />

            <div className="d-flex align-items-center justify-content-between">
              <div className="fw-semibold">Universe</div>
              <Badge bg={uniBadge(universe?.status)}>{universe?.status || "—"}</Badge>
            </div>

            <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
              cmc eligible: {universe?.cmcEligibleCount ?? "—"}
              <br />
              bybit linear: {universe?.bybitLinearCount ?? "—"}
              <br />
              universe: {universe?.universeCount ?? "—"}
              <br />
              last refresh: {universe?.lastRefreshAt ? fmtTs(universe.lastRefreshAt) : "—"}
              {universe?.error ? (
                <>
                  <br />
                  <span className="text-danger">{universe.error}</span>
                </>
              ) : null}
            </div>

            <Button variant="outline-primary" onClick={refreshUniverse} disabled={wsStatus !== "connected"}>
              Refresh universe
            </Button>

            <hr className="my-2" />

            <div className="d-flex align-items-center justify-content-between">
              <div className="fw-semibold">Started</div>
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                {pb?.startedAt ? fmtTs(pb.startedAt) : "—"}
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
              trades: {pb?.stats?.trades ?? 0} | wins: {pb?.stats?.wins ?? 0} | losses: {pb?.stats?.losses ?? 0}
              <br />
              pnlUSDT: {fmtNum(pb?.stats?.pnlUSDT, 4)}
            </div>

            <hr className="my-2" />

            <div className="fw-semibold">Position</div>
            {!position ? (
              <div className="text-muted">—</div>
            ) : (
              <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                {position.side} {position.symbol}
                <br />
                entry: {fmtNum(position.entry)}
                <br />
                sl: {fmtNum(position.sl)}
                <br />
                tp1: {fmtNum(position.legs?.[0]?.tp)} {position.legs?.[0]?.done ? "✓" : ""}
                <br />
                tp2: {fmtNum(position.legs?.[1]?.tp)} {position.legs?.[1]?.done ? "✓" : ""}
                <br />
                tp3: {fmtNum(position.legs?.[2]?.tp)} {position.legs?.[2]?.done ? "✓" : ""}
                <br />
                rr1: {fmtNum(position.rr1, 2)}
                <br />
                level: {fmtNum(position.level)} (zone {fmtNum(position.zoneWidth)})
              </div>
            )}

            <hr className="my-2" />

            <div className="fw-semibold">Preset (current)</div>
            <Form.Control as="textarea" rows={10} value={presetText} readOnly style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }} />
          </Card.Body>
        </Card>
      </Col>

      <Col md={8}>
        <Row className="g-3">
          <Col xs={12}>
            <Card>
              <Card.Body>
                <div className="fw-semibold mb-2">Trades (latest)</div>
                <div style={{ maxHeight: 240, overflow: "auto" }}>
                  <Table size="sm" hover>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Symbol</th>
                        <th>Side</th>
                        <th>Entry</th>
                        <th>Exit</th>
                        <th>Reason</th>
                        <th>PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((t, idx) => (
                        <tr key={idx}>
                          <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>{fmtTs(t.tClose || t.t || t.tOpen)}</td>
                          <td>{t.symbol}</td>
                          <td>{t.side}</td>
                          <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>{fmtNum(t.entry)}</td>
                          <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>{fmtNum(t.exit)}</td>
                          <td>{t.reason || "—"}</td>
                          <td style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>{fmtNum(t.pnlUSDT, 4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </Card.Body>
            </Card>
          </Col>

          <Col xs={12}>
            <Card>
              <Card.Body>
                <div className="fw-semibold mb-2">Logs (newest first)</div>
                <div style={{ maxHeight: 420, overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                  {logs.map((l, idx) => (
                    <div key={idx} style={{ borderBottom: "1px solid #eee", padding: "4px 0" }}>
                      <span className="text-muted">{fmtTs(l.t)} </span>
                      <span className={l.level === "warn" ? "text-warning" : l.level === "error" ? "text-danger" : ""}>
                        {l.msg}
                      </span>
                    </div>
                  ))}
                </div>
              </Card.Body>
            </Card>
          </Col>
        </Row>
      </Col>
    </Row>
  );
}
