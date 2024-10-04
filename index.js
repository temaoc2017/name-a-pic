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
      score: { type: Number, default: 0 },
    }
  ],
  gameInProgress: { type: Boolean, default: false },
  currentPlayer: Number,
  currentName: String,
  votingStage: { type: Boolean, default: false },
  drawPile: [String],
  discardPile: [String],
  roundNumber: { type: Number, default: 1 },
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

    req.session.playerName = playerName;

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
    await retryUntilSaved(async (roomId, playerName) => {
      try {
        let room = await Room.findById(roomId);

        if (!room) {
          socket.emit('join room error', 'Room not found');
          return;
        }

        if (!playerName) {
          throw "No player name"
        }

        let existingPlayer = getPlayerByName(room, playerName);
        if (existingPlayer) {
          existingPlayer.id = socket.id;
        } else {
          room = await addPlayer(room, { name: playerName, id: socket.id })
        }
        await room.save();

        socket.join(roomId);

        socket.emit('join room success');

        if (!room.gameInProgress) {
          io.in(roomId).emit('new player', getPlayersNames(room));
        } else {
          let player = getPlayerByName(room, playerName);
          // TODO: send chosen cards only when they all are chosen
          socket.emit('game started', room.players[room.currentPlayer].name, player.cards, getPlayersWithScores(room), room.currentName, shuffleArray(getChosenCards(room)))
        }
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

      room = resetForNewGame(room);

      await room.save();

      for (let player of room.players) {
        io.to(player.id).emit('game started', room.players[room.currentPlayer].name, player.cards, getPlayersWithScores(room));
      }
    }, roomId);
  });

  socket.on('choose card', async (roomId, cardSrc, cardName) => {
    await retryUntilSaved(async (roomId, cardSrc, cardName) => {
      let room = await Room.findById(roomId);

      if (!room.gameInProgress) {
        return;
      }

      if (playerIsNaming(room, socket.id)) {
        if (getPlayerCard(room, socket.id) == "") {
          room.currentName = cardName;
          room = updatePlayerCard(room, socket.id, cardSrc);
          await room.save();

          io.in(roomId).emit('card name chosen', cardName);
        }
      } else if (room.currentName != "" && !room.votingStage) {
        room = updatePlayerCard(room, socket.id, cardSrc);
        await room.save();

        if (getPlayersWithChosenCards(room).length == room.players.length) {
          (async () => {
            let room = await Room.findById(roomId);
            if (getPlayersWithChosenCards(room).length != room.players.length) {
              return;
            }
            room.votingStage = true;
            await sleep(3000);
            try {
              await room.save();
              io.in(roomId).emit('all cards chosen', shuffleArray(getChosenCards(room)));
            } catch (error) {
              if (!(error instanceof mongoose.Error.VersionError)) {
                throw error;
              }
            }
          })();
        } else {
          io.in(roomId).emit('card chosen', getPlayersWithChosenCards(room));
          console.log('card chosen');
        }
      }
    }, roomId, cardSrc, cardName)
  });

  socket.on('vote card', async (roomId, cardSrc) => {
    await retryUntilSaved(async (roomId, cardSrc) => {
      console.log('vote recieved');
      let room = await Room.findById(roomId);

      if (room.currentName == "" || !room.gameInProgress) {
        return;
      }
      for (let player of room.players) {
        if (player.id == socket.id && player.chosenCard == cardSrc) {
          socket.emit('vote error voted self');
          return;
        }
      }
      if (playerIsNaming(room, socket.id)) {
        return;
      }

      if (getPlayersWithChosenCards(room).length == room.players.length) {
        room = setPlayerVote(room, socket.id, cardSrc);

        if (countPlayersWithVotedCards(room) == room.players.length - 1) {
          let roundSummary = getRoundSummary(room);
          room = resetForNewRound(room);
          await room.save();

          for (let player of room.players) {
            io.to(player.id).emit('new round', room.players[room.currentPlayer].name, player.cards, getPlayersWithScores(room), Array.from(roundSummary));
          }
        } else {
          await room.save();
        }
      }
    }, roomId, cardSrc);
  });

  // TODO: Handle disconnections
  socket.on('disconnect', () => {
    // TODO: delete player from mongodb
    console.log(`Socket ${socket.id} disconnected`);
  });
});


function getPlayersNames(room) {
  let playersList = [];
  for (let player of room.players) {
    playersList.push(player.name);
  }
  return playersList;
}

