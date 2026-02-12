// frontend/src/pages/BybitPage.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Col, Form, Row, Table } from "react-bootstrap";
import { sourceTag } from "../priceFormat.js";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";

function toWsUrl(apiBase) {
  const u = new URL(apiBase);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/ws`;
}

function toSymbolList(text) {
  return text
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s && !s.includes("-"))
    .map((s) => s.replaceAll("/", ""));
}

function statusVariant(s) {
  if (s === "connected") return "success";
  if (s === "connecting") return "warning";
  return "secondary";
}

function tickerKey(source, symbol) {
  return `${sourceTag(source)}:${String(symbol || "").toUpperCase()}`;
}

function displayPrice(ticker) {
  const px = ticker?.mid ?? ticker?.last;
  if (!Number.isFinite(px)) return "—";
  return `${px}`;
}

function eventType(msg) {
  if (msg?.type === "event" && typeof msg.topic === "string") return msg.topic;
  return msg?.type;
}

function eventPayload(msg) {
  if (msg?.type === "event") return msg.payload;
  return msg?.payload;
}

export default function BybitPage() {
  const wsRef = useRef(null);
  const pendingTickersRef = useRef(new Map());
  const selectedRef = useRef("BTCUSDT");

  const [wsStatus, setWsStatus] = useState("disconnected");
  const [bybitStatus, setBybitStatus] = useState({ status: "unknown" });
  const [binanceStatus, setBinanceStatus] = useState({ status: "unknown" });
  const [symbols, setSymbols] = useState(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  const [symbolsInput, setSymbolsInput] = useState("BTCUSDT,ETHUSDT,SOLUSDT");
  const [selected, setSelected] = useState("BTCUSDT");
  const [marketTickers, setMarketTickers] = useState({});
  const [barsSource, setBarsSource] = useState("BT");
  const [bars, setBars] = useState([]);
  const [leadLagTop, setLeadLagTop] = useState([]);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const wsUrl = useMemo(() => toWsUrl(API_BASE), [API_BASE]);

  useEffect(() => {
    let shouldClose = false;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    const flushTimer = setInterval(() => {
      if (!pendingTickersRef.current.size) return;
      const updates = {};
      for (const [key, t] of pendingTickersRef.current.entries()) updates[key] = t;
      pendingTickersRef.current.clear();
      setMarketTickers((prev) => ({ ...prev, ...updates }));
    }, 250);

    ws.onopen = () => {
      if (shouldClose) {
        try { ws.close(1000, "cleanup"); } catch { /* ignore */ }
        return;
      }
      setWsStatus("connected");
      try {
        ws.send(JSON.stringify({ type: "getSnapshot" }));
        ws.send(JSON.stringify({ type: "getStatus" }));
      } catch {
        // ignore
      }
    };
    ws.onclose = () => setWsStatus("disconnected");
    ws.onerror = () => setWsStatus("error");

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      const type = eventType(msg);
      const payload = eventPayload(msg);

      if (type === "snapshot") {
        const p = payload || {};
        if (p.bybit) setBybitStatus(p.bybit);
        if (p.binance) setBinanceStatus(p.binance);
        if (Array.isArray(p.symbols)) {
          setSymbols(p.symbols);
          setSymbolsInput(p.symbols.join(","));
          if (!p.symbols.includes(selectedRef.current)) setSelected(p.symbols[0] || "BTCUSDT");
        }
        if (Array.isArray(p.marketTickers)) {
          const merged = {};
          for (const t of p.marketTickers) merged[tickerKey(t?.source, t?.symbol)] = t;
          setMarketTickers(merged);
        }
        if (Array.isArray(p.leadLagTop)) setLeadLagTop(p.leadLagTop);
        return;
      }

      if (type === "market.snapshot") {
        const arr = payload?.tickers;
        if (!Array.isArray(arr)) return;
        const merged = {};
        for (const t of arr) merged[tickerKey(t?.source, t?.symbol)] = t;
        setMarketTickers((prev) => ({ ...prev, ...merged }));
        return;
      }

      if (type === "market.ticker") {
        const t = payload;
        if (!t?.symbol) return;
        pendingTickersRef.current.set(tickerKey(t?.source, t?.symbol), t);
        return;
      }

      if (type === "bybit.status") return setBybitStatus(payload || { status: "unknown" });
      if (type === "binance.status") return setBinanceStatus(payload || { status: "unknown" });

      if (type === "bars") {
        const p = payload || {};
        if (typeof p.source === "string") setBarsSource(p.source);
        if (Array.isArray(p.bars)) setBars(p.bars);
        return;
      }

      if (type === "leadlag.top") {
        if (Array.isArray(payload)) {
          setLeadLagTop(payload);
          return;
        }
        if (Array.isArray(payload?.rows)) {
          setLeadLagTop(payload.rows);
        }
      }

      if (type === "setSymbols.ack") {
        const next = payload?.symbols;
        if (!Array.isArray(next)) return;
        setSymbols(next);
        setSymbolsInput(next.join(","));
        if (!next.includes(selectedRef.current)) setSelected(next[0] || "BTCUSDT");
      }
    };

    return () => {
      shouldClose = true;
      clearInterval(flushTimer);
      pendingTickersRef.current.clear();
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.close(1000, "cleanup");
        } catch {
          // ignore
        }
      }
    };
  }, [wsUrl]);

  const onApplySymbols = () => {
    const next = toSymbolList(symbolsInput).slice(0, 100);
    if (!next.length) return;
    try {
      wsRef.current?.send(JSON.stringify({ type: "setSymbols", symbols: next }));
    } catch {
      // ignore
    }
  };

  const refreshSnapshot = () => {
    try {
      wsRef.current?.send(JSON.stringify({ type: "getSnapshot" }));
    } catch {
      // ignore
    }
  };

  const fetchBars = (source) => {
    const symbol = selectedRef.current || "BTCUSDT";
    try {
      wsRef.current?.send(JSON.stringify({ type: "getBars", symbol, n: 200, source }));
    } catch {
      // ignore
    }
  };

  const fetchLeadLag = () => {
    try {
      wsRef.current?.send(JSON.stringify({ type: "getLeadLagTop", n: 10 }));
    } catch {
      // ignore
    }
  };

  const priceRows = useMemo(() => {
    const rows = [];
    for (const t of Object.values(marketTickers)) {
      if (!t?.symbol || !t?.source) continue;
      rows.push(t);
    }
    rows.sort((a, b) => {
      const sym = String(a.symbol).localeCompare(String(b.symbol));
      if (sym !== 0) return sym;
      return sourceTag(a.source).localeCompare(sourceTag(b.source));
    });
    return rows;
  }, [marketTickers]);

  return (
    <Row className="g-3">
      <Col md={4}>
        <Card>
          <Card.Body>
            <div className="d-flex flex-wrap gap-2 mb-3">
              <Badge bg={statusVariant(wsStatus)}>WS: {wsStatus}</Badge>
              <Badge bg={statusVariant(bybitStatus?.status)}>Bybit: {bybitStatus?.status || "unknown"}</Badge>
              <Badge bg={statusVariant(binanceStatus?.status)}>Binance: {binanceStatus?.status || "unknown"}</Badge>
            </div>

            <Form.Group className="mb-3">
              <Form.Label className="fw-semibold">Symbols (comma-separated)</Form.Label>
              <Form.Control
                value={symbolsInput}
                onChange={(e) => setSymbolsInput(e.target.value)}
                placeholder="BTCUSDT,ETHUSDT,SOLUSDT"
              />
              <Form.Text className="text-muted">До 100 символов, / удаляется, символы с '-' игнорируются.</Form.Text>
            </Form.Group>

            <div className="d-flex flex-wrap gap-2 mb-3">
              <Button variant="primary" onClick={onApplySymbols} disabled={wsStatus !== "connected"}>Apply</Button>
              <Button variant="outline-secondary" onClick={refreshSnapshot} disabled={wsStatus !== "connected"}>Refresh snapshot</Button>
              <Button variant="outline-primary" onClick={() => fetchBars("bybit")} disabled={wsStatus !== "connected"}>Fetch bars (BT)</Button>
              <Button variant="outline-primary" onClick={() => fetchBars("binance")} disabled={wsStatus !== "connected"}>Fetch bars (BNB)</Button>
              <Button variant="outline-success" onClick={fetchLeadLag} disabled={wsStatus !== "connected"}>Fetch lead-lag</Button>
            </div>

            <Form.Group>
              <Form.Label className="fw-semibold">Selected symbol</Form.Label>
              <Form.Select value={selected} onChange={(e) => setSelected(e.target.value)}>
                {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
              </Form.Select>
            </Form.Group>

            <hr />
            <div className="fw-semibold mb-2">Bars ({barsSource}, last {bars.length})</div>
            <div style={{ maxHeight: 200, overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
              <pre className="m-0">{JSON.stringify(bars.slice(-20), null, 2)}</pre>
            </div>
          </Card.Body>
        </Card>
      </Col>

      <Col md={8}>
        <Card className="mb-3">
          <Card.Body>
            <div className="fw-semibold mb-2">Цены</div>
            <div style={{ maxHeight: 320, overflow: "auto" }}>
              <Table bordered size="sm" responsive className="m-0">
                <thead>
                  <tr><th>Symbol</th><th>Price</th><th>Source</th></tr>
                </thead>
                <tbody style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                  {priceRows.map((t) => (
                    <tr key={tickerKey(t.source, t.symbol)} className={selected === t.symbol ? "table-active" : ""}>
                      <td>{t.symbol}</td>
                      <td>{displayPrice(t)} ({sourceTag(t.source)})</td>
                      <td>{sourceTag(t.source)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Card.Body>
        </Card>

        <Card>
          <Card.Body>
            <div className="fw-semibold mb-2">Лид-лаг TOP-10 (BNB)</div>
            <Table bordered size="sm" responsive className="m-0">
              <thead>
                <tr>
                  <th>Leader</th><th>Follower</th><th>Corr (Корреляция)</th><th>Lag (Δt)</th><th>Подтверждение</th><th>TradeReady</th><th>Blockers</th>
                </tr>
              </thead>
              <tbody style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}>
                {leadLagTop.length ? leadLagTop.slice(0, 10).map((r, idx) => (
                  <tr key={`${r.leader}-${r.follower}-${idx}`}>
                    <td>{r.leader} ({sourceTag(r.source)})</td>
                    <td>{r.follower} ({sourceTag(r.source)})</td>
                    <td>{Number.isFinite(r.corr) ? r.corr.toFixed(3) : "—"}</td>
                    <td>{Number.isFinite(r.lagMs) ? `${r.lagMs}ms` : "—"}</td>
                    <td>{r.confirmed ? "✅" : "—"} <span className="text-muted">({r.samples ?? 0}/{r.impulses ?? 0})</span></td>
                    <td>{r.tradeReady ? <Badge bg="success">ready</Badge> : <Badge bg="secondary">wait</Badge>}</td>
                    <td className="small">{Array.isArray(r.blockers) ? r.blockers.map((b) => b.key).slice(0, 3).join("; ") : "—"}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={7} className="text-muted">Нет расчётов ещё (нужно накопить ~50s микробаров).</td></tr>
                )}
              </tbody>
            </Table>
          </Card.Body>
        </Card>
      </Col>
    </Row>
  );
}
