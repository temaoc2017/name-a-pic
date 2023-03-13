const express = require('express');
const http = require('http');
var bodyParser = require('body-parser');
const socketio = require('socket.io');
const mongoose = require('mongoose');
const session = require('express-session');
const fs = require('fs');
require('dotenv').config();

const CARDS_IN_HAND = 7;

const app = express();

const sessionMiddleware = session({
  secret: "lama bonk birick calamity",
  resave: false,
  saveUninitialized: false
});

app.use(sessionMiddleware);

const server = http.createServer(app);
const io = socketio(server);


// Connect to MongoDB
mongoose.connect(`mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@${process.env.DB_URL}/?retryWrites=true&w=majority`, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Define the Room schema
const roomSchema = new mongoose.Schema({
  name: { type: String, required: true },
  players:
  [
    {
      name: { type: String, required: true },
      id: { type: String, required: true },
      cards: [String],
      chosenCard: { type: String, default: "" },
      votedCard: { type: String, default: "" },
      isReady: { type: Boolean, default: false },
      score: { type: Boolean, default: 0 },
    }
  ],
  gameInProgress: { type: Boolean, default: false },
  currentPlayer: Number,
  currentName: String,
  drawPile: [String],
  discardPile: [String],
}, {
  optimisticConcurrency: true,
  // versionKey: 'version' // => Default: __v
});

const Room = mongoose.model('Room', roomSchema);


// Serve static files from the "public" directory
app.use(express.static('public'));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs')


// Handle room creation
app.post('/rooms', async (req, res) => {
  const { roomName, playerName } = req.body;

  try {
    let room = await Room.findOne({ name: roomName }).exec();

    if (room === null) {
      // Create a new room
      room = await Room.create({ name: roomName, players: [] });
      console.log(`${playerName} created ${roomName}`);
    }

    req.session.playerName = playerName

    // Redirect the user to the new room
    res.redirect(`/rooms/${room._id}`);
  } catch (error) {
    console.error(error);
    res.status(500).send('Internal server error');
  }
});

// Handle room joining
app.get('/rooms/:roomId', async (req, res) => {
  const { roomId } = req.params;

  try {
    // Find the room with the given ID
    let room = await Room.findById(roomId);

    // If the room doesn't exist, return a 404 error
    if (!room) {
      res.status(404).send('Room not found');
      return;
    }

    // Render the room page
    res.render('room', { roomId: room._id,
                          roomName: room.name,
                          players: getPlayersNames(room),
                          playerName: req.session.playerName });
  } catch (error) {
    console.error(error);
    res.status(500).send('Internal server error');
  }
});

// Handle Socket.io connections
io.on('connection', (socket) => {
  console.log(`Socket ${socket.id} connected`);

  socket.on('join room', async (roomId, playerName) => {
    await retryUntilSaved(async (roomId, playerName, isReady) => {
      try {
        let room = await Room.findById(roomId);

        if (!room) {
          socket.emit('join room error', 'Room not found');
          return;
        }

        if (!playerName) {
          throw "No player name"
        }

        room = await addPlayer(room, { name: playerName, id: socket.id })
        await room.save();

        // Join the socket to the room's channel
        socket.join(roomId);

        socket.emit('join room success');

        io.in(roomId).emit('new player', getPlayersNames(room));
      } catch (error) {
        if (error instanceof mongoose.Error.VersionError) {
          throw error;
        } else {
          console.error(error);
          socket.emit('join room error', 'Internal server error');
        }
      }
    }, roomId, playerName);
  });

  socket.on('update readiness', async (roomId, playerName, isReady) => {
    await retryUntilSaved(async (roomId, playerName, isReady) => {
      let room = await Room.findById(roomId);
      room = await updatePlayerReadiness(room, playerName, isReady);

      io.in(roomId).emit('readiness updated', getPlayersReadiness(room));
    }, roomId, playerName, isReady);
  });

  socket.on('try start game', async (roomId) => {
    await retryUntilSaved(async (roomId) => {
      let room = await Room.findById(roomId);

      if (room.players.length < 2) {
        socket.emit('start error few players');
        return;
      }

      if (room.players.length != getReadyPlayersCount(room)) {
        socket.emit('start error not ready');
        return;
      }

      // TODO: start game logic: first player, mix draw pile, fill hands
      // TODO: make it a function
      for (let i = 0; i < room.players.length; i++) {
        room.players[i].score = 0;
      }
      room.gameInProgress = true;

      room.currentPlayer = Math.floor(Math.random() * room.players.length);

      let cards = getCardsNames();
      cards = shuffleArray(cards);

      for (let i = 0; i < room.players.length; i++) {
        room.players[i].cards = [];
        for (let j = 0; j < CARDS_IN_HAND; j++) {
          room.players[i].cards.push(cards[i * CARDS_IN_HAND + j])
        }
      }

      room.drawPile = [];
      for (let i = room.players.length * CARDS_IN_HAND; i < cards.length; i++) {
        room.drawPile.push(cards[i]);
      }

      await room.save();

      for (let player of room.players) {
        io.to(player.id).emit('game started', room.players[room.currentPlayer].name, player.cards);
      }
    }, roomId);
  });

  socket.on('choose card', async (roomId, cardSrc, cardName) => {
    await retryUntilSaved(async (roomId, cardSrc, cardName) => {
      let room = await Room.findById(roomId);

      if (getPlayerCard(room, socket.id) != "" || !room.gameInProgress) {
        return;
      }

      if (playerIsNaming(room, socket.id)) {
        room.currentName = cardName;
        await setPlayerCard(room, socket.id, cardSrc);

        io.in(roomId).emit('card name chosen', cardName);
      } else if (room.currentName != "") {
        await setPlayerCard(room, socket.id, cardSrc);

        if (getPlayersWithChosenCards(room).length == room.players.length) {
          io.in(roomId).emit('all cards chosen', getCards(room));
        } else {
          io.in(roomId).emit('card chosen', getPlayersWithChosenCards(room));
        }
      }
    }, roomId, cardSrc, cardName)
  });

  socket.on('vote card', async (roomId, cardSrc) => {
    await retryUntilSaved(async (roomId, cardSrc) => {
      let room = await Room.findById(roomId);

      if (room.currentName == "" || !room.gameInProgress) {
        return;
      }

      if (playerIsNaming(room, socket.id)) {
        return;
      } else if (getPlayersWithChosenCards(room).length == room.players.length) {
        await setPlayerVote(room, socket.id, cardSrc);

        if (countPlayersWithVotedCards(room) == room.players.length - 1) {
          room = resetForNewRound(room);

          io.in(roomId).emit('new round', {});
        }
      }
    }, roomId, cardSrc)
  });

  // Handle disconnections
  socket.on('disconnect', () => {
    // TODO: delete player from mongodb
    console.log(`Socket ${socket.id} disconnected`);
  });
});


function getPlayersNames(room) {
  let playersList = [];
  for (player of room.players) {
    playersList.push(player.name);
  }
  return playersList;
}

function getPlayersReadiness(room) {
  let playersReadinessList = [];
  for (player of room.players) {
    playersReadinessList.push({ name: player.name, isReady: player.isReady });
  }
  return playersReadinessList;
}

async function addPlayer(room, player) {
  let updatedPlayer = false;
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].name == player.name) {
      updatedPlayer = true;
      room.players[i] = player;
      break;
    }
  }
  if (!updatedPlayer) {
    room.players.push(player);
  }
  await room.save();
  return room;
}

