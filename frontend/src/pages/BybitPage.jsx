// frontend/src/pages/BybitPage.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Col, Form, Row, Table } from "react-bootstrap";

const WS_URL = "ws://localhost:8080/ws";

function toSymbolList(text) {
  return text
    .split(",")
    .map((s) => s.trim().toUpperCase().replace("/", "").replace("-", ""))
    .filter(Boolean);
}

function statusVariant(s) {
  if (s === "connected") return "success";
  if (s === "connecting") return "warning";
  return "secondary";
}

function srcTag(src) {
  const v = String(src || "").toLowerCase();
  if (v === "binance") return "BNB";
  if (v === "bybit") return "BT";
  return "?";
}

export default function BybitPage() {
  const wsRef = useRef(null);

  const [wsStatus, setWsStatus] = useState("disconnected");

  const [bybitStatus, setBybitStatus] = useState({ status: "unknown" });
  const [binanceStatus, setBinanceStatus] = useState({ status: "unknown" });

  const [symbols, setSymbols] = useState(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  const [symbolsInput, setSymbolsInput] = useState("BTCUSDT,ETHUSDT,SOLUSDT");
  const [selected, setSelected] = useState("BTCUSDT");

  // tickers maps
  const [bybitTickers, setBybitTickers] = useState({});
  const [binanceTickers, setBinanceTickers] = useState({});

  // bars
  const [lastBybitBars, setLastBybitBars] = useState({});
  const [lastBinanceBars, setLastBinanceBars] = useState({});
  const [barsSource, setBarsSource] = useState("bybit");
  const [bars, setBars] = useState([]);

  // lead-lag
  const [leadLagTop, setLeadLagTop] = useState([]);

  // buffering (flush каждые 250мс)
  const pendingBybitRef = useRef(new Map());
  const pendingBinanceRef = useRef(new Map());

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    setWsStatus("connecting");

    const flushTimer = setInterval(() => {
      if (pendingBybitRef.current.size) {
        const updates = {};
        for (const [sym, t] of pendingBybitRef.current.entries()) updates[sym] = t;
        pendingBybitRef.current.clear();
        setBybitTickers((prev) => ({ ...prev, ...updates }));
      }

      if (pendingBinanceRef.current.size) {
        const updates = {};
        for (const [sym, t] of pendingBinanceRef.current.entries()) updates[sym] = t;
        pendingBinanceRef.current.clear();
        setBinanceTickers((prev) => ({ ...prev, ...updates }));
      }
    }, 250);

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

        if (p.bybit) setBybitStatus(p.bybit);
        if (p.binance) setBinanceStatus(p.binance);

        if (Array.isArray(p.symbols)) {
          setSymbols(p.symbols);
          setSymbolsInput(p.symbols.join(","));
          if (!p.symbols.includes(selected)) setSelected(p.symbols[0] || "BTCUSDT");
        }

        // backward-compat
        if (p.bybitTickers && typeof p.bybitTickers === "object") setBybitTickers(p.bybitTickers);
        else if (p.tickers && typeof p.tickers === "object") setBybitTickers(p.tickers);

        if (p.binanceTickers && typeof p.binanceTickers === "object") setBinanceTickers(p.binanceTickers);

        if (Array.isArray(p.leadLagTop)) setLeadLagTop(p.leadLagTop);
        return;
      }

      if (msg.type === "bybit.status") {
        setBybitStatus(msg.payload || { status: "unknown" });
        return;
      }

      if (msg.type === "binance.status") {
        setBinanceStatus(msg.payload || { status: "unknown" });
        return;
      }

      if (msg.type === "bybit.ticker") {
        const t = msg.payload;
        if (!t?.symbol) return;
        pendingBybitRef.current.set(t.symbol, t);
        return;
      }

      if (msg.type === "binance.ticker") {
        const t = msg.payload;
        if (!t?.symbol) return;
        pendingBinanceRef.current.set(t.symbol, t);
        return;
      }

      if (msg.type === "bybit.bar") {
        const b = msg.payload;
        if (!b?.symbol) return;
        setLastBybitBars((prev) => ({ ...prev, [b.symbol]: b }));
        return;
      }

      if (msg.type === "binance.bar") {
        const b = msg.payload;
        if (!b?.symbol) return;
        setLastBinanceBars((prev) => ({ ...prev, [b.symbol]: b }));
        return;
      }

      if (msg.type === "bars") {
        const p = msg.payload || {};
        if (typeof p.source === "string") setBarsSource(p.source);
        if (Array.isArray(p.bars)) setBars(p.bars);
        return;
      }

      if (msg.type === "leadlag.top") {
        const arr = msg.payload;
        if (Array.isArray(arr)) setLeadLagTop(arr);
        return;
      }

      if (msg.type === "setSymbols.ack") {
        const next = msg.payload?.symbols;
        if (Array.isArray(next)) {
          setSymbols(next);
          setSymbolsInput(next.join(","));
          if (!next.includes(selected)) setSelected(next[0] || "BTCUSDT");
        }
        return;
      }
    };

    return () => {
      clearInterval(flushTimer);
      try {
        ws.close();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedBybit = useMemo(() => bybitTickers[selected] || null, [bybitTickers, selected]);
  const selectedBinance = useMemo(() => binanceTickers[selected] || null, [binanceTickers, selected]);

  const onApplySymbols = () => {
    const next = toSymbolList(symbolsInput).slice(0, 10);
    if (next.length === 0) return;
    try {
      wsRef.current?.send(JSON.stringify({ type: "setSymbols", symbols: next }));
    } catch {}
  };

  const refreshSnapshot = () => {
    try {
      wsRef.current?.send(JSON.stringify({ type: "getSnapshot" }));
    } catch {}
  };

  const fetchBars = (source) => {
    try {
      wsRef.current?.send(JSON.stringify({ type: "getBars", symbol: selected, n: 200, source }));
    } catch {}
  };

  const fetchLeadLag = () => {
    try {
      wsRef.current?.send(JSON.stringify({ type: "getLeadLagTop", n: 10 }));
    } catch {}
  };

  return (
    <Row className="g-3">
      <Col md={5}>
        <Card>
          <Card.Body>
            <div className="d-flex align-items-center justify-content-between mb-3">
              <div className="d-flex align-items-center gap-2">
                <div className="fw-semibold">Backend WS</div>
                <Badge bg={wsStatus === "connected" ? "success" : wsStatus === "connecting" ? "warning" : "secondary"}>
                  {wsStatus}
                </Badge>
              </div>

              <div className="d-flex align-items-center gap-3">
                <div className="d-flex align-items-center gap-2">
                  <div className="fw-semibold">Bybit</div>
                  <Badge bg={statusVariant(bybitStatus?.status)}>{bybitStatus?.status || "unknown"}</Badge>
                </div>

                <div className="d-flex align-items-center gap-2">
                  <div className="fw-semibold">Binance</div>
                  <Badge bg={statusVariant(binanceStatus?.status)}>{binanceStatus?.status || "unknown"}</Badge>
                </div>
              </div>
            </div>

            <Form.Group className="mb-2">
              <Form.Label className="fw-semibold">Symbols (comma-separated)</Form.Label>
              <Form.Control
                value={symbolsInput}
                onChange={(e) => setSymbolsInput(e.target.value)}
                placeholder="BTCUSDT,ETHUSDT,SOLUSDT"
              />
              <Form.Text muted>Макс 10 символов (для теста).</Form.Text>
            </Form.Group>

            <div className="d-flex flex-wrap gap-2">
              <Button variant="primary" onClick={onApplySymbols} disabled={wsStatus !== "connected"}>
                Apply
              </Button>
              <Button variant="outline-secondary" onClick={refreshSnapshot} disabled={wsStatus !== "connected"}>
                Refresh snapshot
              </Button>
              <Button variant="outline-primary" onClick={() => fetchBars("bybit")} disabled={wsStatus !== "connected"}>
                Fetch bars (BT)
              </Button>
              <Button variant="outline-primary" onClick={() => fetchBars("binance")} disabled={wsStatus !== "connected"}>
                Fetch bars (BNB)
              </Button>
              <Button variant="outline-success" onClick={fetchLeadLag} disabled={wsStatus !== "connected"}>
                Fetch lead-lag
              </Button>
            </div>

            <hr />

            <Form.Group>
              <Form.Label className="fw-semibold">Selected symbol</Form.Label>
              <Form.Select value={selected} onChange={(e) => setSelected(e.target.value)}>
                {symbols.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Form.Select>
            </Form.Group>

            <div className="mt-3">
              <div className="fw-semibold mb-2">Prices (BT / BNB)</div>
              <div style={{ maxHeight: 220, overflow: "auto" }}>
                <Table bordered size="sm" responsive className="m-0">
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Last (BT)</th>
                      <th>Last (BNB)</th>
                    </tr>
                  </thead>
                  <tbody style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                    {symbols.map((s) => (
                      <tr key={s} className={s === selected ? "table-active" : ""}>
                        <td>{s}</td>
                        <td>{Number.isFinite(bybitTickers?.[s]?.last) ? bybitTickers[s].last : "—"}</td>
                        <td>{Number.isFinite(binanceTickers?.[s]?.last) ? binanceTickers[s].last : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </div>

            <div className="mt-3">
              <div className="fw-semibold mb-1">Subscribed</div>
              <div
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                }}
              >
                {symbols.join(", ")}
              </div>
            </div>
          </Card.Body>
        </Card>
      </Col>

      <Col md={7}>
        <Card>
          <Card.Body>
            <div className="d-flex align-items-center justify-content-between mb-3">
              <div className="fw-semibold">Ticker: {selected}</div>
              <div
                className="text-muted"
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                }}
              >
                {selectedBybit?.receivedAt ? `BT ${new Date(selectedBybit.receivedAt).toLocaleTimeString()}` : "BT —"}
                {"  |  "}
                {selectedBinance?.receivedAt ? `BNB ${new Date(selectedBinance.receivedAt).toLocaleTimeString()}` : "BNB —"}
              </div>
            </div>

            <Row className="g-3">
              <Col md={6}>
                <div className="d-flex align-items-center justify-content-between mb-2">
                  <div className="fw-semibold">Bybit (BT)</div>
                  <Badge bg={statusVariant(bybitStatus?.status)}>{bybitStatus?.status || "unknown"}</Badge>
                </div>

                {!selectedBybit ? (
                  <div className="text-muted">Нет данных.</div>
                ) : (
                  <Table bordered size="sm" responsive>
                    <tbody
                      style={{
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                      }}
                    >
                      <tr><td>last</td><td>{selectedBybit.last ?? "—"}</td></tr>
                      <tr><td>bid</td><td>{selectedBybit.bid ?? "—"}</td></tr>
                      <tr><td>ask</td><td>{selectedBybit.ask ?? "—"}</td></tr>
                      <tr><td>mark</td><td>{selectedBybit.mark ?? "—"}</td></tr>
                      <tr><td>index</td><td>{selectedBybit.index ?? "—"}</td></tr>
                      <tr><td>funding</td><td>{selectedBybit.funding ?? "—"}</td></tr>
                      <tr><td>openInterest</td><td>{selectedBybit.openInterest ?? "—"}</td></tr>
                    </tbody>
                  </Table>
                )}
              </Col>

              <Col md={6}>
                <div className="d-flex align-items-center justify-content-between mb-2">
                  <div className="fw-semibold">Binance (BNB)</div>
                  <Badge bg={statusVariant(binanceStatus?.status)}>{binanceStatus?.status || "unknown"}</Badge>
                </div>

                {!selectedBinance ? (
                  <div className="text-muted">Нет данных.</div>
                ) : (
                  <Table bordered size="sm" responsive>
                    <tbody
                      style={{
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                      }}
                    >
                      <tr><td>last</td><td>{selectedBinance.last ?? "—"}</td></tr>
                      <tr><td>bid</td><td>{selectedBinance.bid ?? "—"}</td></tr>
                      <tr><td>ask</td><td>{selectedBinance.ask ?? "—"}</td></tr>
                      <tr><td>src</td><td>{selectedBinance.src ?? "binance"}</td></tr>
                    </tbody>
                  </Table>
                )}
              </Col>
            </Row>

            <hr />
            <div className="fw-semibold mb-2">Latest 250ms bar</div>
            <Row className="g-3">
              <Col md={6}>
                <div className="text-muted mb-1">BT</div>
                <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                  <pre className="m-0">{JSON.stringify(lastBybitBars[selected] || null, null, 2)}</pre>
                </div>
              </Col>
              <Col md={6}>
                <div className="text-muted mb-1">BNB</div>
                <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                  <pre className="m-0">{JSON.stringify(lastBinanceBars[selected] || null, null, 2)}</pre>
                </div>
              </Col>
            </Row>

            <hr />
            <div className="d-flex align-items-center justify-content-between mb-2">
              <div className="fw-semibold">Bars ({barsSource === "binance" ? "BNB" : "BT"}, last {bars.length})</div>
              <div className="text-muted" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                {barsSource}
              </div>
            </div>
            <div style={{ maxHeight: 220, overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
              <pre className="m-0">{JSON.stringify(bars.slice(-30), null, 2)}</pre>
            </div>

            <hr />
            <div className="d-flex align-items-center justify-content-between mb-2">
              <div className="fw-semibold">Lead-Lag (TOP 10)</div>
              <div
                className="text-muted"
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                }}
              >
                {leadLagTop?.length ? `${leadLagTop.length} rows` : "warming up"}
              </div>
            </div>

            <Table bordered size="sm" responsive>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Pair</th>
                  <th>Corr</th>
                  <th>Lag (Δt)</th>
                  <th>Подтверждение</th>
                </tr>
              </thead>
              <tbody style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                {leadLagTop && leadLagTop.length ? (
                  leadLagTop.map((r, idx) => {
                    const leaderTag = srcTag(r.leaderSrc);
                    const followerTag = srcTag(r.followerSrc);
                    return (
                      <tr key={`${r.leader}-${r.follower}-${idx}`}>
                        <td>{idx + 1}</td>
                        <td>
                          {r.leader} ({leaderTag}) → {r.follower} ({followerTag})
                        </td>
                        <td>{Number.isFinite(r.corr) ? r.corr.toFixed(3) : "—"}</td>
                        <td>{Number.isFinite(r.lagMs) ? `${(r.lagMs / 1000).toFixed(2)}s` : "—"}</td>
                        <td>
                          {r.confirmed ? "OK" : "—"}{" "}
                          <span className="text-muted">({r.samples ?? 0}samp, {r.impulses ?? 0}imp)</span>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={5} className="text-muted">
                      Нет расчётов ещё (нужно накопить ~15–20s микробаров).
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Card.Body>
        </Card>
      </Col>
    </Row>
  );
}
