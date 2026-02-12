import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Col, Form, Row, Table } from "react-bootstrap";
import { sourceTag } from "../../priceFormat.js";
import { useWsClient } from "../../shared/api/ws.js";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8080";

function toSymbolList(text) {
  return text.split(",").map((s) => s.trim().toUpperCase()).filter((s) => s && !s.includes("-")).map((s) => s.replaceAll("/", ""));
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

export default function BybitPage() {
  const pendingTickersRef = useRef(new Map());
  const selectedRef = useRef("BTCUSDT");

  const [bybitStatus, setBybitStatus] = useState({ status: "unknown" });
  const [binanceStatus, setBinanceStatus] = useState({ status: "unknown" });
  const [symbols, setSymbols] = useState(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  const [symbolsInput, setSymbolsInput] = useState("BTCUSDT,ETHUSDT,SOLUSDT");
  const [selected, setSelected] = useState("BTCUSDT");
  const [marketTickers, setMarketTickers] = useState({});
  const [barsSource, setBarsSource] = useState("BT");
  const [bars, setBars] = useState([]);
  const [leadLagTop, setLeadLagTop] = useState([]);

  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const onMessage = useMemo(() => (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    const type = msg?.type === "event" ? msg.topic : msg.type;
    const payload = msg?.payload;

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

    if (type === "market.snapshot" && Array.isArray(payload?.tickers)) {
      const merged = {};
      for (const t of payload.tickers) merged[tickerKey(t?.source, t?.symbol)] = t;
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
      if (typeof payload?.source === "string") setBarsSource(payload.source);
      if (Array.isArray(payload?.bars)) setBars(payload.bars);
      return;
    }
    if (type === "leadlag.top") {
      if (Array.isArray(payload)) setLeadLagTop(payload);
      else if (Array.isArray(payload?.rows)) setLeadLagTop(payload.rows);
      return;
    }
    if (type === "setSymbols.ack" && Array.isArray(payload?.symbols)) {
      const next = payload.symbols;
      setSymbols(next);
      setSymbolsInput(next.join(","));
      if (!next.includes(selectedRef.current)) setSelected(next[0] || "BTCUSDT");
    }
  }, []);

  const { wsUrl, status: wsStatus, sendJson } = useWsClient({ onOpen: () => {
      sendJson({ type: "getSnapshot" });
      sendJson({ type: "getStatus" });
    },
    onMessage,
  });

  useEffect(() => {
    const flushTimer = setInterval(() => {
      if (!pendingTickersRef.current.size) return;
      const updates = {};
      for (const [key, t] of pendingTickersRef.current.entries()) updates[key] = t;
      pendingTickersRef.current.clear();
      setMarketTickers((prev) => ({ ...prev, ...updates }));
    }, 250);
    return () => {
      clearInterval(flushTimer);
      pendingTickersRef.current.clear();
    };
  }, []);

  const onApplySymbols = () => {
    const next = toSymbolList(symbolsInput).slice(0, 50);
    if (!next.length) return;
    sendJson({ type: "setSymbols", symbols: next });
  };

  const refreshSnapshot = () => sendJson({ type: "getSnapshot" });
  const fetchBars = (source) => sendJson({ type: "getBars", symbol: selectedRef.current || "BTCUSDT", n: 200, source });
  const fetchLeadLag = () => sendJson({ type: "getLeadLagTop", n: 10 });

  const priceRows = useMemo(() => Object.values(marketTickers)
    .filter((t) => t?.symbol && t?.source)
    .sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)) || sourceTag(a.source).localeCompare(sourceTag(b.source))), [marketTickers]);

  return (
    <Row className="g-3">
      <Col md={4}>
        <Card><Card.Body>
          <div className="d-flex flex-wrap gap-2 mb-3"><Badge bg={statusVariant(wsStatus)}>WS: {wsStatus}</Badge><Badge bg={statusVariant(bybitStatus?.status)}>Bybit: {bybitStatus?.status || "unknown"}</Badge><Badge bg={statusVariant(binanceStatus?.status)}>Binance: {binanceStatus?.status || "unknown"}</Badge></div>
          <Form.Group className="mb-3"><Form.Label className="fw-semibold">Symbols (comma-separated)</Form.Label><Form.Control value={symbolsInput} onChange={(e) => setSymbolsInput(e.target.value)} placeholder="BTCUSDT,ETHUSDT,SOLUSDT" /><Form.Text className="text-muted">До 50 символов, / удаляется, символы с '-' игнорируются.</Form.Text></Form.Group>
          <div className="d-flex flex-wrap gap-2 mb-3"><Button variant="primary" onClick={onApplySymbols} disabled={wsStatus !== "connected"}>Apply</Button><Button variant="outline-secondary" onClick={refreshSnapshot} disabled={wsStatus !== "connected"}>Refresh snapshot</Button></div>
          <Form.Group className="mb-3"><Form.Label className="fw-semibold">Selected symbol</Form.Label><Form.Select value={selected} onChange={(e) => setSelected(e.target.value)}>{symbols.map((s) => <option key={s}>{s}</option>)}</Form.Select></Form.Group>
          <div className="d-flex gap-2"><Button variant="outline-primary" onClick={() => fetchBars("BT")} disabled={wsStatus !== "connected"}>Bars BT</Button><Button variant="outline-primary" onClick={() => fetchBars("BNB")} disabled={wsStatus !== "connected"}>Bars BNB</Button><Button variant="outline-secondary" onClick={fetchLeadLag} disabled={wsStatus !== "connected"}>LeadLag Top</Button></div>
          <div className="text-muted mt-2 small">WS URL: {wsUrl}</div>
        </Card.Body></Card>
      </Col>
      <Col md={8}>
        <Card className="mb-3"><Card.Body><div className="fw-semibold mb-2">Market tickers ({priceRows.length})</div><div style={{ maxHeight: 320, overflow: "auto" }}><Table size="sm" hover><thead><tr><th>Symbol</th><th>Source</th><th>Mid/Last</th><th>Bid</th><th>Ask</th></tr></thead><tbody>{priceRows.map((t, i) => <tr key={`${t.symbol}-${t.source}-${i}`}><td>{t.symbol}</td><td>{sourceTag(t.source)}</td><td>{displayPrice(t)}</td><td>{displayPrice({ mid: t.bid1Price })}</td><td>{displayPrice({ mid: t.ask1Price })}</td></tr>)}</tbody></Table></div></Card.Body></Card>
        <Card className="mb-3"><Card.Body><div className="fw-semibold mb-2">Bars ({barsSource})</div><div style={{ maxHeight: 260, overflow: "auto" }}><Table size="sm"><thead><tr><th>t</th><th>o</th><th>h</th><th>l</th><th>c</th></tr></thead><tbody>{bars.map((b, i) => <tr key={i}><td>{b.t}</td><td>{b.o}</td><td>{b.h}</td><td>{b.l}</td><td>{b.c}</td></tr>)}</tbody></Table></div></Card.Body></Card>
        <Card><Card.Body><div className="fw-semibold mb-2">LeadLag top</div><Table size="sm"><thead><tr><th>#</th><th>Leader</th><th>Follower</th><th>Score</th></tr></thead><tbody>{leadLagTop.map((r, i) => <tr key={i}><td>{i + 1}</td><td>{r.leader}</td><td>{r.follower}</td><td>{r.score}</td></tr>)}</tbody></Table></Card.Body></Card>
      </Col>
    </Row>
  );
}
