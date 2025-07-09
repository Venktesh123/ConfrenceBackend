const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Store active rooms and participants
const rooms = {};

// API endpoint to create a new room
app.post("/api/room", (req, res) => {
  const roomId = uuidv4();
  rooms[roomId] = {
    id: roomId,
    participants: {},
    messages: [], // Store chat messages
    hostId: null, // Track room host
    chatSettings: {
      allowParticipantChat: true,
      allowPrivateMessages: true,
      moderateMessages: false,
    },
    createdAt: new Date(),
  };
  console.log(`Created room: ${roomId}`);
  res.json({ roomId });
});
app.get("/", (req, res) => {
  return res.send("Welcome to the Meeting Room API");
});
// Get room info
app.get("/api/room/:roomId", (req, res) => {
  const { roomId } = req.params;
  const room = rooms[roomId];

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  res.json({
    roomId: room.id,
    participantCount: Object.keys(room.participants).length,
    participants: Object.values(room.participants).map((p) => ({
      username: p.username,
      joinedAt: p.joinedAt,
      isHost: p.id === room.hostId,
      isScreenSharing: p.isScreenSharing || false,
    })),
    messageCount: room.messages.length,
    hostId: room.hostId,
    chatSettings: room.chatSettings,
  });
});

// Socket.io connection handling
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Handle joining a room
  socket.on("join-room", ({ roomId, username, peerId }) => {
    console.log(
      `${username} trying to join room ${roomId} with peer ID ${peerId}`
    );

    // Check if room exists
    if (!rooms[roomId]) {
      console.log(`Room ${roomId} does not exist`);
      socket.emit("room-error", { message: "Room does not exist" });
      return;
    }

    // Add user to socket room
    socket.join(roomId);

    // Store participant info
    const participantId = socket.id;
    const isFirstParticipant =
      Object.keys(rooms[roomId].participants).length === 0;

    // Set host if first participant
    if (isFirstParticipant) {
      rooms[roomId].hostId = participantId;
    }

    rooms[roomId].participants[participantId] = {
      id: participantId,
      username,
      peerId,
      socketId: socket.id,
      joinedAt: new Date(),
      audioEnabled: true,
      videoEnabled: true,
      isHost: isFirstParticipant,
      isScreenSharing: false, // Add screen sharing state
    };

    console.log(
      `${username} joined room ${roomId}. Total participants: ${
        Object.keys(rooms[roomId].participants).length
      }. Host: ${isFirstParticipant ? "YES" : "NO"}`
    );

    // Send room info and host status
    socket.emit("room-info", {
      roomCreatedAt: rooms[roomId].createdAt,
      isFirstParticipant,
      hostId: rooms[roomId].hostId,
    });

    // Send recent chat messages to the new user
    const recentMessages = rooms[roomId].messages.slice(-50); // Send last 50 messages
    recentMessages.forEach((message) => {
      // Filter messages based on user permissions
      if (shouldReceiveMessage(message, participantId, rooms[roomId])) {
        if (message.chatMode === "private") {
          socket.emit("private-message", message);
        } else if (message.chatMode === "host-only") {
          if (isFirstParticipant) {
            socket.emit("host-message", message);
          }
        } else {
          socket.emit("chat-message", message);
        }
      }
    });

    // Send chat settings to the new user
    socket.emit("chat-settings-updated", rooms[roomId].chatSettings);

    // Notify existing participants about the new user
    socket.to(roomId).emit("user-joined", {
      participantId,
      username,
      peerId,
    });

    // Send current participants to the new user
    const existingParticipants = {};
    Object.entries(rooms[roomId].participants).forEach(([id, participant]) => {
      if (id !== participantId) {
        existingParticipants[id] = participant;
      }
    });

    socket.emit("room-participants", {
      participants: existingParticipants,
    });

    console.log(
      `Sent ${
        Object.keys(existingParticipants).length
      } existing participants to ${username}`
    );
  });

  // Helper function to determine if user should receive a message
  function shouldReceiveMessage(message, participantId, room) {
    // System messages are visible to all
    if (message.type === "system") return true;

    const participant = room.participants[participantId];
    const isHost = participant && participant.id === room.hostId;

    // Public messages
    if (message.chatMode === "public") {
      return room.chatSettings.allowParticipantChat || isHost;
    }

    // Private messages
    if (message.chatMode === "private") {
      return (
        message.senderId === participantId || // Sender
        message.recipientId === participantId || // Direct recipient
        (message.toHost && isHost) || // Message to host
        isHost // Host can see all private messages
      );
    }

    // Host-only messages
    if (message.chatMode === "host-only") {
      return isHost;
    }

    return false;
  }

  // Handle public chat messages
  socket.on(
    "send-chat-message",
    ({ roomId, username, message, timestamp, chatMode }) => {
      console.log(
        `Public chat message from ${username} in room ${roomId}: ${message}`
      );

      if (!rooms[roomId]) {
        console.log(`Room ${roomId} does not exist for chat message`);
        return;
      }

      const participant = rooms[roomId].participants[socket.id];
      const isHost = participant && participant.id === rooms[roomId].hostId;

      // Check permissions
      if (!isHost && !rooms[roomId].chatSettings.allowParticipantChat) {
        socket.emit("chat-error", { message: "Public chat is disabled" });
        return;
      }

      const messageData = {
        id: uuidv4(),
        username,
        message,
        timestamp: timestamp || new Date(),
        type: "user",
        chatMode: "public",
        senderId: socket.id,
      };

      // Store message in room
      rooms[roomId].messages.push(messageData);

      // Keep only last 100 messages to prevent memory issues
      if (rooms[roomId].messages.length > 100) {
        rooms[roomId].messages = rooms[roomId].messages.slice(-100);
      }

      // Broadcast message to all participants in the room
      io.to(roomId).emit("chat-message", messageData);
    }
  );

  // Handle private messages
  socket.on(
    "send-private-message",
    ({ roomId, username, message, timestamp, recipient, toHost }) => {
      console.log(
        `Private message from ${username} in room ${roomId} to ${
          recipient || "host"
        }: ${message}`
      );

      if (!rooms[roomId]) {
        return;
      }

      const participant = rooms[roomId].participants[socket.id];
      const isHost = participant && participant.id === rooms[roomId].hostId;

      // Check permissions
      if (!isHost && !rooms[roomId].chatSettings.allowPrivateMessages) {
        socket.emit("chat-error", { message: "Private messages are disabled" });
        return;
      }

      let recipientId = null;

      // Find recipient
      if (toHost) {
        recipientId = rooms[roomId].hostId;
      } else if (recipient) {
        // Find participant by username
        const recipientParticipant = Object.values(
          rooms[roomId].participants
        ).find((p) => p.username === recipient);
        recipientId = recipientParticipant ? recipientParticipant.id : null;
      }

      if (!recipientId) {
        socket.emit("chat-error", { message: "Recipient not found" });
        return;
      }

      const messageData = {
        id: uuidv4(),
        username,
        message,
        timestamp: timestamp || new Date(),
        type: "user",
        chatMode: "private",
        senderId: socket.id,
        recipientId,
        recipient,
        toHost,
      };

      // Store message in room
      rooms[roomId].messages.push(messageData);

      // Keep only last 100 messages
      if (rooms[roomId].messages.length > 100) {
        rooms[roomId].messages = rooms[roomId].messages.slice(-100);
      }

      // Send to sender
      socket.emit("private-message", messageData);

      // Send to recipient
      if (recipientId !== socket.id) {
        io.to(recipientId).emit("private-message", messageData);
      }

      // If message is to host and sender is not host, also send to host
      if (toHost && !isHost) {
        io.to(rooms[roomId].hostId).emit("private-message", messageData);
      }
    }
  );

  // Handle host-only messages
  socket.on("send-host-message", ({ roomId, username, message, timestamp }) => {
    console.log(`Host message from ${username} in room ${roomId}: ${message}`);

    if (!rooms[roomId]) {
      return;
    }

    const participant = rooms[roomId].participants[socket.id];
    const isHost = participant && participant.id === rooms[roomId].hostId;

    // Only host can send host-only messages
    if (!isHost) {
      socket.emit("chat-error", {
        message: "Only host can send announcements",
      });
      return;
    }

    const messageData = {
      id: uuidv4(),
      username,
      message,
      timestamp: timestamp || new Date(),
      type: "user",
      chatMode: "host-only",
      senderId: socket.id,
    };

    // Store message in room
    rooms[roomId].messages.push(messageData);

    // Keep only last 100 messages
    if (rooms[roomId].messages.length > 100) {
      rooms[roomId].messages = rooms[roomId].messages.slice(-100);
    }

    // Send only to host (for now, could be extended to all participants)
    socket.emit("host-message", messageData);
  });

  // Handle system messages (user joined/left)
  socket.on("send-system-message", ({ roomId, message, type }) => {
    console.log(`System message in room ${roomId}: ${message}`);

    if (!rooms[roomId]) {
      return;
    }

    const messageData = {
      id: uuidv4(),
      message,
      timestamp: new Date(),
      type: "system",
      systemType: type, // 'join' or 'leave'
    };

    // Store system message in room
    rooms[roomId].messages.push(messageData);

    // Keep only last 100 messages
    if (rooms[roomId].messages.length > 100) {
      rooms[roomId].messages = rooms[roomId].messages.slice(-100);
    }

    // Broadcast system message to all participants
    io.to(roomId).emit("chat-system-message", messageData);
  });

  // Handle chat settings updates (host only)
  socket.on("update-chat-settings", ({ roomId, settings }) => {
    if (!rooms[roomId]) {
      return;
    }

    const participant = rooms[roomId].participants[socket.id];
    const isHost = participant && participant.id === rooms[roomId].hostId;

    // Only host can update chat settings
    if (!isHost) {
      socket.emit("chat-error", {
        message: "Only host can update chat settings",
      });
      return;
    }

    // Update room chat settings
    rooms[roomId].chatSettings = { ...rooms[roomId].chatSettings, ...settings };

    console.log(
      `Chat settings updated in room ${roomId}:`,
      rooms[roomId].chatSettings
    );

    // Broadcast updated settings to all participants
    io.to(roomId).emit("chat-settings-updated", rooms[roomId].chatSettings);
  });

  // Handle typing indicators
  socket.on("typing-indicator", ({ roomId, username, isTyping }) => {
    if (!rooms[roomId]) {
      return;
    }

    // Broadcast typing indicator to other participants
    socket.to(roomId).emit("user-typing", {
      username,
      isTyping,
    });
  });

  // Handle user muting/unmuting audio
  socket.on("toggle-audio", ({ roomId, peerId, enabled }) => {
    console.log(`Audio toggle: ${socket.id} - ${enabled}`);

    if (rooms[roomId] && rooms[roomId].participants[socket.id]) {
      rooms[roomId].participants[socket.id].audioEnabled = enabled;

      // Notify other participants
      socket.to(roomId).emit("user-toggle-audio", {
        participantId: socket.id,
        peerId,
        enabled,
      });
    }
  });

  // Handle user muting/unmuting video
  socket.on("toggle-video", ({ roomId, peerId, enabled }) => {
    console.log(`Video toggle: ${socket.id} - ${enabled}`);

    if (rooms[roomId] && rooms[roomId].participants[socket.id]) {
      rooms[roomId].participants[socket.id].videoEnabled = enabled;

      // Notify other participants
      socket.to(roomId).emit("user-toggle-video", {
        participantId: socket.id,
        peerId,
        enabled,
      });
    }
  });

  // Handle screen sharing events
  socket.on("user-screen-share", ({ roomId, peerId, isSharing }) => {
    console.log(`Screen share toggle: ${socket.id} - ${isSharing}`);

    if (rooms[roomId] && rooms[roomId].participants[socket.id]) {
      rooms[roomId].participants[socket.id].isScreenSharing = isSharing;

      // Notify other participants about screen sharing status
      socket.to(roomId).emit("user-screen-share", {
        participantId: socket.id,
        peerId,
        isSharing,
      });

      console.log(
        `User ${rooms[roomId].participants[socket.id].username} ${
          isSharing ? "started" : "stopped"
        } screen sharing in room ${roomId}`
      );
    }
  });

  // Handle removing a participant (by admin)
  socket.on("remove-participant", ({ roomId, participantId, peerId }) => {
    console.log(`Removing participant: ${participantId}`);

    if (!rooms[roomId]) {
      return;
    }

    const requester = rooms[roomId].participants[socket.id];
    const isHost = requester && requester.id === rooms[roomId].hostId;

    // Only host can remove participants
    if (!isHost) {
      socket.emit("chat-error", {
        message: "Only host can remove participants",
      });
      return;
    }

    if (rooms[roomId].participants[participantId]) {
      const removedParticipant = rooms[roomId].participants[participantId];

      // Send system message about user removal
      const systemMessage = {
        id: uuidv4(),
        message: `${removedParticipant.username} was removed from the meeting`,
        timestamp: new Date(),
        type: "system",
        systemType: "remove",
      };

      rooms[roomId].messages.push(systemMessage);
      io.to(roomId).emit("chat-system-message", systemMessage);

      // Notify the participant they're being removed
      io.to(participantId).emit("you-were-removed");

      // Notify other participants
      socket.to(roomId).emit("user-removed", {
        participantId,
        peerId,
      });

      // Remove from room data
      delete rooms[roomId].participants[participantId];

      // Force disconnect the removed user
      io.sockets.sockets.get(participantId)?.disconnect(true);
    }
  });

  // Handle transferring host privileges
  socket.on("transfer-host", ({ roomId, newHostId }) => {
    if (!rooms[roomId]) {
      return;
    }

    const currentHost = rooms[roomId].participants[socket.id];
    const isCurrentHost =
      currentHost && currentHost.id === rooms[roomId].hostId;

    // Only current host can transfer privileges
    if (!isCurrentHost) {
      socket.emit("chat-error", {
        message: "Only host can transfer privileges",
      });
      return;
    }

    const newHost = rooms[roomId].participants[newHostId];
    if (!newHost) {
      socket.emit("chat-error", { message: "New host not found" });
      return;
    }

    // Update host status
    rooms[roomId].hostId = newHostId;
    rooms[roomId].participants[socket.id].isHost = false;
    rooms[roomId].participants[newHostId].isHost = true;

    // Send system message
    const systemMessage = {
      id: uuidv4(),
      message: `${newHost.username} is now the host`,
      timestamp: new Date(),
      type: "system",
      systemType: "host-change",
    };

    rooms[roomId].messages.push(systemMessage);
    io.to(roomId).emit("chat-system-message", systemMessage);

    // Notify all participants of host change
    io.to(roomId).emit("host-privileges-updated", {
      newHostId,
      newHostUsername: newHost.username,
    });

    console.log(
      `Host transferred from ${currentHost.username} to ${newHost.username} in room ${roomId}`
    );
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);

    // Find which room this user was in
    for (const roomId in rooms) {
      if (rooms[roomId].participants[socket.id]) {
        const participant = rooms[roomId].participants[socket.id];
        const wasHost = participant.id === rooms[roomId].hostId;

        console.log(
          `${participant.username} left room ${roomId}${
            wasHost ? " (was host)" : ""
          }`
        );

        // Send system message about user leaving
        const systemMessage = {
          id: uuidv4(),
          message: `${participant.username} left the meeting`,
          timestamp: new Date(),
          type: "system",
          systemType: "leave",
        };

        rooms[roomId].messages.push(systemMessage);
        socket.to(roomId).emit("chat-system-message", systemMessage);

        // Notify other participants
        socket.to(roomId).emit("user-left", {
          participantId: socket.id,
          peerId: participant.peerId,
          username: participant.username,
        });

        // Remove from room data
        delete rooms[roomId].participants[socket.id];

        // If host left, transfer to next participant
        if (wasHost) {
          const remainingParticipants = Object.values(
            rooms[roomId].participants
          );
          if (remainingParticipants.length > 0) {
            const newHost = remainingParticipants[0];
            rooms[roomId].hostId = newHost.id;
            newHost.isHost = true;

            // Notify new host
            const hostMessage = {
              id: uuidv4(),
              message: `${newHost.username} is now the host`,
              timestamp: new Date(),
              type: "system",
              systemType: "host-change",
            };

            rooms[roomId].messages.push(hostMessage);
            io.to(roomId).emit("chat-system-message", hostMessage);
            io.to(roomId).emit("host-privileges-updated", {
              newHostId: newHost.id,
              newHostUsername: newHost.username,
            });

            console.log(`Host privileges transferred to ${newHost.username}`);
          }
        }

        console.log(
          `Room ${roomId} now has ${
            Object.keys(rooms[roomId].participants).length
          } participants`
        );

        // If room is empty, remove it after a delay
        if (Object.keys(rooms[roomId].participants).length === 0) {
          setTimeout(() => {
            if (
              rooms[roomId] &&
              Object.keys(rooms[roomId].participants).length === 0
            ) {
              delete rooms[roomId];
              console.log(`Room ${roomId} has been removed due to inactivity`);
            }
          }, 60000); // Remove after 1 minute of inactivity
        }

        break;
      }
    }
  });

  // Handle ping for connection testing
  socket.on("ping", (callback) => {
    callback("pong");
  });
});

