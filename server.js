const WebSocket = require('ws');
const http = require('http');
const url = require('url');

// Use environment port (e.g., on Render/Heroku) or default to 8080
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    // Health check endpoint (useful for cloud platforms)
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', lobbies: lobbies.size }));
        return;
    }
    res.writeHead(404);
    res.end();
});

const wss = new WebSocket.Server({
    server,
    // Allow connections from any origin (important for your Netlify frontend)
    verifyClient: (info) => {
        // You can add origin validation here if needed, but for simplicity allow all
        return true;
    }
});

// Lobby storage: lobbyId -> { players: Map(ws -> {id, color, data}), scrap, wave }
const lobbies = new Map();
let nextId = 1;

function generateLobbyCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function broadcastToLobby(lobbyId, message) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;
    const json = JSON.stringify(message);
    for (const [ws] of lobby.players) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(json);
        }
    }
}

function getLobbyState(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return null;
    const players = [];
    for (const [ws, entry] of lobby.players) {
        players.push({
            id: entry.id,
            color: entry.color,
            health: entry.data?.health ?? 100,
            scrap: entry.data?.scrap ?? 0,
            x: entry.data?.x ?? 0,
            y: entry.data?.y ?? 0,
            z: entry.data?.z ?? 0,
            yaw: entry.data?.yaw ?? 0,
            pitch: entry.data?.pitch ?? 0,
            kills: entry.data?.kills ?? 0,
        });
    }
    return {
        type: 'lobbyState',
        lobbyId,
        players,
        scrap: lobby.scrap,
        wave: lobby.wave,
        selfId: null // will be filled per client
    };
}

wss.on('connection', (ws, req) => {
    const id = nextId++;
    const color = `hsl(${Math.random() * 360}, 80%, 60%)`;
    let currentLobbyId = null;

    console.log(`[${new Date().toISOString()}] New connection, assigned ID ${id}`);

    // Send the client its ID and color
    ws.send(JSON.stringify({ type: 'init', id, color }));

    ws.on('message', (message) => {
        try {
            const packet = JSON.parse(message);

            if (packet.type === 'createLobby') {
                // Generate a unique lobby code
                let code;
                let attempts = 0;
                do {
                    code = generateLobbyCode();
                    attempts++;
                } while (lobbies.has(code) && attempts < 20);

                if (lobbies.has(code)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Could not create lobby, try again' }));
                    return;
                }

                const lobby = {
                    players: new Map(),
                    scrap: 0,
                    wave: 0
                };
                lobby.players.set(ws, { id, color, data: null });
                lobbies.set(code, lobby);
                currentLobbyId = code;

                ws.send(JSON.stringify({ type: 'lobbyCreated', lobbyId: code }));

                // Send initial state with selfId
                const state = getLobbyState(code);
                state.selfId = id;
                ws.send(JSON.stringify(state));
                console.log(`Lobby ${code} created by player ${id}`);
            }

            else if (packet.type === 'joinLobby') {
                const lobbyId = packet.lobbyId;
                const lobby = lobbies.get(lobbyId);
                if (!lobby) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Lobby not found' }));
                    return;
                }
                // Add player
                lobby.players.set(ws, { id, color, data: null });
                currentLobbyId = lobbyId;

                // Broadcast updated state to everyone in the lobby
                const state = getLobbyState(lobbyId);
                for (const [client] of lobby.players) {
                    state.selfId = client === ws ? id : null;
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(state));
                    }
                }
                console.log(`Player ${id} joined lobby ${lobbyId}`);
            }

            else if (packet.type === 'update') {
                if (!currentLobbyId) return;
                const lobby = lobbies.get(currentLobbyId);
                if (!lobby) return;
                const entry = lobby.players.get(ws);
                if (entry) {
                    entry.data = packet.data; // store latest state
                }
                // Broadcast full state to all members (including self)
                const state = getLobbyState(currentLobbyId);
                for (const [client, e] of lobby.players) {
                    state.selfId = client === ws ? e.id : null;
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(state));
                    }
                }
            }

            else if (packet.type === 'collectScrap') {
                if (!currentLobbyId) return;
                const lobby = lobbies.get(currentLobbyId);
                if (!lobby) return;
                lobby.scrap += packet.amount;
                // Broadcast scrap update (or full state)
                const state = getLobbyState(currentLobbyId);
                for (const [client, e] of lobby.players) {
                    state.selfId = client === ws ? e.id : null;
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(state));
                    }
                }
            }

        } catch (e) {
            console.warn('Invalid message', e);
        }
    });

    ws.on('close', () => {
        if (currentLobbyId) {
            const lobby = lobbies.get(currentLobbyId);
            if (lobby) {
                lobby.players.delete(ws);
                // If lobby empty, remove it
                if (lobby.players.size === 0) {
                    lobbies.delete(currentLobbyId);
                    console.log(`Lobby ${currentLobbyId} removed (empty)`);
                } else {
                    // Broadcast updated state to remaining players
                    const state = getLobbyState(currentLobbyId);
                    for (const [client] of lobby.players) {
                        state.selfId = null;
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(state));
                        }
                    }
                }
            }
        }
        console.log(`Player ${id} disconnected`);
    });

    // Send a ping to keep the connection alive (optional)
    ws.on('pong', () => { /* connection alive */ });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Lobby WebSocket server running on ws://0.0.0.0:${PORT}`);
    console.log(`Health check available at http://0.0.0.0:${PORT}/health`);
});