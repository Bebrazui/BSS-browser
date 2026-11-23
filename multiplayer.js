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

    // WebRTC connections: peerId -> { pc, dc, name, pendingCandidates: [] }
    let peerConnections = new Map();
    let remotePlayers = new Map();

    // Standalone mesh for rendering other players
    let remotePlayerMesh = null;

    const RTC_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
            {
                urls: 'turn:openrelay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:openrelay.metered.ca:443?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
        ],
        iceCandidatePoolSize: 10
    };

    const TOPIC_LOBBIES = 'bss/v1/lobbies';
    let roomTopic = null;

    let pendingLobbiesCallback = null;
    let knownLobbies = new Map();

    let isConnectingMqtt = false;
    let connectQueue = [];

    function initSignaling(onReady) {
        if (mqttClient && isMqttConnected) {
            if (onReady) onReady();
            return;
        }

        if (onReady) connectQueue.push(onReady);
        if (isConnectingMqtt) return;
        isConnectingMqtt = true;

        updateStatusIndicator('Connecting to signaling broker...');
        mqttClient = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
            clientId: 'bss_' + myId + '_' + Math.random().toString(36).substr(2, 4),
            clean: true,
            keepalive: 60,
            connectTimeout: 10000,
            reconnectPeriod: 2000
        });

        mqttClient.on('connect', function() {
            isConnectingMqtt = false;
            isMqttConnected = true;
            console.log('[Multiplayer] Signaling connected:', myId);
            updateStatusIndicator('Online (Signaling Ready)', '#2ecc71');

            mqttClient.subscribe(TOPIC_LOBBIES, { qos: 0 });
            if (roomTopic) {
                mqttClient.subscribe(roomTopic, { qos: 0 }, function() {
                    console.log('[MQTT] Resubscribed to room:', roomTopic);
                });
            }

            while (connectQueue.length > 0) {
                const cb = connectQueue.shift();
                try { cb(); } catch(e){}
            }
        });

        mqttClient.on('message', function(topic, payload) {
            try {
                const data = JSON.parse(payload.toString());
                console.log('[MQTT INCOMING]', topic, data.type, 'from:', data.from, 'to:', data.target);
                handleSignalingMessage(topic, data);
            } catch(e) {
                console.warn('[Multiplayer MQTT parse err]', e);
            }
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
        } else if (topic.startsWith('bss/v1/room/')) {
            // Room-wide exchange: ignore messages sent by myself
            if (data.from === myId) return;

            console.log('[Room MSG]', data.type, 'from:', data.from, 'to:', data.target, 'isHost:', isHost, 'myId:', myId);

            if (data.type === 'offer' && isHost && (!data.target || data.target === myId)) {
                handleClientOffer(data);
            } else if (data.type === 'answer' && !isHost && data.target === myId) {
                handleHostAnswer(data);
            } else if (data.type === 'candidate' && data.target === myId) {
                handleIceCandidateMsg(data);
            }
        }
    }

    function handleIceCandidateMsg(data) {
        const conn = peerConnections.get(data.from);
        if (!conn || !conn.pc) return;

        if (conn.pc.remoteDescription && conn.pc.remoteDescription.type) {
            conn.pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(e => console.warn('ICE add error:', e));
        } else {
            // Buffer candidate until remote description is set
            conn.pendingCandidates.push(data.candidate);
        }
    }

    function flushCandidates(conn) {
        if (!conn || !conn.pc || !conn.pendingCandidates) return;
        while (conn.pendingCandidates.length > 0) {
            const cand = conn.pendingCandidates.shift();
            conn.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(e => console.warn('ICE flush error:', e));
        }
    }

    function deliverLobbies() {
        const now = Date.now();
        const list = [];
        for (let [id, lob] of knownLobbies) {
            // Keep lobby active for 3.5 seconds without announce
            if (now - lob.timestamp < 3500) {
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
            // Immediate delivery of already known active lobbies
            deliverLobbies();

            // Query active hosts with 3 quick probes
            mqttClient.publish(TOPIC_LOBBIES, JSON.stringify({ type: 'query' }), { qos: 1 });
            setTimeout(() => {
                if (isMqttConnected) mqttClient.publish(TOPIC_LOBBIES, JSON.stringify({ type: 'query' }));
            }, 300);

            // Wait a bit and deliver aggregated results
            setTimeout(deliverLobbies, 800);
            setTimeout(deliverLobbies, 1500);
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
        }), { retain: false, qos: 1 });
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

            roomTopic = 'bss/v1/room/' + lobId;
            mqttClient.subscribe(roomTopic, { qos: 1 }, function() {
                console.log('[Host] Subscribed to room topic:', roomTopic);
            });

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

        console.log('[Host] Processing client offer from:', clientPeerId);
        const pc = new RTCPeerConnection(RTC_CONFIG);
        const connObj = { pc: pc, dc: null, name: data.playerName || 'BeeKeeper', pendingCandidates: [] };
        peerConnections.set(clientPeerId, connObj);

        pc.onicecandidate = (e) => {
            if (e.candidate && roomTopic) {
                mqttClient.publish(roomTopic, JSON.stringify({
                    type: 'candidate',
                    from: myId,
                    target: clientPeerId,
                    candidate: e.candidate
                }));
            }
        };

        pc.ondatachannel = (e) => {
            console.log('[Host] Received DataChannel from client:', clientPeerId);
            connObj.dc = e.channel;
            setupDataChannel(clientPeerId, connObj);
        };

        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        flushCandidates(connObj);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        mqttClient.publish(roomTopic, JSON.stringify({
            type: 'answer',
            from: myId,
            target: clientPeerId,
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
            roomTopic = 'bss/v1/room/' + lobbyId;

            mqttClient.subscribe(roomTopic, { qos: 1 }, function() {
                console.log('[Client] Subscribed to room topic:', roomTopic);
                startP2PHandshake();
            });

            function startP2PHandshake() {
                const pc = new RTCPeerConnection(RTC_CONFIG);
                const dc = pc.createDataChannel('bss-p2p', { ordered: false, maxRetransmits: 0 });
                const connObj = { pc: pc, dc: dc, name: 'Host', pendingCandidates: [] };
                peerConnections.set(hostId, connObj);

                pc.onicecandidate = (e) => {
                    if (e.candidate && roomTopic) {
                        mqttClient.publish(roomTopic, JSON.stringify({
                            type: 'candidate',
                            from: myId,
                            target: hostId,
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
                    console.log('[Client] Sending offer to host:', hostId, 'in room:', roomTopic);
                    const offerPayload = JSON.stringify({
                        type: 'offer',
                        from: myId,
                        target: hostId,
                        offer: pc.localDescription,
                        playerName: myName
                    });
                    mqttClient.publish(roomTopic, offerPayload);
                    // Retry send offer after 600ms if no answer yet
                    setTimeout(() => {
                        if (connObj.pc.signalingState === 'have-local-offer') {
                            console.log('[Client] Retrying offer send...');
                            mqttClient.publish(roomTopic, offerPayload);
                        }
                    }, 600);
                });

                joinTimeout = setTimeout(() => {
                    if (connObj.dc && connObj.dc.readyState !== 'open') {
                        console.warn('[WebRTC] Timeout. Host state:', pc.connectionState, 'ICE state:', pc.iceConnectionState, 'Signaling:', pc.signalingState);
                        if (onError) onError('P2P connection timed out (Хост недоступен или уже закрыл лобби)');
                        peerConnections.delete(hostId);
                        try { pc.close(); } catch(e){}
                    }
                }, 10000);
            }
        });
    }

    async function handleHostAnswer(data) {
        const hostId = data.from;
        console.log('[Client] Received answer from host:', hostId);
        const conn = peerConnections.get(hostId);
        if (conn && conn.pc) {
            conn.name = data.hostName || 'Host';
            await conn.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            flushCandidates(conn);
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
                    addChatMessage(data.name, data.msg);
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

    function initRemoteMesh() {
        if (remotePlayerMesh || typeof Mesh === 'undefined') return;
        remotePlayerMesh = new Mesh(false);
        remotePlayerMesh.setMeshFromFunction(function(box) {
            // Distinct player avatar (head + body + backpack)
            box(0, 0, 0, 0.5, 1.0, 0.5, false, [0.4, 0.8, 1.0]); // Body
            box(0, 0.8, 0, 0.4, 0.4, 0.4, false, [1.0, 0.85, 0.7]); // Head
            box(0, 0.1, -0.35, 0.4, 0.7, 0.3, false, [0.9, 0.7, 0.1]); // Backpack
        });
        remotePlayerMesh.setBuffers();
    }

    function startGame(playerRef) {
        localPlayerRef = playerRef;
        initRemoteMesh();

        const chatBox = document.getElementById('mpChatContainer');
        if (chatBox) chatBox.style.display = 'flex';
        initChatHandlers();

        if (updateInterval) clearInterval(updateInterval);
        updateInterval = setInterval(broadcastState, 50); // 20 updates per sec
        updateUI();
    }

    function initChatHandlers() {
        const sendBtn = document.getElementById('mpChatSendBtn');
        const chatInput = document.getElementById('mpChatInput');
        if (sendBtn && chatInput) {
            sendBtn.onclick = function() {
                const text = chatInput.value.trim();
                if (!text) return;
                chatInput.value = '';
                sendChat(text);
                addChatMessage(myName, text, true);
            };
        }
    }

    function addChatMessage(name, text, isMe = false) {
        const msgs = document.getElementById('mpChatMessages');
        if (!msgs) return;
        const div = document.createElement('div');
        div.style.lineHeight = '1.3';
        div.style.wordBreak = 'break-word';
        div.innerHTML = `<span style='color:${isMe ? "#70d6ff" : "#9dff96"};font-weight:bold;'>${name}:</span> ${escapeHtml(text)}`;
        msgs.appendChild(div);
        msgs.scrollTop = msgs.scrollHeight;
    }

    function escapeHtml(str) {
        return str.replace(/[&<>'"]/g, tag => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        }[tag] || tag));
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

    function render(gl, glCache, fallbackMesh) {
        if (remotePlayers.size === 0) return;
        if (!remotePlayerMesh) initRemoteMesh();
        const meshToRender = remotePlayerMesh || fallbackMesh;
        if (!meshToRender) return;

        for (let rp of remotePlayers.values()) {
            if (rp.modelMatrix) {
                gl.uniformMatrix4fv(glCache.dynamic_modelMatrix, gl.FALSE, rp.modelMatrix);
                meshToRender.render();
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
        const count = peerConnections.size + 1;
        const el = document.getElementById('mpPlayerCount');
        if (el) {
            if (!currentLobby) {
                el.style.display = 'none';
            } else {
                el.style.display = 'block';
                el.innerHTML = `Lobby: <b>${currentLobby.name}</b> | Players: <b>${count}/${currentLobby.maxPlayers}</b> (P2P)`;
            }
        }
        const chatCount = document.getElementById('mpChatOnlineCount');
        if (chatCount) {
            chatCount.innerHTML = `Online: ${count}`;
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
