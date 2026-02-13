import { Route, Routes } from 'react-router-dom';
import StatusPage from '../../pages/status/StatusPage.jsx';
import LeadLagPage from '../../pages/leadlag/LeadLagPage.jsx';
import MomentumPage from '../../pages/momentum/MomentumPage.jsx';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<StatusPage />} />
      <Route path="/status" element={<StatusPage />} />
      <Route path="/leadlag" element={<LeadLagPage />} />
      <Route path="/momentum" element={<MomentumPage />} />
      <Route path="*" element={<StatusPage />} />
    </Routes>
  );
}
