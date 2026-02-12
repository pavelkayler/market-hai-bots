import { BrowserRouter } from 'react-router-dom';

export default function AppProviders({ children }) {
  return <BrowserRouter>{children}</BrowserRouter>;
}
