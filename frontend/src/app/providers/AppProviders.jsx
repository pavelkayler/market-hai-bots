import { BrowserRouter } from 'react-router-dom';
import { WsProvider } from '../../shared/api/ws.js';

export default function AppProviders({ children }) {
  return (
    <BrowserRouter>
      <WsProvider>
        {children}
      </WsProvider>
    </BrowserRouter>
  );
}
