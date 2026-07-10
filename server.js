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

// FIXED: Permanent record tracking nicknames and their life state across disconnect hooks
let historicalRegistry = {}; 

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
                        
                        // Sync tracking down to history ledger
                        if (historicalRegistry[p.name]) {
                            historicalRegistry[p.name].isAlive = false;
                            historicalRegistry[p.name].eliminatedInRound = roundCounter;
                        }
                        
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
                    
                    // Sync tracking down to history ledger
                    if (historicalRegistry[p.name]) {
                        historicalRegistry[p.name].isAlive = false;
                        historicalRegistry[p.name].eliminatedInRound = roundCounter;
                    }
                    
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
    // Generate rank lists using the historical tracking ledger to capture players who disconnected early
    let ranked = Object.values(historicalRegistry)
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
        
        // Clean formatting to ensure case-insensitive registration checks
        const searchKey = nickname.trim().toLowerCase();
        
        // FIXED: Verify if this specific nickname exists inside our historical elimination ledger
        if (historicalRegistry[searchKey]) {
            // Restore their existing historical life state profile record parameters
            players[socket.id].name = historicalRegistry[searchKey].name;
            players[socket.id].isAlive = historicalRegistry[searchKey].isAlive;
            players[socket.id].eliminatedInRound = historicalRegistry[searchKey].eliminatedInRound;
        } else {
            // Register a brand new unique name record row entry profile properties
            players[socket.id].name = nickname.trim();
            players[socket.id].isAlive = (gamePhase !== 'GAME_OVER');
            players[socket.id].eliminatedInRound = 0;
            
            // Map into the historical cache record index lists definitions
            historicalRegistry[searchKey] = {
                name: players[socket.id].name,
                isAlive: players[socket.id].isAlive,
                eliminatedInRound: 0
            };
        }

        players[socket.id].isRegistered = true;
        socket.emit('player_status', players[socket.id].isAlive ? 'ALIVE' : 'ELIMINATED');
        broadcastState();
    });

    socket.on('host_action', (action) => {
        if (socket.id !== hostId) return;

        if (action === 'start') {
            if (gamePhase === 'GAME_OVER') {
                gamePhase = 'LOBBY';
                phaseTimer = 0;
                roundCounter = 1;
                currentMaxNodes = 20;
                podiumData = [];
                rouletteNumber = null;
                
                // FIXED: Clear out historical death ledgers completely on resets
                historicalRegistry = {};
                
                Object.keys(players).forEach(id => {
                    if (players[id].isRegistered) {
                        players[id].isAlive = true;
                        players[id].currentChoice = null;
                        players[id].eliminatedInRound = 0;
                        
                        // Re-initialize ledger entry
                        const key = players[id].name.toLowerCase();
                        historicalRegistry[key] = { name: players[id].name, isAlive: true, eliminatedInRound: 0 };
                    }
                });
                
                io.emit('player_status', 'ALIVE');
                io.emit('announcement', "🔄 Match returned to Lobby! Waiting for host to start.");
                broadcastState();
            } else if (gamePhase === 'LOBBY') {
                roundCounter = 1;
                currentMaxNodes = 20; 
                podiumData = [];
                rouletteNumber = null;
                
                // Clear and rebuild ledger definitions right upon starting line execution frames
                historicalRegistry = {};
                Object.keys(players).forEach(id => {
                    if (players[id].isRegistered) {
                        players[id].isAlive = true;
                        players[id].currentChoice = null;
                        players[id].eliminatedInRound = 0;
                        
                        const key = players[id].name.toLowerCase();
                        historicalRegistry[key] = { name: players[id].name, isAlive: true, eliminatedInRound: 0 };
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
            
            // FIXED: Flush registry variables out entirely on manual admin resets
            historicalRegistry = {};
            
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
        // Remove from current connections loop metrics, but historical entries persist cleanly!
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
