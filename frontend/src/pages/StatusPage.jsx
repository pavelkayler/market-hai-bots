import { useEffect, useRef, useState } from 'react'
import { Card, Alert, Button, Spinner, Badge, Form } from 'react-bootstrap'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080'

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}

function toWsUrl(apiBase) {
  const u = new URL(apiBase)
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${u.host}/ws`
}

export default function StatusPage() {
  const [loading, setLoading] = useState(true)
  const [health, setHealth] = useState(null)
  const [heartbeat, setHeartbeat] = useState(null)
  const [error, setError] = useState('')

  const [wsStatus, setWsStatus] = useState('disconnected')
  const [wsLastMsg, setWsLastMsg] = useState(null)
  const wsRef = useRef(null)

  const [symbols, setSymbols] = useState(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
  const [selectedSymbol, setSelectedSymbol] = useState('BTCUSDT')

  const [bybitTickers, setBybitTickers] = useState({})
  const [binanceTickers, setBinanceTickers] = useState({})

  const [bybitStatus, setBybitStatus] = useState('unknown')
  const [binanceStatus, setBinanceStatus] = useState('unknown')

  // Throttle buffers
  const pendingBybitRef = useRef({})
  const pendingBinanceRef = useRef({})
  const pendingLastMsgRef = useRef(null)

  async function loadHttp() {
    setLoading(true)
    setError('')
    try {
      const [h, hb] = await Promise.all([fetchJson('/health'), fetchJson('/api/heartbeat')])
      setHealth(h)
      setHeartbeat(hb)
    } catch (e) {
      setError(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  function connectWs() {
    const wsUrl = toWsUrl(API_BASE)

    if (wsRef.current) {
      try { wsRef.current.close() } catch {}
    }

    setWsStatus('connecting')
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => setWsStatus('connected')
    ws.onclose = () => setWsStatus('disconnected')
    ws.onerror = () => setWsStatus('error')

    ws.onmessage = (evt) => {
      let msg
      try {
        msg = JSON.parse(evt.data)
      } catch {
        msg = { type: 'raw', payload: String(evt.data) }
      }

      pendingLastMsgRef.current = msg

      if (msg.type === 'snapshot') {
        const p = msg.payload || {}

        if (Array.isArray(p.symbols)) {
          setSymbols(p.symbols)
          if (!p.symbols.includes(selectedSymbol)) setSelectedSymbol(p.symbols[0] || 'BTCUSDT')
        }

        // backward-compat (older snapshot had tickers only)
        if (p.bybitTickers && typeof p.bybitTickers === 'object') setBybitTickers(p.bybitTickers)
        else if (p.tickers && typeof p.tickers === 'object') setBybitTickers(p.tickers)

        if (p.binanceTickers && typeof p.binanceTickers === 'object') setBinanceTickers(p.binanceTickers)

        if (p.bybit?.status) setBybitStatus(p.bybit.status)
        if (p.binance?.status) setBinanceStatus(p.binance.status)

        return
      }

      if (msg.type === 'bybit.status') {
        setBybitStatus(msg.payload?.status || 'unknown')
        return
      }

      if (msg.type === 'binance.status') {
        setBinanceStatus(msg.payload?.status || 'unknown')
        return
      }

      if (msg.type === 'bybit.ticker' && msg.payload?.symbol) {
        pendingBybitRef.current[msg.payload.symbol] = msg.payload
        return
      }

      if (msg.type === 'binance.ticker' && msg.payload?.symbol) {
        pendingBinanceRef.current[msg.payload.symbol] = msg.payload
        return
      }
    }
  }

  function sendPing() {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'ping' }))
  }

  useEffect(() => {
    loadHttp()
    connectWs()

    const flushTimer = setInterval(() => {
      const pb = pendingBybitRef.current
      if (pb && Object.keys(pb).length) {
        setBybitTickers((prev) => ({ ...prev, ...pb }))
        pendingBybitRef.current = {}
      }

      const pn = pendingBinanceRef.current
      if (pn && Object.keys(pn).length) {
        setBinanceTickers((prev) => ({ ...prev, ...pn }))
        pendingBinanceRef.current = {}
      }

      if (pendingLastMsgRef.current) {
        setWsLastMsg(pendingLastMsgRef.current)
        pendingLastMsgRef.current = null
      }
    }, 250)

    return () => {
      clearInterval(flushTimer)
      if (wsRef.current) {
        try { wsRef.current.close() } catch {}
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const wsBadge =
    wsStatus === 'connected'
      ? 'success'
      : wsStatus === 'connecting'
        ? 'warning'
        : wsStatus === 'error'
          ? 'danger'
          : 'secondary'

  const bybitBadge = bybitStatus === 'connected' ? 'success' : bybitStatus === 'disconnected' ? 'secondary' : 'warning'
  const binanceBadge = binanceStatus === 'connected' ? 'success' : binanceStatus === 'disconnected' ? 'secondary' : 'warning'

  const current = {
    bybit: bybitTickers?.[selectedSymbol] || null,
    binance: binanceTickers?.[selectedSymbol] || null,
  }

  return (
    <div className="d-grid gap-3">
      <h3 className="m-0">Backend status</h3>

      {error && <Alert variant="danger">{error}</Alert>}

      <Card>
        <Card.Body className="d-flex align-items-center justify-content-between">
          <div>
            <div className="fw-semibold">API Base</div>
            <div className="text-muted">{API_BASE}</div>
          </div>
          <Button onClick={loadHttp} variant="primary" disabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </Button>
        </Card.Body>
      </Card>

      <Card>
        <Card.Body>
          <div className="fw-semibold mb-2">/health</div>
          {loading ? (
            <div className="d-flex align-items-center gap-2">
              <Spinner size="sm" /> <span>Loading...</span>
            </div>
          ) : (
            <pre className="m-0">{JSON.stringify(health, null, 2)}</pre>
          )}
        </Card.Body>
      </Card>

      <Card>
        <Card.Body>
          <div className="fw-semibold mb-2">/api/heartbeat</div>
          {loading ? (
            <div className="d-flex align-items-center gap-2">
              <Spinner size="sm" /> <span>Loading...</span>
            </div>
          ) : (
            <pre className="m-0">{JSON.stringify(heartbeat, null, 2)}</pre>
          )}
        </Card.Body>
      </Card>

      <Card>
        <Card.Body className="d-grid gap-2">
          <div className="d-flex align-items-center justify-content-between">
            <div className="fw-semibold">
              WebSocket <Badge bg={wsBadge} className="ms-2">{wsStatus}</Badge>
              <span className="ms-3">
                Bybit <Badge bg={bybitBadge} className="ms-2">{bybitStatus}</Badge>
              </span>
              <span className="ms-3">
                Binance <Badge bg={binanceBadge} className="ms-2">{binanceStatus}</Badge>
              </span>
            </div>
            <div className="d-flex gap-2">
              <Button variant="outline-primary" onClick={connectWs}>Reconnect</Button>
              <Button variant="outline-secondary" onClick={sendPing} disabled={wsStatus !== 'connected'}>
                Send ping
              </Button>
            </div>
          </div>

          <div className="text-muted">WS URL: {toWsUrl(API_BASE)}</div>

          <Form.Group>
            <Form.Label className="fw-semibold">Symbol</Form.Label>
            <Form.Select value={selectedSymbol} onChange={(e) => setSelectedSymbol(e.target.value)}>
              {symbols.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Form.Select>
          </Form.Group>

          <div>
            <div className="fw-semibold mb-2">Selected ticker (BT / BNB)</div>
            <pre className="m-0">{JSON.stringify(current, null, 2)}</pre>
          </div>

          <div>
            <div className="fw-semibold mb-2">Last WS message</div>
            <pre className="m-0">{JSON.stringify(wsLastMsg, null, 2)}</pre>
          </div>
        </Card.Body>
      </Card>
    </div>
  )
}
