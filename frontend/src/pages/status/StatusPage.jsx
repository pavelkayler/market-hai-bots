import { useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Button, Card, Spinner } from 'react-bootstrap'
import { useWsClient } from '../../shared/api/ws.js'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080'

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}

const age = (ts) => (Number.isFinite(Number(ts)) ? Math.max(0, Date.now() - Number(ts)) : null)

export default function StatusPage() {
  const [loading, setLoading] = useState(true)
  const [health, setHealth] = useState(null)
  const [heartbeat, setHeartbeat] = useState(null)
  const [error, setError] = useState('')
  const [healthWs, setHealthWs] = useState({ backendWs: { connected: false }, bybitWs: { status: 'waiting' }, lastPongAt: null, rttMs: null })

  const onWsMessage = useMemo(() => (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    const type = msg.type === 'event' ? msg.topic : msg.type
    if (type === 'status.health') {
      setHealthWs((prev) => ({ ...prev, ...(msg.payload || {}) }))
      return
    }
    if (type === 'status.pong') {
      const tsEcho = Number(msg.payload?.tsEcho || Date.now())
      setHealthWs((prev) => ({ ...prev, lastPongAt: Date.now(), rttMs: Math.max(0, Date.now() - tsEcho) }))
    }
  }, [])

  const { status: localhostWsStatus, wsUrl, sendJson } = useWsClient({ onMessage: onWsMessage })

  async function loadHttp() {
    setError('')
    try {
      const [h, hb] = await Promise.all([fetchJson('/health'), fetchJson('/api/heartbeat')])
      setHealth(h)
      setHeartbeat(hb)
    } catch (e) {
      setError(String(e?.message || e))
    } finally { setLoading(false) }
  }

  useEffect(() => {
    loadHttp()
    const timer = setInterval(loadHttp, 5000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (localhostWsStatus !== 'connected') return
    sendJson({ type: 'status.watch', active: true })
    const pingTimer = setInterval(() => sendJson({ type: 'status.ping', ts: Date.now() }), 5000)
    return () => {
      clearInterval(pingTimer)
      sendJson({ type: 'status.watch', active: false })
    }
  }, [localhostWsStatus, sendJson])

  const wsBadgeVariant = (s) => (s === 'connected' ? 'success' : s === 'waiting' || s === 'connecting' || s === 'reconnecting' ? 'warning' : 'secondary')

  return (
    <div className='d-grid gap-3'>
      <h3 className='m-0'>Backend status</h3>
      {error && <Alert variant='danger'>{error}</Alert>}
      <Card><Card.Body className='d-flex align-items-center justify-content-between'><div><div className='fw-semibold'>API Base</div><div className='text-muted'>{API_BASE}</div></div><Button onClick={loadHttp} variant='primary' disabled={loading}>{loading ? 'Loading...' : 'Refresh'}</Button></Card.Body></Card>
      <Card>
        <Card.Body>
          <div className='fw-semibold mb-3'>WebSocket health</div>
          <div className='d-grid gap-2'>
            <div className='d-flex align-items-center justify-content-between'><div><div className='fw-semibold'>Frontend ↔ Backend</div><div className='text-muted small'>{wsUrl} · RTT: {Number.isFinite(healthWs.rttMs) ? `${healthWs.rttMs} ms` : '—'} · pong age: {age(healthWs.lastPongAt) ?? '—'} ms</div></div><Badge bg={wsBadgeVariant(localhostWsStatus)}>{localhostWsStatus}</Badge></div>
            <div className='d-flex align-items-center justify-content-between'><div><div className='fw-semibold'>Server ↔ Bybit WS</div><div className='text-muted small'>{healthWs.bybitWs?.url || '—'} · Bybit TS: {healthWs.bybitWs?.lastBybitTs || '—'} · age: {healthWs.bybitWs?.ageMs ?? '—'} ms</div></div><Badge bg={wsBadgeVariant(String(healthWs.bybitWs?.status || 'waiting').toLowerCase())}>{String(healthWs.bybitWs?.status || 'waiting').toLowerCase()}</Badge></div>
          </div>
        </Card.Body>
      </Card>
      <Card><Card.Body><div className='fw-semibold mb-2'>/health</div>{loading && !health ? <div className='d-flex align-items-center gap-2'><Spinner size='sm' />Loading...</div> : <pre className='m-0'>{JSON.stringify(health, null, 2)}</pre>}</Card.Body></Card>
      <Card><Card.Body><div className='fw-semibold mb-2'>/api/heartbeat</div>{loading && !heartbeat ? <div className='d-flex align-items-center gap-2'><Spinner size='sm' />Loading...</div> : <pre className='m-0'>{JSON.stringify(heartbeat, null, 2)}</pre>}</Card.Body></Card>
    </div>
  )
}
