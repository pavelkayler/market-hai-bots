import { Route, Routes } from 'react-router-dom';
import StatusPage from '../../pages/status/StatusPage.jsx';
import MomentumPage from '../../pages/momentum/MomentumPage.jsx';
import UniversePage from '../../pages/universe/UniversePage.jsx';
import ManualDemoTradePage from '../../pages/manual/ManualDemoTradePage.jsx';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<StatusPage />} />
      <Route path="/status" element={<StatusPage />} />
      <Route path="/momentum" element={<MomentumPage />} />
      <Route path="/universe" element={<UniversePage />} />
      <Route path="/manual-demo" element={<ManualDemoTradePage />} />
      <Route path="*" element={<StatusPage />} />
    </Routes>
  );
}
