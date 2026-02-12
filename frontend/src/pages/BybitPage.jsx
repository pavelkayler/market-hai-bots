// frontend/src/pages/BybitPage.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Col, Form, Row, Table } from "react-bootstrap";
import { formatPriceWithSource, sourceTag } from "../priceFormat.js";

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

function tickerKey(source, symbol) {
  return `${sourceTag(source)}:${String(symbol || "").toUpperCase()}`;
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

  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const [marketTickers, setMarketTickers] = useState({});

  const [lastBybitBars, setLastBybitBars] = useState({});
  const [lastBinanceBars, setLastBinanceBars] = useState({});
  const [barsSource, setBarsSource] = useState("bybit");
  const [bars, setBars] = useState([]);

  const [leadLagTop, setLeadLagTop] = useState([]);

  const wsUrl = useMemo(() => toWsUrl(API_BASE), []);

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setWsStatus("connecting");

    const flushTimer = setInterval(() => {
      if (!pendingTickersRef.current.size) return;
      const updates = {};
      for (const [key, t] of pendingTickersRef.current.entries()) updates[key] = t;
      pendingTickersRef.current.clear();
      setMarketTickers((prev) => ({ ...prev, ...updates }));
    }, 300);

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

      if (msg.type === "market.snapshot") {
        const arr = msg.payload?.tickers;
        if (!Array.isArray(arr)) return;
        const merged = {};
        for (const t of arr) merged[tickerKey(t?.source, t?.symbol)] = t;
        setMarketTickers((prev) => ({ ...prev, ...merged }));
        return;
      }

      if (msg.type === "market.ticker") {
        const t = msg.payload;
        if (!t?.symbol) return;
        pendingTickersRef.current.set(tickerKey(t?.source, t?.symbol), t);
        return;
      }

      if (msg.type === "bybit.status") return setBybitStatus(msg.payload || { status: "unknown" });
      if (msg.type === "binance.status") return setBinanceStatus(msg.payload || { status: "unknown" });

      if (msg.type === "bybit.bar") {
        const b = msg.payload;
        if (b?.symbol) setLastBybitBars((prev) => ({ ...prev, [b.symbol]: b }));
        return;
      }

      if (msg.type === "binance.bar") {
        const b = msg.payload;
        if (b?.symbol) setLastBinanceBars((prev) => ({ ...prev, [b.symbol]: b }));
        return;
      }

      if (msg.type === "bars") {
        const p = msg.payload || {};
        if (typeof p.source === "string") setBarsSource(p.source);
        if (Array.isArray(p.bars)) setBars(p.bars);
        return;
      }

      if (msg.type === "leadlag.top" && Array.isArray(msg.payload)) {
        setLeadLagTop(msg.payload);
        return;
      }

      if (msg.type === "setSymbols.ack") {
        const next = msg.payload?.symbols;
        if (Array.isArray(next)) {
          setSymbols(next);
          setSymbolsInput(next.join(","));
          if (!next.includes(selectedRef.current)) setSelected(next[0] || "BTCUSDT");
        }
      }
    };

    return () => {
      clearInterval(flushTimer);
      try { ws.close(); } catch { /* ignore */ }
    };
  }, [wsUrl]);

  const selectedBybit = useMemo(() => marketTickers[tickerKey("BT", selected)] || null, [marketTickers, selected]);
  const selectedBinance = useMemo(() => marketTickers[tickerKey("BNB", selected)] || null, [marketTickers, selected]);

  const onApplySymbols = () => {
    const next = toSymbolList(symbolsInput).slice(0, 100);
    if (!next.length) return;
    try { wsRef.current?.send(JSON.stringify({ type: "setSymbols", symbols: next })); } catch { /* ignore */ }
  };

  const refreshSnapshot = () => {
    try { wsRef.current?.send(JSON.stringify({ type: "getSnapshot" })); } catch { /* ignore */ }
  };
  const fetchBars = (source) => {
    try { wsRef.current?.send(JSON.stringify({ type: "getBars", symbol: selected, n: 200, source })); } catch { /* ignore */ }
  };
  const fetchLeadLag = () => {
    try { wsRef.current?.send(JSON.stringify({ type: "getLeadLagTop", n: 10 })); } catch { /* ignore */ }
  };

  return (
    <Row className="g-3">
      <Col md={5}><Card><Card.Body>
        <div className="d-flex align-items-center justify-content-between mb-3">
          <div className="d-flex align-items-center gap-2"><div className="fw-semibold">Backend WS</div>
            <Badge bg={wsStatus === "connected" ? "success" : wsStatus === "connecting" ? "warning" : "secondary"}>{wsStatus}</Badge></div>
          <div className="d-flex align-items-center gap-3">
            <div className="d-flex align-items-center gap-2"><div className="fw-semibold">Bybit</div><Badge bg={statusVariant(bybitStatus?.status)}>{bybitStatus?.status || "unknown"}</Badge></div>
            <div className="d-flex align-items-center gap-2"><div className="fw-semibold">Binance</div><Badge bg={statusVariant(binanceStatus?.status)}>{binanceStatus?.status || "unknown"}</Badge></div>
          </div>
        </div>

        <Form.Group className="mb-2"><Form.Label className="fw-semibold">Symbols (comma-separated)</Form.Label>
          <Form.Control value={symbolsInput} onChange={(e) => setSymbolsInput(e.target.value)} placeholder="BTCUSDT,ETHUSDT,SOLUSDT" />
          <Form.Text muted>До 100 символов.</Form.Text>
        </Form.Group>

        <div className="d-flex flex-wrap gap-2">
          <Button variant="primary" onClick={onApplySymbols} disabled={wsStatus !== "connected"}>Apply</Button>
          <Button variant="outline-secondary" onClick={refreshSnapshot} disabled={wsStatus !== "connected"}>Refresh snapshot</Button>
          <Button variant="outline-primary" onClick={() => fetchBars("bybit")} disabled={wsStatus !== "connected"}>Fetch bars (BT)</Button>
          <Button variant="outline-primary" onClick={() => fetchBars("binance")} disabled={wsStatus !== "connected"}>Fetch bars (BNB)</Button>
          <Button variant="outline-success" onClick={fetchLeadLag} disabled={wsStatus !== "connected"}>Fetch lead-lag</Button>
        </div>

        <hr />
        <Form.Group><Form.Label className="fw-semibold">Selected symbol</Form.Label>
          <Form.Select value={selected} onChange={(e) => setSelected(e.target.value)}>{symbols.map((s) => <option key={s} value={s}>{s}</option>)}</Form.Select>
        </Form.Group>

        <div className="mt-3"><div className="fw-semibold mb-2">Prices</div>
          <div style={{ maxHeight: 260, overflow: "auto" }}>
            <Table bordered size="sm" responsive className="m-0"><thead><tr><th>Symbol</th><th>BT</th><th>BNB</th></tr></thead>
              <tbody style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
                {symbols.map((s) => (
                  <tr key={s} className={s === selected ? "table-active" : ""}><td>{s}</td>
                    <td>{formatPriceWithSource(marketTickers[tickerKey("BT", s)])}</td>
                    <td>{formatPriceWithSource(marketTickers[tickerKey("BNB", s)])}</td>
                  </tr>
                ))}
              </tbody></Table>
          </div>
        </div>
      </Card.Body></Card></Col>

      <Col md={7}><Card><Card.Body>
        <div className="d-flex align-items-center justify-content-between mb-3">
          <div className="fw-semibold">Ticker: {selected}</div>
          <div className="text-muted" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
            {selectedBybit?.ts ? `BT ${new Date(selectedBybit.ts).toLocaleTimeString()}` : "BT —"}  |  {selectedBinance?.ts ? `BNB ${new Date(selectedBinance.ts).toLocaleTimeString()}` : "BNB —"}
          </div>
        </div>

        <Row className="g-3">
          <Col md={6}><Table bordered size="sm" responsive><tbody style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
            <tr><td>price</td><td>{formatPriceWithSource(selectedBybit)}</td></tr><tr><td>bid/ask/mid</td><td>{selectedBybit ? `${selectedBybit.bid ?? "—"}/${selectedBybit.ask ?? "—"}/${selectedBybit.mid ?? "—"}` : "—"}</td></tr>
          </tbody></Table></Col>
          <Col md={6}><Table bordered size="sm" responsive><tbody style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
            <tr><td>price</td><td>{formatPriceWithSource(selectedBinance)}</td></tr><tr><td>bid/ask/mid</td><td>{selectedBinance ? `${selectedBinance.bid ?? "—"}/${selectedBinance.ask ?? "—"}/${selectedBinance.mid ?? "—"}` : "—"}</td></tr>
          </tbody></Table></Col>
        </Row>

        <hr /><div className="fw-semibold mb-2">Latest 250ms bar</div>
        <Row className="g-3"><Col md={6}><div className="text-muted mb-1">BT</div><pre className="m-0">{JSON.stringify(lastBybitBars[selected] || null, null, 2)}</pre></Col><Col md={6}><div className="text-muted mb-1">BNB</div><pre className="m-0">{JSON.stringify(lastBinanceBars[selected] || null, null, 2)}</pre></Col></Row>

        <hr />
        <div className="d-flex align-items-center justify-content-between mb-2"><div className="fw-semibold">Bars ({barsSource === "binance" ? "BNB" : "BT"}, last {bars.length})</div><div className="text-muted" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>{barsSource}</div></div>
        <div style={{ maxHeight: 220, overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}><pre className="m-0">{JSON.stringify(bars.slice(-30), null, 2)}</pre></div>

        <hr />
        <div className="d-flex align-items-center justify-content-between mb-2"><div className="fw-semibold">Lead-Lag (TOP 10)</div><div className="text-muted" style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>{leadLagTop?.length ? `${leadLagTop.length} rows` : "warming up"}</div></div>
        <Table bordered size="sm" responsive><thead><tr><th>#</th><th>Pair</th><th>Corr</th><th>Lag (Δt)</th><th>Подтверждение</th></tr></thead>
          <tbody style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace" }}>
            {leadLagTop && leadLagTop.length ? leadLagTop.map((r, idx) => (
              <tr key={`${r.leader}-${r.follower}-${idx}`}><td>{idx + 1}</td><td>{r.leader} ({sourceTag(r.leaderSrc)}) → {r.follower} ({sourceTag(r.followerSrc)}) <span className="text-muted">[{sourceTag(r.source)}]</span></td><td>{Number.isFinite(r.corr) ? r.corr.toFixed(3) : "—"}</td><td>{Number.isFinite(r.lagMs) ? `${(r.lagMs / 1000).toFixed(2)}s` : "—"}</td><td>{r.confirmed ? "OK" : "—"} <span className="text-muted">({r.samples ?? 0}samp, {r.impulses ?? 0}imp)</span></td></tr>
            )) : <tr><td colSpan={5} className="text-muted">Нет расчётов ещё (нужно накопить ~15–20s микробаров).</td></tr>}
          </tbody></Table>
      </Card.Body></Card></Col>
    </Row>
  );
}
