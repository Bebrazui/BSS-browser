// WebRTC Direct P2P with Nostr Decentralized Signaling (nos.lol, primal.net, nostr.wine)
window.Multiplayer = (function() {
    let myName = localStorage.getItem('bss_player_name') || ('Player_' + Math.floor(Math.random() * 900 + 100));
    let localPlayerRef = null;
    let isHost = false;
    let currentLobby = null;
    let updateInterval = null;

    // Nostr crypto identity
    const Nostr = window.NostrTools;
    let sk = null;
    let pk = null;
    let myId = null;

    function initKeys() {
        if (!sk) {
            sk = Nostr.generateSecretKey();
            pk = Nostr.getPublicKey(sk);
            myId = pk.substr(0, 12);
        }
    }

    const RELAYS = [
        'wss://nos.lol',
        'wss://primal.net',
        'wss://nostr.wine',
        'wss://relay.damus.io',
        'wss://relay.snort.social'
    ];

    let pool = null;
    let poolSub = null;
    let isSignalingReady = false;

    // WebRTC connections: peerId -> { pc, dc, name, pendingCandidates: [] }
    let peerConnections = new Map();
    let remotePlayers = new Map();
    let remotePlayerMesh = null;

    const RTC_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
            { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
            { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
            { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
        ],
        iceCandidatePoolSize: 10
    };

    let pendingLobbiesCallback = null;
    let knownLobbies = new Map();

    function initSignaling(onReady) {
        initKeys();
        if (isSignalingReady && pool) {
            if (onReady) onReady();
            return;
        }

        updateStatusIndicator('Connecting to Nostr Relays...');
        if (!pool) {
            pool = new Nostr.SimplePool();
        }

        // Subscribe to BSS Game channel (tag: bss-v2)
        const sub = pool.subscribeMany(
            RELAYS,
            [{ kinds: [20001], '#t': ['bss-v2'], since: Math.floor(Date.now() / 1000) - 10 }],
            {
                onevent(event) {
                    try {
                        const data = JSON.parse(event.content);
                        handleSignalingMessage(data);
                    } catch(e){}
                }
            }
        );
        poolSub = sub;

        isSignalingReady = true;
        console.log('[Multiplayer Nostr] Connected with PubKey:', pk);
        updateStatusIndicator('Online (Nostr Ready)', '#2ecc71');

        if (onReady) onReady();
    }

    async function sendNostrMessage(payload) {
        initKeys();
        if (!pool) pool = new Nostr.SimplePool();

        payload.from = pk;
        payload.fromShort = myId;

        const eventTemplate = {
            kind: 20001, // Ephemeral custom event
            created_at: Math.floor(Date.now() / 1000),
            tags: [['t', 'bss-v2']],
            content: JSON.stringify(payload)
        };

        const signedEvent = Nostr.finalizeEvent(eventTemplate, sk);
        await Promise.any(pool.publish(RELAYS, signedEvent));
    }

    function handleSignalingMessage(data) {
        if (!data || data.from === pk) return; // Ignore own echoes

        if (data.type === 'announce') {
            knownLobbies.set(data.lobbyId, {
                id: data.lobbyId,
                name: data.name,
                maxPlayers: data.maxPlayers,
                players: data.playerCount || 1,
                hostPk: data.from,
                hostId: data.fromShort,
                timestamp: Date.now()
            });
            deliverLobbies();
        } else if (data.type === 'query' && isHost && currentLobby) {
            broadcastLobbyAnnounce();
        } else if (data.target === pk) {
            console.log('[Nostr Signaling Direct]', data.type, 'from:', data.fromShort);
            if (data.type === 'offer' && isHost) {
                handleClientOffer(data);
            } else if (data.type === 'answer' && !isHost) {
                handleHostAnswer(data);
            } else if (data.type === 'candidate') {
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
            if (now - lob.timestamp < 4500) {
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
            deliverLobbies();
            sendNostrMessage({ type: 'query' });
            setTimeout(deliverLobbies, 600);
            setTimeout(deliverLobbies, 1200);
        });
    }

    let heartbeatTimer = null;
    function broadcastLobbyAnnounce() {
        if (!isHost || !currentLobby) return;
        sendNostrMessage({
            type: 'announce',
            lobbyId: currentLobby.id,
            name: currentLobby.name,
            maxPlayers: currentLobby.maxPlayers,
            playerCount: peerConnections.size + 1
        });
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
                hostPk: pk,
                hostId: myId
            };

            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = setInterval(broadcastLobbyAnnounce, 2000);
            broadcastLobbyAnnounce();

            console.log('[Nostr Host] Created lobby:', currentLobby.name);
            if (onSuccess) onSuccess(currentLobby);
            updateUI();
        });
    }

    async function handleClientOffer(data) {
        const clientPk = data.from;
        if (peerConnections.size + 1 >= currentLobby.maxPlayers) return;

        console.log('[Nostr Host] Processing Offer from:', data.fromShort);
        const pc = new RTCPeerConnection(RTC_CONFIG);
        const connObj = { pc: pc, dc: null, name: data.playerName || 'BeeKeeper', pendingCandidates: [] };
        peerConnections.set(clientPk, connObj);

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                sendNostrMessage({
                    type: 'candidate',
                    target: clientPk,
                    candidate: e.candidate
                });
            }
        };

        pc.ondatachannel = (e) => {
            console.log('[Nostr Host] DataChannel opened with client:', data.fromShort);
            connObj.dc = e.channel;
            setupDataChannel(clientPk, connObj);
        };

        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        flushCandidates(connObj);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        console.log('[Nostr Host] Sending Answer back to:', data.fromShort);
        sendNostrMessage({
            type: 'answer',
            target: clientPk,
            answer: answer,
            hostName: myName,
            lobby: currentLobby
        });
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
            const hostPk = lob.hostPk;

            console.log('[Nostr Client] Joining lobby with host:', lob.hostId);
            const pc = new RTCPeerConnection(RTC_CONFIG);
            const dc = pc.createDataChannel('bss-p2p', { ordered: false, maxRetransmits: 0 });
            const connObj = { pc: pc, dc: dc, name: 'Host', pendingCandidates: [] };
            peerConnections.set(hostPk, connObj);

            pc.onicecandidate = (e) => {
                if (e.candidate) {
                    sendNostrMessage({
                        type: 'candidate',
                        target: hostPk,
                        candidate: e.candidate
                    });
                }
            };

            setupDataChannel(hostPk, connObj, () => {
                if (joinTimeout) clearTimeout(joinTimeout);
                if (onSuccess) onSuccess(currentLobby);
            });

            pc.createOffer().then(offer => {
                return pc.setLocalDescription(offer);
            }).then(() => {
                console.log('[Nostr Client] Sending Offer to host:', lob.hostId);
                const payload = {
                    type: 'offer',
                    target: hostPk,
                    offer: pc.localDescription,
                    playerName: myName
                };
                sendNostrMessage(payload);

                // Auto-retry once after 1s
                setTimeout(() => {
                    if (connObj.pc.signalingState === 'have-local-offer') {
                        console.log('[Nostr Client] Retrying Offer...');
                        sendNostrMessage(payload);
                    }
                }, 1000);
            });

            joinTimeout = setTimeout(() => {
                if (connObj.dc && connObj.dc.readyState !== 'open') {
                    console.warn('[WebRTC] Timeout. Host state:', pc.connectionState, 'ICE state:', pc.iceConnectionState, 'Signaling:', pc.signalingState);
                    if (onError) onError('P2P connection timed out (Не удалось связаться с хостом)');
                    peerConnections.delete(hostPk);
                    try { pc.close(); } catch(e){}
                }
            }, 10000);
        });
    }

    async function handleHostAnswer(data) {
        const hostPk = data.from;
        console.log('[Nostr Client] Received Answer from host!');
        const conn = peerConnections.get(hostPk);
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
            box(0, 0, 0, 0.5, 1.0, 0.5, false, [0.4, 0.8, 1.0]);
            box(0, 0.8, 0, 0.4, 0.4, 0.4, false, [1.0, 0.85, 0.7]);
            box(0, 0.1, -0.35, 0.4, 0.7, 0.3, false, [0.9, 0.7, 0.1]);
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
        updateInterval = setInterval(broadcastState, 50);
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

    function sendChat(text) {
        const packet = JSON.stringify({ type: 'chat', name: myName, msg: text });
        for (let conn of peerConnections.values()) {
            if (conn.dc && conn.dc.readyState === 'open') {
                conn.dc.send(packet);
            }
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
