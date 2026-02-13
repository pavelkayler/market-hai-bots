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
            <Nav.Link as={Link} to="/leadlag">LeadLag</Nav.Link>
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
