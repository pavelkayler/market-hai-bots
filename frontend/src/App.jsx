import { Container, Navbar, Nav } from 'react-bootstrap'
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import StatusPage from './pages/StatusPage.jsx'
import BybitPage from './pages/BybitPage.jsx'
import PaperTestPage from './pages/PaperTestPage.jsx'
import PullbackTestPage from './pages/PullbackTestPage.jsx'

export default function App() {
    return (
        <BrowserRouter>
            <Navbar bg="dark" variant="dark" expand="lg">
                <Container>
                    <Navbar.Brand as={Link} to="/">Market HAI</Navbar.Brand>
                    <Nav className="me-auto">
                        <Nav.Link as={Link} to="/">Status</Nav.Link>
                        <Nav.Link as={Link} to="/bybit">Bybit / Lead-Lag</Nav.Link>
                        <Nav.Link as={Link} to="/paper">Paper Test</Nav.Link>
                        <Nav.Link as={Link} to="/pullback">Pullback (MTF)</Nav.Link>
                    </Nav>
                </Container>
            </Navbar>

            <Container className="py-4">
                <Routes>
                    <Route path="/" element={<StatusPage />} />
                    <Route path="/bybit" element={<BybitPage />} />
                    <Route path="/paper" element={<PaperTestPage />} />
                    <Route path="/pullback" element={<PullbackTestPage />} />
                    <Route path="*" element={<StatusPage />} />
                </Routes>
            </Container>
        </BrowserRouter>
    )
}
