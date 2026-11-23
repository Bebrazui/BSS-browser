// WebRTC Direct P2P with EMQX Public MQTT Signaling + Google STUN
window.Multiplayer = (function() {
    let myName = localStorage.getItem('bss_player_name') || ('Player_' + Math.floor(Math.random() * 900 + 100));
    let myId = 'peer_' + Math.random().toString(36).substr(2, 9);
    let localPlayerRef = null;
    let isHost = false;
    let currentLobby = null;
    let updateInterval = null;

    let mqttClient = null;
    let isMqttConnected = false;

    // WebRTC connections: peerId -> { pc, dc, name }
    let peerConnections = new Map();
    let remotePlayers = new Map();

    const RTC_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
        ]
    };

    const TOPIC_LOBBIES = 'bss/v1/lobbies';
    const TOPIC_DIRECT = 'bss/v1/user/' + myId;

    let pendingLobbiesCallback = null;
    let knownLobbies = new Map();

    function initSignaling(onReady) {
        if (mqttClient && isMqttConnected) {
            if (onReady) onReady();
            return;
        }

        updateStatusIndicator('Connecting to signaling broker...');
        // Public EMQX WSS Broker (Open & Reliable worldwide)
        mqttClient = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
            clientId: 'bss_' + myId,
            clean: true,
            connectTimeout: 5000,
            reconnectPeriod: 3000
        });

        mqttClient.on('connect', function() {
            isMqttConnected = true;
            console.log('[Multiplayer] Signaling connected:', myId);
            updateStatusIndicator('Online (Signaling Ready)', '#2ecc71');

            mqttClient.subscribe(TOPIC_LOBBIES);
            mqttClient.subscribe(TOPIC_DIRECT);

            if (onReady) onReady();
        });

        mqttClient.on('message', function(topic, payload) {
            try {
                const data = JSON.parse(payload.toString());
                handleSignalingMessage(topic, data);
            } catch(e) {}
        });

        mqttClient.on('error', function(err) {
            console.warn('[Multiplayer] Signaling error:', err);
            updateStatusIndicator('Signaling error: ' + (err.message || 'offline'), '#e74c3c');
        });

        mqttClient.on('close', function() {
            isMqttConnected = false;
            updateStatusIndicator('Signaling Disconnected', '#e67e22');
        });
    }

    function handleSignalingMessage(topic, data) {
        if (topic === TOPIC_LOBBIES) {
            if (data.type === 'announce' && data.hostId !== myId) {
                knownLobbies.set(data.lobbyId, {
                    id: data.lobbyId,
                    name: data.name,
                    maxPlayers: data.maxPlayers,
                    players: data.playerCount || 1,
                    hostId: data.hostId,
                    timestamp: Date.now()
                });
                deliverLobbies();
            } else if (data.type === 'query' && isHost && currentLobby) {
                broadcastLobbyAnnounce();
            }
        } else if (topic === TOPIC_DIRECT) {
            // Direct WebRTC negotiation messages
            if (data.type === 'offer' && isHost) {
                handleClientOffer(data);
            } else if (data.type === 'answer' && !isHost) {
                handleHostAnswer(data);
            } else if (data.type === 'candidate') {
                const conn = peerConnections.get(data.from);
                if (conn && conn.pc && data.candidate) {
                    conn.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(() => {});
                }
            }
        }
    }

    function deliverLobbies() {
        const now = Date.now();
        const list = [];
        for (let [id, lob] of knownLobbies) {
            if (now - lob.timestamp < 10000) {
                list.push(lob);
            } else {
                knownLobbies.delete(id);
            }
        }
        if (pendingLobbiesCallback) {
            pendingLobbiesCallback(list);
        }
    }

    function refreshLobbies(callback) {
        pendingLobbiesCallback = callback;
        initSignaling(function() {
            mqttClient.publish(TOPIC_LOBBIES, JSON.stringify({ type: 'query' }));
            setTimeout(deliverLobbies, 1000);
        });
    }

    let heartbeatTimer = null;
    function broadcastLobbyAnnounce() {
        if (!isHost || !currentLobby || !isMqttConnected) return;
        mqttClient.publish(TOPIC_LOBBIES, JSON.stringify({
            type: 'announce',
            lobbyId: currentLobby.id,
            name: currentLobby.name,
            maxPlayers: currentLobby.maxPlayers,
            playerCount: peerConnections.size + 1,
            hostId: myId
        }));
    }

    function createLobby(name, maxPlayers, onSuccess, onError) {
        initSignaling(function() {
            isHost = true;
            const lobId = 'lob_' + Math.random().toString(36).substr(2, 6);
            const max = Math.max(2, Math.min(5, parseInt(maxPlayers) || 4));

            currentLobby = {
                id: lobId,
                name: (name || 'Bee Room').trim().substr(0, 20),
                maxPlayers: max,
                hostId: myId
            };

            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(broadcastLobbyAnnounce, 2500);
            broadcastLobbyAnnounce();

            if (onSuccess) onSuccess(currentLobby);
            updateUI();
        });
    }

    async function handleClientOffer(data) {
        const clientPeerId = data.from;
        if (peerConnections.size + 1 >= currentLobby.maxPlayers) return;

        const pc = new RTCPeerConnection(RTC_CONFIG);
        const connObj = { pc: pc, dc: null, name: data.playerName || 'BeeKeeper' };
        peerConnections.set(clientPeerId, connObj);

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                mqttClient.publish('bss/v1/user/' + clientPeerId, JSON.stringify({
                    type: 'candidate',
                    from: myId,
                    candidate: e.candidate
                }));
            }
        };

        pc.ondatachannel = (e) => {
            connObj.dc = e.channel;
            setupDataChannel(clientPeerId, connObj);
        };

        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        mqttClient.publish('bss/v1/user/' + clientPeerId, JSON.stringify({
            type: 'answer',
            from: myId,
            answer: answer,
            hostName: myName,
            lobby: currentLobby
        }));
    }

    let joinTimeout = null;
    function joinLobby(lobbyId, onSuccess, onError) {
        initSignaling(function() {
            isHost = false;
            const lob = knownLobbies.get(lobbyId);
            if (!lob) {
                if (onError) onError('Lobby not found');
                return;
            }

            currentLobby = lob;
            const hostId = lob.hostId;

            const pc = new RTCPeerConnection(RTC_CONFIG);
            const dc = pc.createDataChannel('bss-p2p', { ordered: false, maxRetransmits: 0 });
            const connObj = { pc: pc, dc: dc, name: 'Host' };
            peerConnections.set(hostId, connObj);

            pc.onicecandidate = (e) => {
                if (e.candidate) {
                    mqttClient.publish('bss/v1/user/' + hostId, JSON.stringify({
                        type: 'candidate',
                        from: myId,
                        candidate: e.candidate
                    }));
                }
            };

            setupDataChannel(hostId, connObj, () => {
                if (joinTimeout) clearTimeout(joinTimeout);
                if (onSuccess) onSuccess(currentLobby);
            });

            pc.createOffer().then(offer => {
                return pc.setLocalDescription(offer);
            }).then(() => {
                mqttClient.publish('bss/v1/user/' + hostId, JSON.stringify({
                    type: 'offer',
                    from: myId,
                    offer: pc.localDescription,
                    playerName: myName
                }));
            });

            joinTimeout = setTimeout(() => {
                if (connObj.dc && connObj.dc.readyState !== 'open') {
                    if (onError) onError('P2P connection timed out');
                    peerConnections.delete(hostId);
                    try { pc.close(); } catch(e){}
                }
            }, 8000);
        });
    }

    async function handleHostAnswer(data) {
        const hostId = data.from;
        const conn = peerConnections.get(hostId);
        if (conn && conn.pc) {
            conn.name = data.hostName || 'Host';
            await conn.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
    }

    function setupDataChannel(peerId, connObj, onOpenCb) {
        const dc = connObj.dc;

        dc.onopen = () => {
            console.log('[WebRTC Direct P2P Connected] to', peerId);
            if (onOpenCb) onOpenCb();
            if (localPlayerRef && localPlayerRef.addMessage) {
                localPlayerRef.addMessage(`${connObj.name} connected directly (P2P)!`, [255, 215, 0]);
            }
            updateUI();
        };

        dc.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'state') {
                    handleRemoteState(peerId, data);
                } else if (data.type === 'chat') {
                    if (localPlayerRef && localPlayerRef.addMessage) {
                        localPlayerRef.addMessage(`[${data.name}]: ${data.msg}`, [100, 255, 100]);
                    }
                }
            } catch(e) {}
        };

        dc.onclose = () => {
            peerConnections.delete(peerId);
            remotePlayers.delete(peerId);
            if (localPlayerRef && localPlayerRef.addMessage) {
                localPlayerRef.addMessage(`${connObj.name} disconnected.`, [255, 100, 100]);
            }
            updateUI();
        };
    }

    function handleRemoteState(peerId, data) {
        let rp = remotePlayers.get(peerId);
        if (!rp) {
            rp = {
                name: data.name || 'BeeKeeper',
                modelMatrix: new Float32Array(16)
            };
            remotePlayers.set(peerId, rp);
            updateUI();
        }

        rp.name = data.name || rp.name;
        rp.x = data.x;
        rp.y = data.y;
        rp.z = data.z;
        rp.rotY = data.rotY;

        mat4.identity(rp.modelMatrix);
        mat4.translate(rp.modelMatrix, rp.modelMatrix, [rp.x, rp.y, rp.z]);
        mat4.rotateY(rp.modelMatrix, rp.modelMatrix, rp.rotY || 0);
    }

    function startGame(playerRef) {
        localPlayerRef = playerRef;
        if (updateInterval) clearInterval(updateInterval);
        updateInterval = setInterval(broadcastState, 50); // 20 updates per sec
        updateUI();
    }

    function broadcastState() {
        if (!localPlayerRef || !localPlayerRef.body || peerConnections.size === 0) return;

        const packet = JSON.stringify({
            type: 'state',
            name: myName,
            x: localPlayerRef.body.position.x,
            y: localPlayerRef.body.position.y,
            z: localPlayerRef.body.position.z,
            rotY: localPlayerRef.playerAngle || 0
        });

        for (let conn of peerConnections.values()) {
            if (conn.dc && conn.dc.readyState === 'open') {
                conn.dc.send(packet);
            }
        }
    }

    function render(gl, glCache, playerMesh) {
        if (remotePlayers.size === 0 || !playerMesh) return;
        for (let rp of remotePlayers.values()) {
            if (rp.modelMatrix) {
                gl.uniformMatrix4fv(glCache.dynamic_modelMatrix, gl.FALSE, rp.modelMatrix);
                playerMesh.render();
            }
        }
    }

    function updateStatusIndicator(text, color = '#555') {
        const el = document.getElementById('mpSignalingStatus');
        if (el) {
            el.innerHTML = `<span style='display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:6px;'></span>${text}`;
        }
    }

    function setPlayerName(name) {
        if (!name) return;
        myName = name.trim().substr(0, 15);
        localStorage.setItem('bss_player_name', myName);
        updateUI();
    }

    function getPlayerName() {
        return myName;
    }

    function updateUI() {
        const el = document.getElementById('mpPlayerCount');
        if (el) {
            if (!currentLobby) {
                el.style.display = 'none';
            } else {
                el.style.display = 'block';
                el.innerHTML = `Lobby: <b>${currentLobby.name}</b> | Players: <b>${peerConnections.size + 1}/${currentLobby.maxPlayers}</b> (P2P)`;
            }
        }
    }

    return {
        setName: setPlayerName,
        getName: getPlayerName,
        refreshLobbies: refreshLobbies,
        createLobby: createLobby,
        joinLobby: joinLobby,
        startGame: startGame,
        render: render,
        initSignaling: initSignaling,
        isInMultiplayer: () => !!currentLobby
    };
})();
