import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, NavLink, Route, Routes, Navigate } from "react-router-dom";
import { Badge, Button, Card, Container, Form, Nav, Navbar, Row, Col, Table, Tabs, Tab } from "react-bootstrap";
import type {
  BotRunState,
  BotSnapshot,
  WsServerMessage,
  WsClientMessage,
  UniverseConfig,
  UniverseRow,
  PaperOrder,
  PaperPosition,
  SortState,
  TradeResultRow,
} from "../contracts.ts";
import { defaultUniverseConfig } from "../contracts.ts";

type WsStatus = "CONNECTED" | "DISCONNECTED";

function msToMskString(ms: number): string {
  // MSK = UTC+3 fixed
  const d = new Date(ms + 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function toggleSort<T>(prev: SortState<T>, key: keyof T): SortState<T> {
  if (prev.key === key) return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
  return { key, dir: "asc" };
}

function sortBy<T>(rows: T[], sort: SortState<T>): T[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  const key = sort.key as string;
  return [...rows].sort((a: any, b: any) => {
    const av = a[key];
    const bv = b[key];
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
  });
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return <Badge bg={ok ? "success" : "secondary"}>{label}</Badge>;
}

function useWsSnapshot() {
  const [wsStatus, setWsStatus] = useState<WsStatus>("DISCONNECTED");
  const [snapshot, setSnapshot] = useState<BotSnapshot | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const wsSend = (msg: WsClientMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  };

  const doRefresh = () => wsSend({ type: "REFRESH_SNAPSHOT" });

  useEffect(() => {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setWsStatus("CONNECTED");
    ws.onclose = () => setWsStatus("DISCONNECTED");
    ws.onerror = () => setWsStatus("DISCONNECTED");
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WsServerMessage;
        if (msg.type === "SNAPSHOT") setSnapshot(msg.snapshot);
      } catch {}
    };

    return () => {
      try {
        ws.close();
      } catch {}
      wsRef.current = null;
    };
  }, []);

  // UI refresh every 5s
  useEffect(() => {
    const t = setInterval(() => doRefresh(), 5000);
    return () => clearInterval(t);
  }, []);

  return { wsStatus, snapshot, wsSend, doRefresh };
}

