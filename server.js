const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// Simple static HTTP server + WebSocket Lobby Server
const PORT = 8000;
const MIME = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.wasm': 'application/wasm'
};

const server = http.createServer((req, res) => {
    let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
        }
        let ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

// WebSocket Server for Multi-Lobby Multiplayer
const wss = new WebSocketServer({ server });

let nextPlayerId = 1;
const lobbies = new Map(); // id -> { id, name, maxPlayers, host, players: Map(id -> { ws, name, x, y, z, rotY }) }

wss.on('connection', (ws) => {
    const pId = 'p_' + (nextPlayerId++);
    let currentLobbyId = null;

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            // 1. Get lobby list
            if (data.type === 'list_lobbies') {
                const list = [];
                for (let [id, lob] of lobbies) {
                    list.push({
                        id: lob.id,
                        name: lob.name,
                        players: lob.players.size,
                        maxPlayers: lob.maxPlayers
                    });
                }
                ws.send(JSON.stringify({ type: 'lobby_list', lobbies: list }));
            }

            // 2. Create lobby
            else if (data.type === 'create_lobby') {
                const lobId = 'lob_' + Math.random().toString(36).substr(2, 6);
                const max = Math.max(2, Math.min(5, parseInt(data.maxPlayers) || 4));
                const lob = {
                    id: lobId,
                    name: (data.name || 'Bee Room').trim().substr(0, 20),
                    maxPlayers: max,
                    host: pId,
                    players: new Map()
                };
                lob.players.set(pId, { ws: ws, name: data.playerName || 'Host' });
                lobbies.set(lobId, lob);
                currentLobbyId = lobId;

                ws.send(JSON.stringify({
                    type: 'joined_lobby',
                    lobby: { id: lob.id, name: lob.name, maxPlayers: lob.maxPlayers, isHost: true }
                }));
            }

            // 3. Join lobby
            else if (data.type === 'join_lobby') {
                const lob = lobbies.get(data.lobbyId);
                if (!lob) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Lobby not found' }));
                    return;
                }
                if (lob.players.size >= lob.maxPlayers) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Lobby is full' }));
                    return;
                }

                currentLobbyId = lob.id;
                const pName = data.playerName || 'BeeKeeper';

                // Notify others in lobby
                for (let [otherId, p] of lob.players) {
                    if (p.ws.readyState === 1) {
                        p.ws.send(JSON.stringify({ type: 'player_joined', id: pId, name: pName }));
                    }
                }

                lob.players.set(pId, { ws: ws, name: pName });

                ws.send(JSON.stringify({
                    type: 'joined_lobby',
                    lobby: { id: lob.id, name: lob.name, maxPlayers: lob.maxPlayers, isHost: false }
                }));
            }

            // 4. Player state broadcast
            else if (data.type === 'state' && currentLobbyId) {
                const lob = lobbies.get(currentLobbyId);
                if (!lob) return;

                const packet = JSON.stringify({
                    type: 'remote_state',
                    id: pId,
                    name: data.name,
                    x: data.x,
                    y: data.y,
                    z: data.z,
                    rotY: data.rotY
                });

                for (let [otherId, p] of lob.players) {
                    if (otherId !== pId && p.ws.readyState === 1) {
                        p.ws.send(packet);
                    }
                }
            }

            // 5. Chat message
            else if (data.type === 'chat' && currentLobbyId) {
                const lob = lobbies.get(currentLobbyId);
                if (!lob) return;

                const packet = JSON.stringify({ type: 'chat', name: data.name, msg: data.msg });
                for (let [otherId, p] of lob.players) {
                    if (p.ws.readyState === 1) {
                        p.ws.send(packet);
                    }
                }
            }

        } catch (e) {
            console.error('WS parse error:', e);
        }
    });

    ws.on('close', () => {
        if (currentLobbyId && lobbies.has(currentLobbyId)) {
            const lob = lobbies.get(currentLobbyId);
            lob.players.delete(pId);

            // Broadcast leave
            for (let [otherId, p] of lob.players) {
                if (p.ws.readyState === 1) {
                    p.ws.send(JSON.stringify({ type: 'player_left', id: pId }));
                }
            }

            if (lob.players.size === 0) {
                lobbies.delete(currentLobbyId);
            }
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[BSS Server] Running on http://localhost:${PORT}`);
});
