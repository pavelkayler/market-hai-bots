import { useEffect, useMemo, useState } from 'react'
import { Badge, Card } from 'react-bootstrap'
import { useWsClient } from '../../shared/api/ws.js'

const age = (ts) => (Number.isFinite(Number(ts)) ? Math.max(0, Date.now() - Number(ts)) : null)
const fmtAge = (ts) => {
  const ms = age(ts)
  return Number.isFinite(ms) ? `${ms} ms` : '—'
}

export default function StatusPage() {
  const [healthWs, setHealthWs] = useState(() => ({
    now: Date.now(),
    ws: { connected: false, lastSeenAt: null, rttMs: null },
    bybitWs: { status: 'waiting', symbol: 'BTCUSDT', lastTickerAt: null, lastBybitTs: null, ageMs: null },
    cmcApi: { status: 'waiting', lastCheckAt: null, ageMs: null, latencyMs: null },
  }))

  const onWsMessage = useMemo(() => (_ev, msg) => {
    if (!msg) return
    const type = msg.type === 'event' ? msg.topic : msg.type
    if (type === 'status.health') {
      setHealthWs((prev) => ({ ...prev, ...(msg.payload || {}), now: Date.now() }))
      return
    }
    if (type === 'status.pong') {
      const tsEcho = Number(msg.payload?.tsEcho || Date.now())
      setHealthWs((prev) => ({ ...prev, now: Date.now(), ws: { ...(prev.ws || {}), connected: true, lastSeenAt: Date.now(), rttMs: Math.max(0, Date.now() - tsEcho) } }))
    }
  }, [])

  const { status: wsStatus, wsUrl, sendJson } = useWsClient({ onMessage: onWsMessage })

  useEffect(() => {
    if (wsStatus !== 'connected') return
    sendJson({ type: 'status.watch', payload: { active: true } })
    const pingTimer = setInterval(() => sendJson({ type: 'status.ping', payload: { ts: Date.now() } }), 5000)
    return () => {
      clearInterval(pingTimer)
      sendJson({ type: 'status.watch', payload: { active: false } })
    }
  }, [wsStatus, sendJson])

  const wsBadgeVariant = (s) => (s === 'connected' || s === 'ok' ? 'success' : s === 'waiting' || s === 'connecting' || s === 'reconnecting' ? 'warning' : 'secondary')

  return (
    <div className='d-grid gap-3'>
      <h3 className='m-0'>Status</h3>

      <Card>
        <Card.Body>
          <div className='fw-semibold mb-3'>WebSocket Health</div>
          <div className='d-flex align-items-center justify-content-between'>
            <div>
              <div className='fw-semibold'>Frontend ↔ Our Server</div>
              <div className='text-muted small'>{wsUrl} · last pong age: {fmtAge(healthWs?.ws?.lastSeenAt)} · RTT: {Number.isFinite(healthWs?.ws?.rttMs) ? `${healthWs.ws.rttMs} ms` : '—'}</div>
            </div>
            <Badge bg={wsBadgeVariant(wsStatus)}>{wsStatus}</Badge>
          </div>
        </Card.Body>
      </Card>

      <Card>
        <Card.Body className='d-grid gap-2'>
          <div className='fw-semibold mb-1'>Server&apos;s Requests Status</div>
          <div className='d-flex align-items-center justify-content-between'>
            <div>
              <div className='fw-semibold'>Bybit WS</div>
              <div className='text-muted small'>{healthWs?.bybitWs?.url || '—'} · symbol: {healthWs?.bybitWs?.symbol || 'BTCUSDT'} · lastTickerAt age: {fmtAge(healthWs?.bybitWs?.lastTickerAt)} · lastBybitTs age: {fmtAge(healthWs?.bybitWs?.lastBybitTs)}</div>
            </div>
            <Badge bg={wsBadgeVariant(String(healthWs?.bybitWs?.status || 'waiting').toLowerCase())}>{String(healthWs?.bybitWs?.status || 'waiting').toLowerCase()}</Badge>
          </div>
          <div className='d-flex align-items-center justify-content-between'>
            <div>
              <div className='fw-semibold'>CoinMarketCap API</div>
              <div className='text-muted small'>lastCheckAt age: {fmtAge(healthWs?.cmcApi?.lastCheckAt)} · latency: {Number.isFinite(healthWs?.cmcApi?.latencyMs) ? `${healthWs.cmcApi.latencyMs} ms` : '—'}</div>
            </div>
            <Badge bg={wsBadgeVariant(String(healthWs?.cmcApi?.status || 'waiting').toLowerCase())}>{String(healthWs?.cmcApi?.status || 'waiting').toLowerCase()}</Badge>
          </div>
        </Card.Body>
      </Card>
    </div>
  )
}