function HomePage({
  snapshot,
  wsStatus,
  doRefresh,
  positionsSort,
  setPositionsSort,
  ordersSort,
  setOrdersSort,
}: {
  snapshot: BotSnapshot | null;
  wsStatus: WsStatus;
  doRefresh: () => void;
  positionsSort: SortState<PaperPosition>;
  setPositionsSort: React.Dispatch<React.SetStateAction<SortState<PaperPosition>>>;
  ordersSort: SortState<PaperOrder>;
  setOrdersSort: React.Dispatch<React.SetStateAction<SortState<PaperOrder>>>;
}) {
  const botRunState: BotRunState = snapshot?.botRunState ?? "STOPPED";
  const b2bOk = snapshot?.connections.backendToBybit === "CONNECTED";
  const f2bOk = wsStatus === "CONNECTED";

  const positions = sortBy(snapshot?.openPositions ?? [], positionsSort);
  const orders = sortBy(snapshot?.openOrders ?? [], ordersSort);

  return (
    <Container className="py-3">
      <Row className="align-items-center mb-3">
        <Col>
          <h2 className="mb-0">Home</h2>
        </Col>
        <Col className="text-end">
          <Button variant="outline-primary" size="sm" onClick={doRefresh}>
            Refresh
          </Button>
          <span className="ms-2 text-muted" style={{ fontSize: 12 }}>
            UI refresh: every 5s
          </span>
        </Col>
      </Row>

      <Card className="mb-3">
        <Card.Header>Connections</Card.Header>
        <Card.Body>
          <Row className="g-3">
            <Col md="4">
              <div className="d-flex justify-content-between align-items-center">
                <span>Frontend ↔ Backend WS</span>
                <StatusBadge ok={f2bOk} label={wsStatus} />
              </div>
            </Col>
            <Col md="4">
              <div className="d-flex justify-content-between align-items-center">
                <span>Backend ↔ Bybit WS</span>
                <StatusBadge ok={!!b2bOk} label={snapshot?.connections.backendToBybit ?? "DISCONNECTED"} />
              </div>
            </Col>
            <Col md="4">
              <div className="d-flex justify-content-between align-items-center">
                <span>Bot</span>
                <StatusBadge ok={botRunState === "RUNNING"} label={botRunState} />
              </div>
            </Col>
          </Row>
          <div className="mt-2 text-muted" style={{ fontSize: 12 }}>
            Server time (MSK): {snapshot ? msToMskString(snapshot.serverTimeMs) : "—"}
          </div>
        </Card.Body>
      </Card>

      <Card className="mb-3">
        <Card.Header>Bot summary</Card.Header>
        <Card.Body>
          <Row className="g-3">
            <Col md="4">
              <div>
                <b>Universe</b>
              </div>
              <div>Total eligible: {snapshot?.universe.totalSymbols ?? 0}</div>
              <div>Selected: {snapshot?.universe.selectedSymbols ?? 0}</div>
            </Col>
            <Col md="4">
              <div>
                <b>Paper</b>
              </div>
              <div>Open positions: {snapshot?.openPositions.length ?? 0}</div>
              <div>Open orders: {snapshot?.openOrders.length ?? 0}</div>
            </Col>
            <Col md="4">
              <div>
                <b>Config</b>
              </div>
              <div>TF: {snapshot?.configs.botConfig.timeframe ?? "—"}</div>
              <div>
                Margin: {snapshot?.configs.botConfig.marginUSDT ?? "—"} | Lev: {snapshot?.configs.botConfig.leverage ?? "—"}
              </div>
            </Col>
          </Row>
        </Card.Body>
      </Card>

      <Card className="mb-3">
        <Card.Header>Open positions (paper)</Card.Header>
        <Card.Body style={{ overflowX: "auto" }}>
          <Table striped bordered hover size="sm" className="mb-0">
            <thead>
              <tr>
                <th role="button" onClick={() => setPositionsSort((p) => toggleSort(p, "symbol"))}>
                  Symbol
                </th>
                <th role="button" className="text-end" onClick={() => setPositionsSort((p) => toggleSort(p, "side"))}>
                  Side
                </th>
                <th role="button" className="text-end" onClick={() => setPositionsSort((p) => toggleSort(p, "entryPrice"))}>
                  Entry
                </th>
                <th role="button" className="text-end" onClick={() => setPositionsSort((p) => toggleSort(p, "qty"))}>
                  Qty
                </th>
                <th className="text-end">Fees</th>
                <th role="button" className="text-end" onClick={() => setPositionsSort((p) => toggleSort(p, "pnlUSDT"))}>
                  PnL
                </th>
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-muted">
                    No open positions
                  </td>
                </tr>
              ) : (
                positions.map((p) => (
                  <tr key={p.id}>
                    <td>{p.symbol}</td>
                    <td className="text-end">{p.side}</td>
                    <td className="text-end">{p.entryPrice.toFixed(4)}</td>
                    <td className="text-end">{p.qty.toFixed(6)}</td>
                    <td className="text-end">{((p.entryFeeUSDT ?? 0) + (p.exitFeeUSDT ?? 0)).toFixed(4)}</td>
                    <td className="text-end">
                      {(p.pnlUSDT ?? 0).toFixed(4)} ({(p.pnlRoiPct ?? 0).toFixed(2)}%)
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </Card.Body>
      </Card>

      <Card className="mb-3">
        <Card.Header>Open orders (paper)</Card.Header>
        <Card.Body style={{ overflowX: "auto" }}>
          <Table striped bordered hover size="sm" className="mb-0">
            <thead>
              <tr>
                <th role="button" onClick={() => setOrdersSort((p) => toggleSort(p, "symbol"))}>
                  Symbol
                </th>
                <th role="button" className="text-end" onClick={() => setOrdersSort((p) => toggleSort(p, "side"))}>
                  Side
                </th>
                <th role="button" className="text-end" onClick={() => setOrdersSort((p) => toggleSort(p, "entryPrice"))}>
                  Entry Price
                </th>
                <th role="button" className="text-end" onClick={() => setOrdersSort((p) => toggleSort(p, "status"))}>
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-muted">
                    No open orders
                  </td>
                </tr>
              ) : (
                orders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.symbol}</td>
                    <td className="text-end">{o.side}</td>
                    <td className="text-end">{o.entryPrice.toFixed(4)}</td>
                    <td className="text-end">{o.status}</td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </Card.Body>
      </Card>
    </Container>
  );
}

function DashboardPage({
  snapshot,
  wsStatus,
  wsSend,
  doRefresh,
}: {
  snapshot: BotSnapshot | null;
  wsStatus: WsStatus;
  wsSend: (m: WsClientMessage) => void;
  doRefresh: () => void;
}) {
  const botRunState: BotRunState = snapshot?.botRunState ?? "STOPPED";

  const [tab, setTab] = useState<"BOT" | "UNIVERSE" | "RESULTS" | "HISTORY" | "FUNDING" | "SIGNALS">("BOT");
  const [universeDraft, setUniverseDraft] = useState<UniverseConfig>(snapshot?.configs.universeConfig ?? defaultUniverseConfig);
  const [universeName, setUniverseName] = useState<string>("");

  const [universeSort, setUniverseSort] = useState<SortState<UniverseRow>>({ key: "symbol", dir: "asc" });
  const [resultsSort, setResultsSort] = useState<SortState<TradeResultRow>>({ key: "netPnlUSDT", dir: "desc" });
  const [historySort, setHistorySort] = useState<SortState<any>>({ key: "closedAtMs", dir: "desc" });
  const [fundingSort, setFundingSort] = useState<SortState<any>>({ key: "bucket", dir: "asc" });
  const [signalsSort, setSignalsSort] = useState<SortState<any>>({ key: "lastSignalAtMs", dir: "desc" });

  useEffect(() => {
    if (snapshot) setUniverseDraft(snapshot.configs.universeConfig);
  }, [snapshot?.configs.universeConfig?.minTurnoverUSDT, snapshot?.configs.universeConfig?.minVolatilityPct]);

  const saveUniverseConfig = () => wsSend({ type: "SET_UNIVERSE_CONFIG", config: universeDraft });
  const sendSetRunState = (state: BotRunState) => wsSend({ type: "SET_BOT_RUN_STATE", state });
  const sendKillAll = () => wsSend({ type: "KILL_ALL" });
  const sendResetAll = () => wsSend({ type: "RESET_ALL" });
  const sendSaveUniversePreset = (name?: string) => wsSend({ type: "SAVE_UNIVERSE_PRESET", name });
  const sendRemoveUniverseSymbol = (symbol: string) => wsSend({ type: "REMOVE_UNIVERSE_SYMBOL", symbol });
  const sendRefreshSignals = () => wsSend({ type: "REFRESH_SIGNALS" } as any);

  const universeRows = useMemo(() => sortBy(snapshot?.symbols ?? [], universeSort), [snapshot?.symbols, universeSort]);
  const resultRows = useMemo(() => sortBy(snapshot?.tradeResults ?? [], resultsSort), [snapshot?.tradeResults, resultsSort]);
  const historyRows = useMemo(() => sortBy(snapshot?.tradeHistory ?? [], historySort), [snapshot?.tradeHistory, historySort]);
  const fundingRows = useMemo(() => sortBy(snapshot?.fundingStats?.buckets ?? [], fundingSort), [snapshot?.fundingStats?.buckets, fundingSort]);
  const signalRows = useMemo(() => sortBy(snapshot?.signalRows ?? [], signalsSort), [snapshot?.signalRows, signalsSort]);

  return (
    <Container className="py-3">
      <Row className="align-items-center mb-3">
        <Col>
          <h2 className="mb-0">Dashboard</h2>
        </Col>
        <Col className="text-end">
          <Button variant="outline-primary" size="sm" onClick={doRefresh}>
            Refresh
          </Button>
          <span className="ms-2 text-muted" style={{ fontSize: 12 }}>
            backend 1s | UI 5s
          </span>
        </Col>
      </Row>

      <Tabs activeKey={tab} onSelect={(k) => setTab((k as any) ?? "BOT")} className="mb-3">
        <Tab eventKey="BOT" title="Bot Controls">
          <Card className="mb-3">
            <Card.Header>Controls</Card.Header>
            <Card.Body>
              <div className="mb-2 text-muted" style={{ fontSize: 12 }}>
                Fees total: {(snapshot?.feesSummary.totalFeesUSDT ?? 0).toFixed(4)} USDT (entry {(snapshot?.feesSummary.entryFeesUSDT ?? 0).toFixed(4)} / exit {(snapshot?.feesSummary.exitFeesUSDT ?? 0).toFixed(4)})
              </div>
              <div className="d-flex flex-wrap gap-2 align-items-center">
                <Button onClick={() => sendSetRunState("RUNNING")} disabled={botRunState === "RUNNING"}>
                  Start
                </Button>
                <Button variant="secondary" onClick={() => sendSetRunState("STOPPED")} disabled={botRunState === "STOPPED"}>
                  Stop
                </Button>
                <Button variant="danger" onClick={sendKillAll}>
                  Kill
                </Button>
                <Button variant="outline-danger" onClick={sendResetAll}>
                  Reset
                </Button>
                <div className="ms-auto d-flex gap-2 align-items-center">
                  <span className="text-muted" style={{ fontSize: 12 }}>
                    Frontend WS:
                  </span>
                  <StatusBadge ok={wsStatus === "CONNECTED"} label={wsStatus} />
                </div>
              </div>
            </Card.Body>
          </Card>

          <Card className="mb-3">
            <Card.Header>Universe filters</Card.Header>
            <Card.Body>
              <Row className="g-3">
                <Col md="4">
                  <Form.Label>Min volatility % (day high-low / low)</Form.Label>
                  <Form.Control
                    type="number"
                    value={universeDraft.minVolatilityPct}
                    onChange={(e) => setUniverseDraft((p) => ({ ...p, minVolatilityPct: Number(e.target.value) }))}
                  />
                </Col>
                <Col md="4">
                  <Form.Label>Min turnover USDT (24h)</Form.Label>
                  <Form.Control
                    type="number"
                    value={universeDraft.minTurnoverUSDT}
                    onChange={(e) => setUniverseDraft((p) => ({ ...p, minTurnoverUSDT: Number(e.target.value) }))}
                  />
                </Col>
                <Col md="4">
                  <Form.Label>Universe name (optional)</Form.Label>
                  <Form.Control value={universeName} placeholder={snapshot?.currentUniverseName ?? "(auto)"} onChange={(e) => setUniverseName(e.target.value)} />
                  <div className="text-muted" style={{ fontSize: 12 }}>
                    Default: (vol%/turnover)
                  </div>
                </Col>
              </Row>

              <div className="mt-3 d-flex gap-2 flex-wrap">
                <Button variant="outline-primary" onClick={saveUniverseConfig}>
                  Save Filters
                </Button>
                <Button variant="outline-secondary" onClick={() => wsSend({ type: "REBUILD_UNIVERSE" })}>
                  Rebuild Universe
                </Button>
                <Button variant="primary" onClick={() => sendSaveUniversePreset(universeName)}>
                  Save Universe
                </Button>
              </div>

              <div className="mt-2 text-muted" style={{ fontSize: 12 }}>
                Universe totals: total eligible: {snapshot?.universe.totalSymbols ?? 0} | selected: {snapshot?.universe.selectedSymbols ?? 0}
              </div>
            </Card.Body>
          </Card>
        </Tab>

        <Tab eventKey="UNIVERSE" title="Universe Symbols">
          <Card className="mb-3">
            <Card.Header>Saved universes</Card.Header>
            <Card.Body>
              <div className="text-muted" style={{ fontSize: 12 }}>
                Saved: {snapshot?.savedUniverses?.length ?? 0}
              </div>
              {(snapshot?.savedUniverses ?? []).slice().sort((a, b) => b.createdAtMs - a.createdAtMs).map((u) => (
                <div key={u.name} style={{ fontSize: 13 }}>
                  <b>{u.name}</b> — {u.symbols.length} symbols — {msToMskString(u.createdAtMs)}
                </div>
              ))}
            </Card.Body>
          </Card>

          <Card className="mb-3">
            <Card.Header>Universe table</Card.Header>
            <Card.Body style={{ overflowX: "auto" }}>
              <Table striped bordered hover size="sm" className="mb-0">
                <thead>
                  <tr>
                    <th role="button" onClick={() => setUniverseSort((p) => toggleSort(p, "symbol"))}>
                      Symbol
                    </th>
                    <th role="button" className="text-end" onClick={() => setUniverseSort((p) => toggleSort(p, "markPrice"))}>
                      Mark
                    </th>
                    <th role="button" className="text-end" onClick={() => setUniverseSort((p) => toggleSort(p, "priceDeltaPct"))}>
                      Δ Price %
                    </th>
                    <th role="button" className="text-end" onClick={() => setUniverseSort((p) => toggleSort(p, "oiDeltaPct"))}>
                      Δ OI %
                    </th>
                    <th role="button" className="text-end" onClick={() => setUniverseSort((p) => toggleSort(p, "fundingRate"))}>
                      Funding
                    </th>
                    <th className="text-end">Funding time (MSK)</th>
                    <th role="button" onClick={() => setUniverseSort((p) => toggleSort(p, "status"))}>
                      Status
                    </th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {universeRows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="text-muted">
                        Universe empty
                      </td>
                    </tr>
                  ) : (
                    universeRows.map((u) => (
                      <tr key={u.symbol}>
                        <td>{u.symbol}</td>
                        <td className="text-end">{u.markPrice.toFixed(4)}</td>
                        <td className="text-end">{u.priceDeltaPct.toFixed(2)}</td>
                        <td className="text-end">{u.oiDeltaPct.toFixed(2)}</td>
                        <td className="text-end">{u.fundingRate.toFixed(6)}</td>
                        <td className="text-end">{u.nextFundingTimeMs ? msToMskString(u.nextFundingTimeMs) : "—"}</td>
                        <td>{u.status}</td>
                        <td>{u.reason}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </Table>
            </Card.Body>
          </Card>
        </Tab>

        <Tab eventKey="RESULTS" title="Trade Results">
          <Card className="mb-3">
            <Card.Header>Trade Results (all symbols)</Card.Header>
            <Card.Body style={{ overflowX: "auto" }}>
              <Table striped bordered hover size="sm" className="mb-0">
                <thead>
                  <tr>
                    <th role="button" onClick={() => setResultsSort((p) => toggleSort(p, "symbol"))}>
                      Symbol
                    </th>
                    <th role="button" className="text-end" onClick={() => setResultsSort((p) => toggleSort(p, "trades"))}>
                      Trades
                    </th>
                    <th role="button" className="text-end" onClick={() => setResultsSort((p) => toggleSort(p, "wins"))}>
                      Wins
                    </th>
                    <th role="button" className="text-end" onClick={() => setResultsSort((p) => toggleSort(p, "losses"))}>
                      Losses
                    </th>
                    <th role="button" className="text-end" onClick={() => setResultsSort((p) => toggleSort(p, "winRatePct"))}>
                      WinRate %
                    </th>
                    <th role="button" className="text-end" onClick={() => setResultsSort((p) => toggleSort(p, "netPnlUSDT"))}>
                      Net PnL (USDT)
                    </th>
                    <th role="button" className="text-end" onClick={() => setResultsSort((p) => toggleSort(p, "netRoiPct"))}>
                      Net ROI %
                    </th>
                    <th role="button" className="text-end" onClick={() => setResultsSort((p) => toggleSort(p, "avgRoiPct"))}>
                      Avg ROI %
                    </th>
                    <th className="text-end">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {resultRows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="text-muted">
                        No trades yet
                      </td>
                    </tr>
                  ) : (
                    resultRows.map((r) => (
                      <tr key={r.symbol}>
                        <td>{r.symbol}</td>
                        <td className="text-end">{r.trades}</td>
                        <td className="text-end">{r.wins}</td>
                        <td className="text-end">{r.losses}</td>
                        <td className="text-end">{r.winRatePct.toFixed(2)}</td>
                        <td className="text-end">{r.netPnlUSDT.toFixed(4)}</td>
                        <td className="text-end">{r.netRoiPct.toFixed(2)}</td>
                        <td className="text-end">{r.avgRoiPct.toFixed(2)}</td>
                        <td className="text-end">
                          <Button variant="outline-danger" size="sm" onClick={() => sendRemoveUniverseSymbol(r.symbol)}>
                            Remove
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </Table>
            </Card.Body>
          </Card>
        </Tab>
<Tab eventKey="HISTORY" title="Trade History">
  <Card className="mb-3">
    <Card.Header>Trade History (closed trades)</Card.Header>
    <Card.Body style={{ overflowX: "auto" }}>
      <Table striped bordered hover size="sm" className="mb-0">
        <thead>
          <tr>
            <th role="button" onClick={() => setHistorySort((p: any) => toggleSort(p, "closedAtMs"))}>Close time (MSK)</th>
            <th role="button" onClick={() => setHistorySort((p: any) => toggleSort(p, "symbol"))}>Symbol</th>
            <th role="button" className="text-end" onClick={() => setHistorySort((p: any) => toggleSort(p, "side"))}>Direction</th>
            <th role="button" className="text-end" onClick={() => setHistorySort((p: any) => toggleSort(p, "entryPrice"))}>Entry</th>
            <th role="button" className="text-end" onClick={() => setHistorySort((p: any) => toggleSort(p, "exitPrice"))}>Exit</th>
            <th role="button" className="text-end" onClick={() => setHistorySort((p: any) => toggleSort(p, "pnlUSDT"))}>PnL USDT</th>
            <th role="button" className="text-end" onClick={() => setHistorySort((p: any) => toggleSort(p, "pnlRoiPct"))}>ROI %</th>
            <th role="button" className="text-end" onClick={() => setHistorySort((p: any) => toggleSort(p, "fundingRateAtEntry"))}>Funding (entry)</th>
            <th role="button" className="text-end" onClick={() => setHistorySort((p: any) => toggleSort(p, "fundingAbsAtEntry"))}>|Funding|</th>
            <th className="text-end">Fees</th>
            <th className="text-end">Result</th>
          </tr>
        </thead>
        <tbody>
          {historyRows.filter((t: any) => t.status === "CLOSED").length === 0 ? (
            <tr><td colSpan={11} className="text-muted">No closed trades yet</td></tr>
          ) : historyRows.filter((t: any) => t.status === "CLOSED").map((t: any) => {
            const fees = (t.entryFeeUSDT ?? 0) + (t.exitFeeUSDT ?? 0);
            const pnl = t.pnlUSDT ?? 0;
            return (
              <tr key={t.id}>
                <td>{t.closedAtMs ? msToMskString(t.closedAtMs) : "—"}</td>
                <td>{t.symbol}</td>
                <td className="text-end">{t.side}</td>
                <td className="text-end">{(t.entryPrice ?? 0).toFixed(4)}</td>
                <td className="text-end">{(t.exitPrice ?? 0).toFixed(4)}</td>
                <td className="text-end">{pnl.toFixed(4)}</td>
                <td className="text-end">{(t.pnlRoiPct ?? 0).toFixed(2)}</td>
                <td className="text-end">{(t.fundingRateAtEntry ?? 0).toFixed(6)}</td>
                <td className="text-end">{(t.fundingAbsAtEntry ?? Math.abs(t.fundingRateAtEntry ?? 0)).toFixed(6)}</td>
                <td className="text-end">{fees.toFixed(4)}</td>
                <td className="text-end">{pnl >= 0 ? "WIN" : "LOSS"}</td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card.Body>
  </Card>
</Tab>

<Tab eventKey="FUNDING" title="Funding Analysis">
  <Card className="mb-3">
    <Card.Header>Funding buckets (by |funding| at entry)</Card.Header>
    <Card.Body style={{ overflowX: "auto" }}>
      <Table striped bordered hover size="sm" className="mb-0">
        <thead>
          <tr>
            <th role="button" onClick={() => setFundingSort((p: any) => toggleSort(p, "bucket"))}>Bucket</th>
            <th role="button" onClick={() => setFundingSort((p: any) => toggleSort(p, "sign"))}>Sign</th>
            <th role="button" className="text-end" onClick={() => setFundingSort((p: any) => toggleSort(p, "trades"))}>Trades</th>
            <th role="button" className="text-end" onClick={() => setFundingSort((p: any) => toggleSort(p, "wins"))}>Wins</th>
            <th role="button" className="text-end" onClick={() => setFundingSort((p: any) => toggleSort(p, "losses"))}>Losses</th>
            <th role="button" className="text-end" onClick={() => setFundingSort((p: any) => toggleSort(p, "winRatePct"))}>WinRate %</th>
            <th role="button" className="text-end" onClick={() => setFundingSort((p: any) => toggleSort(p, "netPnlUSDT"))}>Net PnL</th>
            <th role="button" className="text-end" onClick={() => setFundingSort((p: any) => toggleSort(p, "netFeesUSDT"))}>Fees</th>
            <th role="button" className="text-end" onClick={() => setFundingSort((p: any) => toggleSort(p, "avgRoiPct"))}>Avg ROI %</th>
            <th role="button" className="text-end" onClick={() => setFundingSort((p: any) => toggleSort(p, "avgFundingAbs"))}>Avg |Funding|</th>
          </tr>
        </thead>
        <tbody>
          {fundingRows.length === 0 ? (
            <tr><td colSpan={10} className="text-muted">No data yet</td></tr>
          ) : fundingRows.map((rr: any) => (
            <tr key={`${rr.bucket}-${rr.sign}`}>
              <td>{rr.bucket}</td>
              <td>{rr.sign}</td>
              <td className="text-end">{rr.trades}</td>
              <td className="text-end">{rr.wins}</td>
              <td className="text-end">{rr.losses}</td>
              <td className="text-end">{(rr.winRatePct ?? 0).toFixed(2)}</td>
              <td className="text-end">{(rr.netPnlUSDT ?? 0).toFixed(4)}</td>
              <td className="text-end">{(rr.netFeesUSDT ?? 0).toFixed(4)}</td>
              <td className="text-end">{(rr.avgRoiPct ?? 0).toFixed(2)}</td>
              <td className="text-end">{(rr.avgFundingAbs ?? 0).toFixed(6)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card.Body>
  </Card>
</Tab>

<Tab eventKey="SIGNALS" title="Signals">
  <Card className="mb-3">
    <Card.Header className="d-flex align-items-center justify-content-between">
      <span>Signals (Universe only)</span>
      <Button size="sm" variant="outline-secondary" onClick={sendRefreshSignals}>Refresh</Button>
    </Card.Header>
    <Card.Body style={{ overflowX: "auto" }}>
      <div className="mb-2 text-muted" style={{ fontSize: 12 }}>
        Signals rows recompute on backend every 10s (prices still refresh with the global snapshot cadence).
      </div>
      <Table striped bordered hover size="sm" className="mb-0">
        <thead>
          <tr>
            <th role="button" onClick={() => setSignalsSort((p: any) => toggleSort(p, "symbol"))}>Symbol</th>
            <th role="button" className="text-end" onClick={() => setSignalsSort((p: any) => toggleSort(p, "currentPrice"))}>Current price</th>
            <th role="button" onClick={() => setSignalsSort((p: any) => toggleSort(p, "lastSignalAtMs"))}>Last signal (MSK)</th>
            <th role="button" className="text-end" onClick={() => setSignalsSort((p: any) => toggleSort(p, "signalCountToday"))}>Signal # today</th>
            <th role="button" className="text-end" onClick={() => setSignalsSort((p: any) => toggleSort(p, "tradesOpenedToday"))}>Opened trades today</th>
            <th role="button" className="text-end" onClick={() => setSignalsSort((p: any) => toggleSort(p, "winsToday"))}>Wins today</th>
            <th role="button" className="text-end" onClick={() => setSignalsSort((p: any) => toggleSort(p, "priceChangeTodayPct"))}>Price change today %</th>
            <th role="button" className="text-end" onClick={() => setSignalsSort((p: any) => toggleSort(p, "oiValueChangeTodayPct"))}>OI value change today %</th>
            <th role="button" className="text-end" onClick={() => setSignalsSort((p: any) => toggleSort(p, "lastUpdateAgeSec"))}>Last update (sec ago)</th>
          </tr>
        </thead>
        <tbody>
          {signalRows.length === 0 ? (
            <tr><td colSpan={9} className="text-muted">No symbols in Universe</td></tr>
          ) : signalRows.map((rr: any) => (
            <tr key={rr.symbol}>
              <td>{rr.symbol}</td>
              <td className="text-end">{(rr.currentPrice ?? 0).toFixed(4)}</td>
              <td>{rr.lastSignalAtMs ? msToMskString(rr.lastSignalAtMs) : "—"}</td>
              <td className="text-end">{rr.signalCountToday ?? 0}</td>
              <td className="text-end">{rr.tradesOpenedToday ?? 0}</td>
              <td className="text-end">{rr.winsToday ?? 0}</td>
              <td className="text-end">{rr.priceChangeTodayPct == null ? "—" : rr.priceChangeTodayPct.toFixed(2)}</td>
              <td className="text-end">{rr.oiValueChangeTodayPct == null ? "—" : rr.oiValueChangeTodayPct.toFixed(2)}</td>
              <td className="text-end">{rr.lastUpdateAgeSec == null ? "—" : rr.lastUpdateAgeSec}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card.Body>
  </Card>
</Tab>

      </Tabs>
    </Container>
  );
}

function RequestsPage() {
  const [symbols, setSymbols] = useState<string[]>([]);
  const [symbol, setSymbol] = useState<string>("");
  const [rows, setRows] = useState<Array<{ name: string; response: any }>>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadSymbols = async () => {
    try {
      const res = await fetch("/api/usdt-symbols");
      const j = await res.json();
      const list: string[] = j?.symbols ?? [];
      setSymbols(list);
      if (!symbol && list.length > 0) setSymbol(list[0]);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  };

  useEffect(() => {
    void loadSymbols();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onUpdate = async () => {
    if (!symbol) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/requests/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      const j = await res.json();
      if (!res.ok) {
        setErr(j?.error ?? "request failed");
        setRows([]);
        return;
      }
      const wsRows = (j.websocket ?? []).map((x: any) => ({ name: x.name, response: x.response }));
      const apiRows = (j.api ?? []).map((x: any) => ({ name: x.name, response: x.response }));
      setRows([
        { name: "--- WebSocket (public) ---", response: "" },
        ...wsRows,
        { name: "--- REST API ---", response: "" },
        ...apiRows,
      ]);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Container className="py-3">
      <Row className="mb-3">
        <Col>
          <h4 className="mb-1">Requests</h4>
          <div className="text-muted" style={{ fontSize: 12 }}>
            One-shot requests (no auto-refresh). Symbol selector includes all USDT perpetual futures.
          </div>
        </Col>
      </Row>

      <Card className="mb-3">
        <Card.Header className="d-flex align-items-center justify-content-between">
          <div className="d-flex gap-2 align-items-center">
            <span style={{ fontWeight: 600 }}>Symbol</span>
            <Form.Select value={symbol} onChange={(e) => setSymbol(e.target.value)} style={{ width: 240 }}>
              {symbols.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Form.Select>
            <Button variant="primary" onClick={onUpdate} disabled={loading || !symbol}>
              {loading ? "Loading..." : "Обновить"}
            </Button>
          </div>
          {err ? <Badge bg="danger">Error</Badge> : <span />}
        </Card.Header>

        <Card.Body style={{ overflowX: "auto" }}>
          {err ? (
            <div className="text-danger mb-2">{err}</div>
          ) : null}

          <Table striped bordered hover size="sm" className="mb-0">
            <thead>
              <tr>
                <th style={{ width: "35%" }}>Имя запроса</th>
                <th>Ответ</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={2} className="text-muted">
                    Нажми «Обновить», чтобы выполнить запросы для выбранного символа.
                  </td>
                </tr>
              ) : (
                rows.map((rr, i) => (
                  <tr key={i}>
                    <td style={{ whiteSpace: "pre-wrap" }}>{rr.name}</td>
                    <td>
                      {typeof rr.response === "string" ? (
                        <span className="text-muted">{rr.response}</span>
                      ) : (
                        <pre style={{ margin: 0, fontSize: 12, maxHeight: 280, overflow: "auto" }}>
{JSON.stringify(rr.response, null, 2)}
                        </pre>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </Table>
        </Card.Body>
      </Card>
    </Container>
  );
}


export function App() {
  const { wsStatus, snapshot, wsSend, doRefresh } = useWsSnapshot();

  const [positionsSort, setPositionsSort] = useState<SortState<PaperPosition>>({ key: "symbol", dir: "asc" });
  const [ordersSort, setOrdersSort] = useState<SortState<PaperOrder>>({ key: "symbol", dir: "asc" });

  return (
    <BrowserRouter>
      <Navbar bg="dark" variant="dark" expand="sm">
        <Container>
          <Navbar.Brand>Bybit Paper Bot</Navbar.Brand>
          <Nav className="me-auto">
              <Nav.Link as={NavLink} to="/requests">Requests</Nav.Link>
            <Nav.Link as={NavLink} to="/">
              Home
            </Nav.Link>
            <Nav.Link as={NavLink} to="/dashboard">
              Dashboard
            </Nav.Link>
          </Nav>
          <div className="d-flex gap-2 align-items-center">
            <span className="text-muted" style={{ fontSize: 12 }}>
              WS
            </span>
            <StatusBadge ok={wsStatus === "CONNECTED"} label={wsStatus} />
          </div>
        </Container>
      </Navbar>

      <Routes>
        <Route
          path="/"
          element={
            <HomePage
              snapshot={snapshot}
              wsStatus={wsStatus}
              doRefresh={doRefresh}
              positionsSort={positionsSort}
              setPositionsSort={setPositionsSort}
              ordersSort={ordersSort}
              setOrdersSort={setOrdersSort}
            />
          }
        />
        <Route path="/dashboard" element={<DashboardPage snapshot={snapshot} wsStatus={wsStatus} wsSend={wsSend} doRefresh={doRefresh} />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}


export default App;
