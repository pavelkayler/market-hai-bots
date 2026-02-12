import { Container, Nav, Navbar } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import AppRoutes from './routing/routes.jsx';

export default function App() {
  return (
    <>
      <Navbar bg="dark" variant="dark" expand="lg">
        <Container>
          <Navbar.Brand as={Link} to="/">Market HAI</Navbar.Brand>
          <Nav className="me-auto">
            <Nav.Link as={Link} to="/">Status</Nav.Link>
            <Nav.Link as={Link} to="/bybit">Bybit / Lead-Lag</Nav.Link>
            <Nav.Link as={Link} to="/leadlag">LeadLag</Nav.Link>
            <Nav.Link as={Link} to="/pullback">Pullback (MTF)</Nav.Link>
            <Nav.Link as={Link} to="/range">Range (Metrics)</Nav.Link>
            <Nav.Link as={Link} to="/impulse">Impulse (Price+OI)</Nav.Link>
            <Nav.Link as={Link} to="/presets">Пресеты</Nav.Link>
          </Nav>
        </Container>
      </Navbar>
      <Container className="py-4">
        <AppRoutes />
      </Container>
    </>
  );
}