async function updatePlayerReadiness(room, playerName, isReady) {
  // console.log(room.players);
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].name == playerName) {
      // console.log(playerName, " ", room.players[i].name, " ", isReady);
      room.players[i].isReady = isReady
    }
  }
  // console.log(room.players);
  await room.save();
  return room;
}

function getReadyPlayersCount(room) {
  let readyPlayersCount = 0;
  for (player of room.players) {
    if (player.isReady) readyPlayersCount++;
  }
  return readyPlayersCount;
}

function getCardsNames() {
  let fileNames = fs.readdirSync('public/cards/');
  let imagePattern = /\.(jpg|png|jpeg|gif)$/;
  fileNames = fileNames.filter(fileName => fileName.match(imagePattern) != null)
  return fileNames;
}

function shuffleArray(array) {
  let arrayCopy = [...array];
  for (let i = arrayCopy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = arrayCopy[i];
    arrayCopy[i] = arrayCopy[j];
    arrayCopy[j] = temp;
  }
  return arrayCopy;
}

function playerIsNaming(room, playerId) {
  return room.players[room.currentPlayer].id == playerId;
}

async function setPlayerCard(room, playerId, cardSrc) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].id == playerId) {
      room.players[i].chosenCard = cardSrc;
      break;
    }
  }
  await room.save();
  return room;
}

function getPlayerCard(room, playerId) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].id == playerId) {
      return room.players[i].chosenCard;
    }
  }
}

function getPlayersWithChosenCards(room) {
  let readyPlayersList = [];
  for (player of room.players) {
    if (player.chosenCard != "") {
      readyPlayersList.push(player.name);
    }
  }
  return readyPlayersList;
}

function getCards(room) {
  let cardsList = [];
  for (player of room.players) {
    cardsList.push(player.chosenCard);
  }
  return cardsList;
}

async function retryUntilSaved(fun, ...parameters) {
  let success = false;
  while (!success) {
    try {
      await fun(...parameters);
      success = true;
    } catch (e) {
      if (e instanceof mongoose.Error.VersionError) {
       console.log('VersionError, retrying');
      } else {
        throw e;
      }
    }
    if (!success) {
      await sleep(70);
    }
  }
}

async function setPlayerVote(room, playerId, cardSrc) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].id == playerId) {
      room.players[i].votedCard = cardSrc;
      break;
    }
  }
  await room.save();
  return room;
}

function countPlayersWithVotedCards(room) {
  let readyPlayersCount = 0;
  for (player of room.players) {
    if (player.votedCard != "") {
      readyPlayersCount++;
    }
  }
  return readyPlayersCount;
}

async function resetForNewRound(room) {
  // update score
  // remove used cards from hand to discard pile
  // add discard pile to draw pile if needed
  // draw cards for each player


  room.currentPlayer = (room.currentPlayer + 1) % room.players.length;
  room.currentName = room.currentName + 1;


  await room.save();
  return room;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