// Debug endpoint to see all rooms
app.get("/api/debug/rooms", (req, res) => {
  const roomSummary = {};
  Object.keys(rooms).forEach((roomId) => {
    roomSummary[roomId] = {
      participantCount: Object.keys(rooms[roomId].participants).length,
      messageCount: rooms[roomId].messages.length,
      hostId: rooms[roomId].hostId,
      chatSettings: rooms[roomId].chatSettings,
      participants: Object.values(rooms[roomId].participants).map((p) => ({
        username: p.username,
        peerId: p.peerId,
        joinedAt: p.joinedAt,
        isHost: p.id === rooms[roomId].hostId,
        isScreenSharing: p.isScreenSharing || false,
      })),
      recentMessages: rooms[roomId].messages.slice(-5).map((m) => ({
        username: m.username,
        message: m.message,
        type: m.type,
        chatMode: m.chatMode,
        timestamp: m.timestamp,
      })),
    };
  });
  res.json(roomSummary);
});

// Get chat history for a room
app.get("/api/room/:roomId/messages", (req, res) => {
  const { roomId } = req.params;
  const room = rooms[roomId];

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  res.json({
    roomId: room.id,
    messages: room.messages,
    chatSettings: room.chatSettings,
  });
});

// Get chat settings for a room
app.get("/api/room/:roomId/chat-settings", (req, res) => {
  const { roomId } = req.params;
  const room = rooms[roomId];

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  res.json({
    roomId: room.id,
    chatSettings: room.chatSettings,
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Debug endpoint: http://localhost:${PORT}/api/debug/rooms`);
});
