const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Master Game State
let players = {}; // Structure: { socketId: { id, isAlive, currentChoice } }
let gamePhase = 'BLIND_PHASE'; // BLIND_PHASE, CHOICE_PHASE, INTERMISSION
let phaseTimer = 5;
let loopInterval = null;

function changePhase(newPhase, duration) {
    gamePhase = newPhase;
    phaseTimer = duration;
    
    if (newPhase === 'BLIND_PHASE') {
        // Clear choices for the next cycle loop
        Object.keys(players).forEach(id => {
            if (players[id].isAlive) players[id].currentChoice = null;
        });
    }
    
    if (newPhase === 'INTERMISSION') {
        evaluateChoices();
    }
    
    broadcastState();
}

function evaluateChoices() {
    let counts = {};
    let alivePlayers = Object.values(players).filter(p => p.isAlive);

    // Count how many people picked each number
    alivePlayers.forEach(p => {
        if (p.currentChoice !== null) {
            counts[p.currentChoice] = (counts[p.currentChoice] || 0) + 1;
        }
    });

    // Eliminate duplicates or non-voters
    Object.keys(players).forEach(id => {
        let p = players[id];
        if (p.isAlive) {
            if (p.currentChoice === null || counts[p.currentChoice] > 1) {
                p.isAlive = false;
                io.to(id).emit('player_status', 'ELIMINATED');
            }
        }
    });

    // Check Win/Loss conditions
    let survivors = Object.values(players).filter(p => p.isAlive);
    
    if (survivors.length === 1) {
        io.emit('announcement', `🏆 ${survivors[0].id.substring(0,5)} WINS THE GAME!`);
        setTimeout(resetEntireLobby, 4000);
    } else if (survivors.length === 0) {
        io.emit('announcement', "💀 Everyone was eliminated! No winners.");
        setTimeout(resetEntireLobby, 4000);
    }
}

function resetEntireLobby() {
    Object.keys(players).forEach(id => {
        players[id].isAlive = true;
        io.to(id).emit('player_status', 'ALIVE');
    });
    changePhase('BLIND_PHASE', 5);
}

function broadcastState() {
    let aliveCount = Object.values(players).filter(p => p.isAlive).length;
    io.emit('state_update', {
        phase: gamePhase,
        timeLeft: phaseTimer,
        activePlayers: aliveCount,
        totalConnections: Object.keys(players).length
    });
}

// Global Core Engine Ticker (Runs once per second)
setInterval(() => {
    if (phaseTimer > 0) {
        phaseTimer--;
        broadcastState();
    } else {
        // Phase transition mapping
        if (gamePhase === 'BLIND_PHASE') {
            changePhase('CHOICE_PHASE', 5);
        } else if (gamePhase === 'CHOICE_PHASE') {
            changePhase('INTERMISSION', 20);
        } else if (gamePhase === 'INTERMISSION') {
            let survivors = Object.values(players).filter(p => p.isAlive);
            if (survivors.length > 1) {
                changePhase('BLIND_PHASE', 5);
            }
        }
    }
}, 1000);

io.on('connection', (socket) => {
    // New joins default to ALIVE if a game isn't actively running down players
    let activeSurvivors = Object.values(players).filter(p => p.isAlive).length;
    let startAsAlive = (gamePhase === 'BLIND_PHASE' && activeSurvivors === 0) || activeSurvivors === 0;

    players[socket.id] = {
        id: socket.id,
        isAlive: startAsAlive,
        currentChoice: null
    };

    socket.emit('player_status', startAsAlive ? 'ALIVE' : 'SPECTATOR');
    broadcastState();

    socket.on('submit_choice', (num) => {
        if (players[socket.id] && players[socket.id].isAlive && gamePhase === 'CHOICE_PHASE') {
            players[socket.id].currentChoice = num;
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
        broadcastState();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server handling executions on port: ${PORT}`));