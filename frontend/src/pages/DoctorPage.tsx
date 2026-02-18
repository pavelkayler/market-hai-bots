import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Table } from 'react-bootstrap';

import { getDoctor } from '../api';
import type { DoctorReport } from '../types';

export function DoctorPage() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setError('');
      const next = await getDoctor();
      if ('checks' in next) {
        setReport(next as DoctorReport);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => { void load(); }, []);

  return (
    <Card>
      <Card.Body>
        <div className="d-flex justify-content-between align-items-center mb-2">
          <Card.Title className="mb-0">Doctor</Card.Title>
          <Button size="sm" variant="outline-primary" onClick={() => void load()}>Refresh</Button>
        </div>
        {error ? <Alert variant="danger">{error}</Alert> : null}
        <Table size="sm">
          <thead><tr><th>ID</th><th>Status</th><th>Message</th></tr></thead>
          <tbody>
            {(report?.checks ?? []).map((check) => (
              <tr key={check.id}><td>{check.id}</td><td><Badge bg={check.status === 'PASS' ? 'success' : check.status === 'WARN' ? 'warning' : 'danger'}>{check.status}</Badge></td><td>{check.message}</td></tr>
            ))}
          </tbody>
        </Table>
      </Card.Body>
    </Card>
  );
}
