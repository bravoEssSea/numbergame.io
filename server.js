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

function changePhase(newPhase, duration) {
    gamePhase = newPhase;
    phaseTimer = duration;
    
    // REMOVED: The choice clearing loop has been taken out.
    // Choices now persist from the previous round automatically.
    
    if (newPhase === 'GET_READY') {
        evaluateChoices();
    }
    
    broadcastState();
}

function evaluateChoices() {
    let counts = {};
    let alivePlayers = Object.values(players).filter(p => p.isAlive && p.isRegistered);

    // Count choices (including persistent ones)
    alivePlayers.forEach(p => {
        if (p.currentChoice !== null) {
            counts[p.currentChoice] = (counts[p.currentChoice] || 0) + 1;
        }
    });

    Object.keys(players).forEach(id => {
        let p = players[id];
        if (p.isAlive && p.isRegistered) {
            // Elimination condition: 
            // 1. They failed to choose anything at all (currentChoice is null)
            // 2. Or their chosen number is a duplicate
            if (p.currentChoice === null || counts[p.currentChoice] > 1) {
                p.isAlive = false;
                io.to(id).emit('player_status', 'ELIMINATED');
            }
        }
    });

    let survivors = Object.values(players).filter(p => p.isAlive && p.isRegistered);
    
    if (survivors.length === 1) {
        io.emit('announcement', `🏆 ${survivors[0].name} WINS THE GAME!`);
        gamePhase = 'LOBBY';
    } else if (survivors.length === 0) {
        io.emit('announcement', "💀 Everyone was eliminated! No winners.");
        gamePhase = 'LOBBY';
    } else {
        roundCounter++;
        if (roundCounter % 3 === 1 && roundCounter > 1) {
            // Drop by 5 options, but if the circle shrinks past their current selection, 
            // the player will need to pick a new valid number or face elimination.
            currentMaxNodes = Math.max(5, currentMaxNodes - 5); 
            
            // Check if anyone's persistent choice is now out of bounds
            Object.keys(players).forEach(id => {
                if (players[id].currentChoice > currentMaxNodes) {
                    players[id].currentChoice = null; // Reset them because their option vanished
                }
            });

            io.emit('announcement', `⚠️ BOTTLENECK! Circle compressed to ${currentMaxNodes} options!`);
        }
    }
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
        maxNodes: currentMaxNodes
    });
}

function startGameLoop() {
    if (gameTicker) clearInterval(gameTicker);
    gameTicker = setInterval(() => {
        if (gamePhase === 'LOBBY' || gamePhase === 'PAUSED') return;

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
                    gamePhase = 'LOBBY';
                    broadcastState();
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
        currentChoice: null
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

        if (action === 'start' && gamePhase === 'LOBBY') {
            roundCounter = 1;
            currentMaxNodes = 20; 
            Object.keys(players).forEach(id => {
                if (players[id].isRegistered) {
                    players[id].isAlive = true;
                    players[id].currentChoice = null; // Fresh start
                }
            });
            io.emit('player_status', 'ALIVE');
            changePhase('CHOICE_PHASE', 5);
            startGameLoop();
        } else if (action === 'pause' && gamePhase !== 'LOBBY' && gamePhase !== 'PAUSED') {
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
            Object.keys(players).forEach(id => {
                if (players[id].isRegistered) {
                    players[id].isAlive = true;
                    players[id].currentChoice = null;
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