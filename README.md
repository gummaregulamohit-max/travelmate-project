# TravelMate

TravelMate is a travel-planning project designed to help users explore and compare travel options.

## Features
- Flight search and fare comparison
- Train search and railway booking links
- Bus search and fare estimates
- Location and station search
- Travel assistant and filters

## Technology
- Frontend: HTML, CSS, JavaScript
- Backend: Node.js
- Flight search: SerpApi integration

## Running TravelMate
1. Open this `travelmate-project` folder in VS Code.
2. Open the integrated terminal (**Terminal → New Terminal**) and start the backend:
   ```bash
   cd travelmate-backend
   npm install   # first time only
   npm start
   ```
3. When the terminal shows `TravelMate backend listening on http://127.0.0.1:3000`, open **http://localhost:3000/** in Chrome.
4. To stop TravelMate, press Ctrl+C in that terminal.

The backend needs Node.js and its `.env` with your API keys — see [travelmate-backend/README.md](travelmate-backend/README.md). You can also open `TravelMate.html` directly as a file (double-click it): while the backend runs, it gets the same live results. On each start the backend makes sure a private key is in `travelmate-local-key.js` next to it (git-ignored — don't share it), and the file page sends that key so the backend can tell it apart from other websites. Start the backend first, or reload the page after starting it.

## Development
The frontend and backend are maintained separately. Backend configuration and API credentials must be kept private.

## Project Status
Under development. Verify live API results and booking availability before relying on them.
