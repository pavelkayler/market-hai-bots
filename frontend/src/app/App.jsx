import { Container, Nav, Navbar } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import AppRoutes from './routing/routes.jsx';
import BotsOverviewBar from '../shared/components/BotsOverviewBar.jsx';

export default function App() {
  return (
    <>
      <Navbar bg="dark" variant="dark" expand="lg">
        <Container>
          <Navbar.Brand as={Link} to="/">Market HAI</Navbar.Brand>
          <Nav className="me-auto">
            <Nav.Link as={Link} to="/">Status</Nav.Link>
            <Nav.Link as={Link} to="/momentum">Momentum</Nav.Link>
            <Nav.Link as={Link} to="/universe">Universe</Nav.Link>
            <Nav.Link as={Link} to="/manual-demo">Manual Demo</Nav.Link>
          </Nav>
        </Container>
      </Navbar>
      <BotsOverviewBar />
      <Container className="py-4">
        <AppRoutes />
      </Container>
    </>
  );
}
