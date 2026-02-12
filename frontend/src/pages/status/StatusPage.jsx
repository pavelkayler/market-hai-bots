import { useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Button, Card, Spinner } from 'react-bootstrap'
import { useWsClient } from '../../shared/api/ws.js'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080'

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res.json()
}

export default function StatusPage() {
  const [loading, setLoading] = useState(true)
  const [health, setHealth] = useState(null)
  const [heartbeat, setHeartbeat] = useState(null)
  const [error, setError] = useState('')
  const [backendWs, setBackendWs] = useState({ bybit: null, binance: null })

  const onWsMessage = useMemo(() => (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    const type = msg.type === 'event' ? msg.topic : msg.type
    if (type === 'snapshot') {
      setBackendWs({ bybit: msg.payload?.bybit || null, binance: msg.payload?.binance || null })
      return
    }
    if (type === 'bybit.status') {
      setBackendWs((prev) => ({ ...prev, bybit: msg.payload || null }))
      return
    }
    if (type === 'binance.status') {
      setBackendWs((prev) => ({ ...prev, binance: msg.payload || null }))
    }
  }, [])

  const { status: localhostWsStatus, wsUrl } = useWsClient({ onMessage: onWsMessage })

  const bybitStatus = String(backendWs.bybit?.status || 'disconnected').toLowerCase()
  const binanceStatus = String(backendWs.binance?.status || 'disconnected').toLowerCase()

  const wsBadgeVariant = (s) => (s === 'connected' ? 'success' : s === 'connecting' || s === 'reconnecting' ? 'warning' : 'secondary')

  async function loadHttp() {
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

  useEffect(() => {
    loadHttp()
    const timer = setInterval(loadHttp, 5000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className='d-grid gap-3'>
      <h3 className='m-0'>Backend status</h3>
      {error && <Alert variant='danger'>{error}</Alert>}
      <Card>
        <Card.Body className='d-flex align-items-center justify-content-between'>
          <div>
            <div className='fw-semibold'>API Base</div>
            <div className='text-muted'>{API_BASE}</div>
          </div>
          <Button onClick={loadHttp} variant='primary' disabled={loading}>{loading ? 'Loading...' : 'Refresh'}</Button>
        </Card.Body>
      </Card>
      <Card>
        <Card.Body>
          <div className='fw-semibold mb-3'>WebSocket connections</div>
          <div className='d-grid gap-2'>
            <div className='d-flex align-items-center justify-content-between'>
              <div>
                <div className='fw-semibold'>Localhost ↔ Frontend</div>
                <div className='text-muted small'>{wsUrl}</div>
              </div>
              <Badge bg={wsBadgeVariant(localhostWsStatus)}>{localhostWsStatus}</Badge>
            </div>
            <div className='d-flex align-items-center justify-content-between'>
              <div>
                <div className='fw-semibold'>Server ↔ Bybit</div>
                <div className='text-muted small'>{backendWs.bybit?.url || '—'}</div>
              </div>
              <Badge bg={wsBadgeVariant(bybitStatus)}>{bybitStatus}</Badge>
            </div>
            <div className='d-flex align-items-center justify-content-between'>
              <div>
                <div className='fw-semibold'>Server ↔ Binance</div>
                <div className='text-muted small'>{backendWs.binance?.url || '—'}</div>
              </div>
              <Badge bg={wsBadgeVariant(binanceStatus)}>{binanceStatus}</Badge>
            </div>
          </div>
        </Card.Body>
      </Card>
      <Card>
        <Card.Body>
          <div className='fw-semibold mb-2'>/health</div>
          {loading && !health ? <div className='d-flex align-items-center gap-2'><Spinner size='sm' />Loading...</div> : <pre className='m-0'>{JSON.stringify(health, null, 2)}</pre>}
        </Card.Body>
      </Card>
      <Card>
        <Card.Body>
          <div className='fw-semibold mb-2'>/api/heartbeat</div>
          {loading && !heartbeat ? <div className='d-flex align-items-center gap-2'><Spinner size='sm' />Loading...</div> : <pre className='m-0'>{JSON.stringify(heartbeat, null, 2)}</pre>}
        </Card.Body>
      </Card>
    </div>
  )
}
