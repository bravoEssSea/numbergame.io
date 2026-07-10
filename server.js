const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Master Game State
let players = {}; 
let gamePhase = 'LOBBY'; 
let previousPhase = 'CHOICE_PHASE'; 
let phaseTimer = 0;
let hostId = null;
let gameTicker = null;

let roundCounter = 1;
let currentMaxNodes = 20; 
let podiumData = []; 
let rouletteNumber = null;

function changePhase(newPhase, duration) {
    gamePhase = newPhase;
    phaseTimer = duration;
    
    if (newPhase === 'CHOICE_PHASE') {
        rouletteNumber = null;
        Object.keys(players).forEach(id => {
            if (players[id].isAlive && players[id].isRegistered) {
                if (currentMaxNodes === 5) {
                    players[id].currentChoice = null;
                }
            }
        });
    }
    
    if (newPhase === 'GET_READY') {
        evaluateChoices();
    }
    
    broadcastState();
}

function evaluateChoices() {
    let counts = {};
    let alivePlayers = Object.values(players).filter(p => p.isAlive && p.isRegistered);

    if (currentMaxNodes === 5) {
        rouletteNumber = Math.floor(Math.random() * 5) + 1;
        io.emit('roulette_reveal', rouletteNumber);

        setTimeout(() => {
            Object.keys(players).forEach(id => {
                let p = players[id];
                if (p.isAlive && p.isRegistered) {
                    if (p.currentChoice === null || p.currentChoice === rouletteNumber) {
                        p.isAlive = false;
                        p.eliminatedInRound = roundCounter;
                        io.to(id).emit('player_status', 'ELIMINATED');
                    }
                }
            });
            finalizeRoundProgress();
        }, 3000);

    } else {
        alivePlayers.forEach(p => {
            if (p.currentChoice !== null) {
                counts[p.currentChoice] = (counts[p.currentChoice] || 0) + 1;
            }
        });

        Object.keys(players).forEach(id => {
            let p = players[id];
            if (p.isAlive && p.isRegistered) {
                if (p.currentChoice === null || counts[p.currentChoice] > 1) {
                    p.isAlive = false;
                    p.eliminatedInRound = roundCounter;
                    io.to(id).emit('player_status', 'ELIMINATED');
                }
            }
        });
        finalizeRoundProgress();
    }
}

function finalizeRoundProgress() {
    let survivors = Object.values(players).filter(p => p.isAlive && p.isRegistered);
    
    if (survivors.length <= 1) {
        buildPodium();
        gamePhase = 'GAME_OVER';
        if (gameTicker) clearInterval(gameTicker);
        broadcastState();
    } else {
        roundCounter++;
        if (roundCounter % 3 === 1 && roundCounter > 1) {
            currentMaxNodes = Math.max(5, currentMaxNodes - 5); 
            
            Object.keys(players).forEach(id => {
                if (players[id].currentChoice > currentMaxNodes) {
                    players[id].currentChoice = null; 
                }
            });

            io.emit('announcement', `⚠️ BOTTLENECK! Circle compressed to ${currentMaxNodes} options!`);
        }
        broadcastState();
    }
}

function buildPodium() {
    let ranked = Object.values(players)
        .filter(p => p.isRegistered)
        .sort((a, b) => {
            if (a.isAlive && !b.isAlive) return -1;
            if (!a.isAlive && b.isAlive) return 1;
            return b.eliminatedInRound - a.eliminatedInRound;
        });

    podiumData = ranked.slice(0, 3).map((p, index) => ({
        name: p.name,
        placement: index + 1,
        score: p.isAlive ? "🏆 Survivor" : `Round ${p.eliminatedInRound}`
    }));
}

function broadcastState() {
    let registeredPlayers = Object.values(players).filter(p => p.isRegistered);
    let aliveCount = registeredPlayers.filter(p => p.isAlive).length;
    
    let lobbyRegistry = Object.values(players).map(p => ({
        id: p.id,
        name: p.name,
        isAlive: p.isAlive,
        isRegistered: p.isRegistered,
        currentChoice: p.currentChoice 
    }));

    io.emit('state_update', {
        phase: gamePhase,
        timeLeft: phaseTimer,
        activePlayers: aliveCount,
        totalConnections: registeredPlayers.length,
        hostId: hostId,
        lobbyRegistry: lobbyRegistry,
        round: roundCounter,
        maxNodes: currentMaxNodes,
        podium: podiumData,
        roulette: rouletteNumber
    });
}

