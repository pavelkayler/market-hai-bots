import { Route, Routes } from 'react-router-dom';
import StatusPage from '../../pages/status/StatusPage.jsx';
import LeadLagPage from '../../pages/leadlag/LeadLagPage.jsx';
import RangeMetricsPage from '../../pages/range/RangeMetricsPage.jsx';
import PresetsPage from '../../pages/presets/PresetsPage.jsx';
import ImpulsePage from '../../pages/impulse/ImpulsePage.jsx';
import JournalPage from '../../pages/journal/JournalPage.jsx';

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<StatusPage />} />
      <Route path="/status" element={<StatusPage />} />
      <Route path="/leadlag" element={<LeadLagPage />} />
      <Route path="/range" element={<RangeMetricsPage />} />
      <Route path="/presets" element={<PresetsPage />} />
      <Route path="/impulse" element={<ImpulsePage />} />
      <Route path="/journal" element={<JournalPage />} />
      <Route path="*" element={<StatusPage />} />
    </Routes>
  );
}