function getPlayersReadiness(room) {
  let playersReadinessList = [];
  for (let player of room.players) {
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
  for (let player of room.players) {
    if (player.isReady) readyPlayersCount++;
  }
  return readyPlayersCount;
}

function getCardsNames() {
  let fileNames = fs.readdirSync('public/cards/');
  let imagePattern = /\.(jpg|png|jpeg|gif)$/;
  fileNames = fileNames.filter(fileName => fileName.match(imagePattern) != null)
  for (let i = 156; i <= 211; i++) {
    fileNames.push("https://cdn.glitch.global/c2723664-fc3b-43a0-9809-d919707a7e64/" + i + ".jpg")
  }
  for (let i = 212; i <= 271; i++) {
    fileNames.push("https://cdn.glitch.global/c2723664-fc3b-43a0-9809-d919707a7e64/" + i + ".jpeg")
  }
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

function updatePlayerCard(room, playerId, cardSrc) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].id == playerId) {
      if (room.players[i].chosenCard == cardSrc) {
        room.players[i].chosenCard = "";
      } else {
        room.players[i].chosenCard = cardSrc;
      }
      break;
    }
  }
  return room;
}

function getPlayerCard(room, playerId) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].id == playerId) {
      return room.players[i].chosenCard;
    }
  }
}

function getPlayerByName(room, playerName) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].name == playerName) {
      return room.players[i];
    }
  }
  return;
}

function getPlayersWithChosenCards(room) {
  let readyPlayersList = [];
  for (let player of room.players) {
    if (player.chosenCard != "") {
      readyPlayersList.push(player.name);
    }
  }
  return readyPlayersList;
}

function getChosenCards(room) {
  let cardsList = [];
  for (let player of room.players) {
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

function setPlayerVote(room, playerId, cardSrc) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].id == playerId) {
      room.players[i].votedCard = cardSrc;
      break;
    }
  }
  return room;
}

function countPlayersWithVotedCards(room) {
  let readyPlayersCount = 0;
  for (let player of room.players) {
    if (player.votedCard != "") {
      readyPlayersCount++;
    }
  }
  return readyPlayersCount;
}

function resetForNewRound(room) {
  let correctCard = room.players[room.currentPlayer].chosenCard;
  let votedCards = new Map();

  for (let player of room.players) {
    if (!votedCards.has(player.votedCard)) {
      votedCards.set(player.votedCard, 0);
    }
    votedCards.set(player.votedCard, votedCards.get(player.votedCard) + 1);
  }


  for (let i = 0; i < room.players.length; i++) {
    if (i == room.currentPlayer) {
      if (votedCards.has(correctCard) && votedCards.get(correctCard) != room.players.length - 1) {
        room.players[i].score += 3;
      }
    } else {
      if (room.players[i].votedCard == correctCard) {
        room.players[i].score += 3;
      }
      if (votedCards.get(room.players[i].chosenCard)) {
        room.players[i].score += votedCards.get(room.players[i].chosenCard);
      }
    }
  }
  for (let i = 0; i < room.players.length; i++) {
    room.players[i].votedCard = "";
  }

  for (let i = 0; i < room.players.length; i++) {
    for (let j = 0; j < room.players[i].cards.length; j++) {
      if (room.players[i].cards[j] == room.players[i].chosenCard) {
        room.players[i].cards.splice(j, 1);
        room.discardPile.push(room.players[i].chosenCard);
        break;
      }
    }
  }
  for (let i = 0; i < room.players.length; i++) {
    room.players[i].chosenCard = "";
  }

  if (room.drawPile.length < room.players.length) {
    while (room.discardPile.length > 0) {
      room.drawPile.push(room.discardPile.pop());
    }
  }
  room.drawPile = shuffleArray(room.drawPile);

  for (let i = 0; i < room.players.length; i++) {
    room.players[i].cards.push(room.drawPile.pop());
  }

  room.currentPlayer = (room.currentPlayer + 1) % room.players.length;
  room.currentName = "";
  room.votingStage = false;
  room.roundNumber++;

  return room;
}

function resetForNewGame(room) {
  room.gameInProgress = true;
  room.votingStage = false;
  room.currentName = "";
  room.roundNumber = 0;

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
  room.discardPile = [];
  for (let i = room.players.length * CARDS_IN_HAND; i < cards.length; i++) {
    room.drawPile.push(cards[i]);
  }

  for (let i = 0; i < room.players.length; i++) {
    room.players[i].score = 0;
  }
  for (let i = 0; i < room.players.length; i++) {
    room.players[i].votedCard = "";
  }
  for (let i = 0; i < room.players.length; i++) {
    room.players[i].chosenCard = "";
  }

  return room;
}

function getPlayersWithScores(room) {
  let playersReadinessList = [];
  for (let player of room.players) {
    playersReadinessList.push({ name: player.name, score: player.score });
  }
  return playersReadinessList;
}

function getRoundSummary(room) {
  let summary = new Map();

  for (let player of room.players) {
    let card = player.chosenCard;
    let cardSummary = {};
    cardSummary.correctCard = false;
    if (player.name == room.players[room.currentPlayer].name) {
      cardSummary.correctCard = true;
    }
    cardSummary.cardOwner = player.name;
    cardSummary.playersVoted = [];
    summary.set(card, cardSummary);
  }

  for (let player of room.players) {
    if (player.votedCard) {
      summary.get(player.votedCard).playersVoted.push(player.name);
    }
  }

  return summary;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