function startGameLoop() {
    if (gameTicker) clearInterval(gameTicker);
    gameTicker = setInterval(() => {
        if (gamePhase === 'LOBBY' || gamePhase === 'PAUSED' || gamePhase === 'GAME_OVER') return;

        if (phaseTimer > 0) {
            phaseTimer--;
            broadcastState();
        } else {
            if (gamePhase === 'CHOICE_PHASE') {
                changePhase('GET_READY', 8); 
            } else if (gamePhase === 'GET_READY') {
                let survivors = Object.values(players).filter(p => p.isAlive && p.isRegistered);
                if (survivors.length > 1) {
                    changePhase('CHOICE_PHASE', 5);
                } else {
                    buildPodium();
                    gamePhase = 'GAME_OVER';
                    broadcastState();
                    if (gameTicker) clearInterval(gameTicker);
                }
            }
        }
    }, 1000);
}

io.on('connection', (socket) => {
    if (!hostId) hostId = socket.id;

    players[socket.id] = {
        id: socket.id,
        name: 'Spectating...',
        isAlive: false,
        isRegistered: false,
        currentChoice: null,
        eliminatedInRound: 0
    };

    broadcastState();

    socket.on('register_player', (nickname) => {
        if (!players[socket.id]) return;
        players[socket.id].name = nickname;
        players[socket.id].isRegistered = true;
        players[socket.id].isAlive = (gamePhase === 'LOBBY');
        
        socket.emit('player_status', players[socket.id].isAlive ? 'ALIVE' : 'SPECTATOR');
        broadcastState();
    });

    socket.on('host_action', (action) => {
        if (socket.id !== hostId) return;

        if (action === 'start') {
            // FIXED: Check what phase we are currently in when 'start' is pressed
            if (gamePhase === 'GAME_OVER') {
                // If ending a match, kick back to the baseline LOBBY state first
                gamePhase = 'LOBBY';
                phaseTimer = 0;
                roundCounter = 1;
                currentMaxNodes = 20;
                podiumData = [];
                rouletteNumber = null;
                
                Object.keys(players).forEach(id => {
                    if (players[id].isRegistered) {
                        players[id].isAlive = true;
                        players[id].currentChoice = null;
                        players[id].eliminatedInRound = 0;
                    }
                });
                
                io.emit('player_status', 'ALIVE');
                io.emit('announcement', "🔄 Match returned to Lobby! Waiting for host to start.");
                broadcastState();
            } else if (gamePhase === 'LOBBY') {
                // If in the lobby, begin the countdown loops immediately
                roundCounter = 1;
                currentMaxNodes = 20; 
                podiumData = [];
                rouletteNumber = null;
                Object.keys(players).forEach(id => {
                    if (players[id].isRegistered) {
                        players[id].isAlive = true;
                        players[id].currentChoice = null;
                        players[id].eliminatedInRound = 0;
                    }
                });
                io.emit('player_status', 'ALIVE');
                changePhase('CHOICE_PHASE', 5);
                startGameLoop();
            }
        } else if (action === 'pause' && gamePhase !== 'LOBBY' && gamePhase !== 'PAUSED' && gamePhase !== 'GAME_OVER') {
            previousPhase = gamePhase;
            gamePhase = 'PAUSED';
            io.emit('announcement', "⏸️ Game Paused by Host");
            broadcastState();
        } else if (action === 'resume' && gamePhase === 'PAUSED') {
            gamePhase = previousPhase;
            io.emit('announcement', "▶️ Game Resumed");
            broadcastState();
        } else if (action === 'reset') {
            gamePhase = 'LOBBY';
            phaseTimer = 0;
            roundCounter = 1;
            currentMaxNodes = 20;
            podiumData = [];
            rouletteNumber = null;
            Object.keys(players).forEach(id => {
                if (players[id].isRegistered) {
                    players[id].isAlive = true;
                    players[id].currentChoice = null;
                    players[id].eliminatedInRound = 0;
                }
            });
            io.emit('player_status', 'ALIVE');
            io.emit('announcement', "🔄 Game Reset to Lobby");
            broadcastState();
        }
    });

    socket.on('submit_choice', (num) => {
        if (players[socket.id] && players[socket.id].isAlive && gamePhase === 'CHOICE_PHASE' && num <= currentMaxNodes) {
            players[socket.id].currentChoice = num;
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        if (hostId === socket.id) {
            const remainingIds = Object.keys(players);
            hostId = remainingIds.length > 0 ? remainingIds[0] : null;
        }
        broadcastState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server handling executions on port: ${PORT}`));
