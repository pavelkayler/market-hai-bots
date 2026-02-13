# Local run (LeadLag)

1. Install dependencies:
   - `cd backend && npm install`
   - `cd ../frontend && npm install`
2. Start backend (default `localhost:8080`):
   - `cd backend && npm run dev`
3. Start frontend:
   - `cd frontend && npm run dev`
4. Open UI (Vite URL, usually `http://localhost:5173`).
5. On **LeadLag** page:
   - set Leader/Follower, Threshold/SL/TP;
   - pick pairs count 50/100/200;
   - click **Start Search**;
   - verify **All combinations** + **Shortlist Top-10** tables update.
6. Health check:
   - `curl http://localhost:8080/health`
