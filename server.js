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
    hostMasterControls: {
      controlAllAudio: true, // When host toggles audio, it affects all participants
      controlAllVideo: true, // When host toggles video, it affects all participants
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
    hostMasterControls: room.hostMasterControls,
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
      isScreenSharing: false,
    };

    console.log(
      `${username} joined room ${roomId}. Total participants: ${
        Object.keys(rooms[roomId].participants).length
      }. Host: ${isFirstParticipant ? "YES" : "NO"}`
    );

    // Send host status to the joining user
    socket.emit("host-assigned", { isHost: isFirstParticipant });

    // Send room info and host status
    socket.emit("room-info", {
      roomCreatedAt: rooms[roomId].createdAt,
      isFirstParticipant,
      hostId: rooms[roomId].hostId,
      hostMasterControls: rooms[roomId].hostMasterControls,
    });

    // Send recent chat messages to the new user
    const recentMessages = rooms[roomId].messages.slice(-50);
    recentMessages.forEach((message) => {
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

    // Send host master controls settings
    socket.emit(
      "host-master-controls-updated",
      rooms[roomId].hostMasterControls
    );

    // Notify existing participants about the new user
    socket.to(roomId).emit("user-joined", {
      participantId,
      username,
      peerId,
      isHost: isFirstParticipant,
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
    if (message.type === "system") return true;

    const participant = room.participants[participantId];
    const isHost = participant && participant.id === room.hostId;

    if (message.chatMode === "public") {
      return room.chatSettings.allowParticipantChat || isHost;
    }

    if (message.chatMode === "private") {
      return (
        message.senderId === participantId ||
        message.recipientId === participantId ||
        (message.toHost && isHost) ||
        isHost
      );
    }

    if (message.chatMode === "host-only") {
      return isHost;
    }

    return false;
  }

  // NEW: Handle host master controls settings
  socket.on("update-host-master-controls", ({ roomId, settings }) => {
    if (!rooms[roomId]) {
      return;
    }

    const participant = rooms[roomId].participants[socket.id];
    const isHost = participant && participant.id === rooms[roomId].hostId;

    // Only host can update master controls
    if (!isHost) {
      socket.emit("chat-error", {
        message: "Only host can update master controls",
      });
      return;
    }

    // Update room master controls settings
    rooms[roomId].hostMasterControls = {
      ...rooms[roomId].hostMasterControls,
      ...settings,
    };

    console.log(
      `Host master controls updated in room ${roomId}:`,
      rooms[roomId].hostMasterControls
    );

    // Broadcast updated settings to all participants
    io.to(roomId).emit(
      "host-master-controls-updated",
      rooms[roomId].hostMasterControls
    );

    // Send system message
    io.to(roomId).emit("chat-system-message", {
      id: uuidv4(),
      message: `Host ${
        settings.controlAllAudio ? "enabled" : "disabled"
      } master audio control and ${
        settings.controlAllVideo ? "enabled" : "disabled"
      } master video control`,
      timestamp: new Date(),
      type: "system",
      systemType: "host-action",
    });
  });

  // UPDATED: Handle user muting/unmuting audio with host master control
  socket.on("toggle-audio", ({ roomId, peerId, enabled }) => {
    console.log(`Audio toggle: ${socket.id} - ${enabled}`);

    if (!rooms[roomId] || !rooms[roomId].participants[socket.id]) {
      return;
    }

    const participant = rooms[roomId].participants[socket.id];
    const isHost = participant && participant.id === rooms[roomId].hostId;
    const hostMasterControls = rooms[roomId].hostMasterControls;

    // Update the participant's own state
    rooms[roomId].participants[socket.id].audioEnabled = enabled;

    // If this is the host and master audio control is enabled
    if (isHost && hostMasterControls.controlAllAudio) {
      console.log(`Host is toggling audio for all participants: ${enabled}`);

      // Apply to all other participants
      Object.entries(rooms[roomId].participants).forEach(
        ([participantId, p]) => {
          if (participantId !== socket.id) {
            // Don't affect the host themselves
            // Update state
            rooms[roomId].participants[participantId].audioEnabled = enabled;

            // Send force control to each participant
            io.to(participantId).emit("host-master-audio-control", {
              enabled,
              forced: true,
              hostUsername: participant.username,
            });
          }
        }
      );

      // Notify all participants about the global change
      io.to(roomId).emit("user-toggle-audio", {
        participantId: socket.id,
        peerId,
        enabled,
        isHostMasterControl: true,
      });

      // Send system message
      io.to(roomId).emit("chat-system-message", {
        id: uuidv4(),
        message: `Host ${enabled ? "unmuted" : "muted"} everyone's microphone`,
        timestamp: new Date(),
        type: "system",
        systemType: "host-action",
      });
    } else {
      // Normal participant audio toggle or host with master control disabled
      socket.to(roomId).emit("user-toggle-audio", {
        participantId: socket.id,
        peerId,
        enabled,
        isHostMasterControl: false,
      });
    }
  });

  // UPDATED: Handle user muting/unmuting video with host master control
  socket.on("toggle-video", ({ roomId, peerId, enabled }) => {
    console.log(`Video toggle: ${socket.id} - ${enabled}`);

    if (!rooms[roomId] || !rooms[roomId].participants[socket.id]) {
      return;
    }

    const participant = rooms[roomId].participants[socket.id];
    const isHost = participant && participant.id === rooms[roomId].hostId;
    const hostMasterControls = rooms[roomId].hostMasterControls;

    // Update the participant's own state
    rooms[roomId].participants[socket.id].videoEnabled = enabled;

    // If this is the host and master video control is enabled
    if (isHost && hostMasterControls.controlAllVideo) {
      console.log(`Host is toggling video for all participants: ${enabled}`);

      // Apply to all other participants
      Object.entries(rooms[roomId].participants).forEach(
        ([participantId, p]) => {
          if (participantId !== socket.id) {
            // Don't affect the host themselves
            // Update state
            rooms[roomId].participants[participantId].videoEnabled = enabled;

            // Send force control to each participant
            io.to(participantId).emit("host-master-video-control", {
              enabled,
              forced: true,
              hostUsername: participant.username,
            });
          }
        }
      );

      // Notify all participants about the global change
      io.to(roomId).emit("user-toggle-video", {
        participantId: socket.id,
        peerId,
        enabled,
        isHostMasterControl: true,
      });

      // Send system message
      io.to(roomId).emit("chat-system-message", {
        id: uuidv4(),
        message: `Host ${enabled ? "enabled" : "disabled"} everyone's camera`,
        timestamp: new Date(),
        type: "system",
        systemType: "host-action",
      });
    } else {
      // Normal participant video toggle or host with master control disabled
      socket.to(roomId).emit("user-toggle-video", {
        participantId: socket.id,
        peerId,
        enabled,
        isHostMasterControl: false,
      });
    }
  });

  // Individual host control for audio (existing functionality)
  socket.on(
    "host-control-audio",
    ({ roomId, targetPeerId, action, forced }) => {
      const room = rooms[roomId];
      if (!room) return;

      const hostParticipant = room.participants[socket.id];

      if (!hostParticipant || !hostParticipant.isHost) {
        socket.emit("chat-error", {
          message: "Only hosts can control other participants",
        });
        return;
      }

      let targetSocketId = null;
      for (const [socketId, participant] of Object.entries(room.participants)) {
        if (participant.peerId === targetPeerId) {
          targetSocketId = socketId;
          break;
        }
      }

      if (!targetSocketId) {
        socket.emit("chat-error", { message: "Participant not found" });
        return;
      }

      if (action === "mute") {
        room.participants[targetSocketId].audioEnabled = false;

        io.to(targetSocketId).emit("host-muted-audio", { forced });

        io.to(roomId).emit("user-toggle-audio", {
          participantId: targetSocketId,
          peerId: targetPeerId,
          enabled: false,
        });

        io.to(roomId).emit("chat-system-message", {
          id: uuidv4(),
          message: `${room.participants[targetSocketId].username} was muted by host`,
          timestamp: new Date(),
          type: "system",
          systemType: "host-action",
        });
      } else if (action === "unmute") {
        io.to(targetSocketId).emit("host-unmuted-audio");

        io.to(roomId).emit("chat-system-message", {
          id: uuidv4(),
          message: `Host requested ${room.participants[targetSocketId].username} to unmute`,
          timestamp: new Date(),
          type: "system",
          systemType: "host-request",
        });
      }
    }
  );

  // Individual host control for video (existing functionality)
  socket.on(
    "host-control-video",
    ({ roomId, targetPeerId, action, forced }) => {
      const room = rooms[roomId];
      if (!room) return;

      const hostParticipant = room.participants[socket.id];

      if (!hostParticipant || !hostParticipant.isHost) {
        socket.emit("chat-error", {
          message: "Only hosts can control other participants",
        });
        return;
      }

      let targetSocketId = null;
      for (const [socketId, participant] of Object.entries(room.participants)) {
        if (participant.peerId === targetPeerId) {
          targetSocketId = socketId;
          break;
        }
      }

      if (!targetSocketId) {
        socket.emit("chat-error", { message: "Participant not found" });
        return;
      }

      if (action === "disable") {
        room.participants[targetSocketId].videoEnabled = false;

        io.to(targetSocketId).emit("host-disabled-video", { forced });

        io.to(roomId).emit("user-toggle-video", {
          participantId: targetSocketId,
          peerId: targetPeerId,
          enabled: false,
        });

        io.to(roomId).emit("chat-system-message", {
          id: uuidv4(),
          message: `${room.participants[targetSocketId].username}'s camera was turned off by host`,
          timestamp: new Date(),
          type: "system",
          systemType: "host-action",
        });
      } else if (action === "enable") {
        io.to(targetSocketId).emit("host-enabled-video");

        io.to(roomId).emit("chat-system-message", {
          id: uuidv4(),
          message: `Host requested ${room.participants[targetSocketId].username} to turn on camera`,
          timestamp: new Date(),
          type: "system",
          systemType: "host-request",
        });
      }
    }
  );

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

      rooms[roomId].messages.push(messageData);

      if (rooms[roomId].messages.length > 100) {
        rooms[roomId].messages = rooms[roomId].messages.slice(-100);
      }

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

      if (!isHost && !rooms[roomId].chatSettings.allowPrivateMessages) {
        socket.emit("chat-error", { message: "Private messages are disabled" });
        return;
      }

      let recipientId = null;

      if (toHost) {
        recipientId = rooms[roomId].hostId;
      } else if (recipient) {
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

      rooms[roomId].messages.push(messageData);

      if (rooms[roomId].messages.length > 100) {
        rooms[roomId].messages = rooms[roomId].messages.slice(-100);
      }

      socket.emit("private-message", messageData);

      if (recipientId !== socket.id) {
        io.to(recipientId).emit("private-message", messageData);
      }

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

    rooms[roomId].messages.push(messageData);

    if (rooms[roomId].messages.length > 100) {
      rooms[roomId].messages = rooms[roomId].messages.slice(-100);
    }

    socket.emit("host-message", messageData);
  });

  // Handle system messages
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
      systemType: type,
    };

    rooms[roomId].messages.push(messageData);

    if (rooms[roomId].messages.length > 100) {
      rooms[roomId].messages = rooms[roomId].messages.slice(-100);
    }

    io.to(roomId).emit("chat-system-message", messageData);
  });

  // Handle chat settings updates
  socket.on("update-chat-settings", ({ roomId, settings }) => {
    if (!rooms[roomId]) {
      return;
    }

    const participant = rooms[roomId].participants[socket.id];
    const isHost = participant && participant.id === rooms[roomId].hostId;

    if (!isHost) {
      socket.emit("chat-error", {
        message: "Only host can update chat settings",
      });
      return;
    }

    rooms[roomId].chatSettings = { ...rooms[roomId].chatSettings, ...settings };

    console.log(
      `Chat settings updated in room ${roomId}:`,
      rooms[roomId].chatSettings
    );

    io.to(roomId).emit("chat-settings-updated", rooms[roomId].chatSettings);
  });

  // Handle typing indicators
  socket.on("typing-indicator", ({ roomId, username, isTyping }) => {
    if (!rooms[roomId]) {
      return;
    }

    socket.to(roomId).emit("user-typing", {
      username,
      isTyping,
    });
  });

  // Handle screen sharing events
  socket.on("user-screen-share", ({ roomId, peerId, isSharing }) => {
    console.log(`Screen share toggle: ${socket.id} - ${isSharing}`);

    if (rooms[roomId] && rooms[roomId].participants[socket.id]) {
      rooms[roomId].participants[socket.id].isScreenSharing = isSharing;

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

  // Handle removing a participant
  socket.on("remove-participant", ({ roomId, participantId, peerId }) => {
    console.log(`Removing participant: ${participantId}`);

    if (!rooms[roomId]) {
      return;
    }

    const requester = rooms[roomId].participants[socket.id];
    const isHost = requester && requester.id === rooms[roomId].hostId;

    if (!isHost) {
      socket.emit("chat-error", {
        message: "Only host can remove participants",
      });
      return;
    }

    if (rooms[roomId].participants[participantId]) {
      const removedParticipant = rooms[roomId].participants[participantId];

      const systemMessage = {
        id: uuidv4(),
        message: `${removedParticipant.username} was removed from the meeting`,
        timestamp: new Date(),
        type: "system",
        systemType: "remove",
      };

      rooms[roomId].messages.push(systemMessage);
      io.to(roomId).emit("chat-system-message", systemMessage);

      io.to(participantId).emit("you-were-removed");

      socket.to(roomId).emit("user-removed", {
        participantId,
        peerId,
      });

      delete rooms[roomId].participants[participantId];

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

    rooms[roomId].hostId = newHostId;
    rooms[roomId].participants[socket.id].isHost = false;
    rooms[roomId].participants[newHostId].isHost = true;

    socket.emit("host-assigned", { isHost: false });
    io.to(newHostId).emit("host-assigned", { isHost: true });

    const systemMessage = {
      id: uuidv4(),
      message: `${newHost.username} is now the host`,
      timestamp: new Date(),
      type: "system",
      systemType: "host-change",
    };

    rooms[roomId].messages.push(systemMessage);
    io.to(roomId).emit("chat-system-message", systemMessage);

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

    for (const roomId in rooms) {
      if (rooms[roomId].participants[socket.id]) {
        const participant = rooms[roomId].participants[socket.id];
        const wasHost = participant.id === rooms[roomId].hostId;

        console.log(
          `${participant.username} left room ${roomId}${
            wasHost ? " (was host)" : ""
          }`
        );

        const systemMessage = {
          id: uuidv4(),
          message: `${participant.username} left the meeting`,
          timestamp: new Date(),
          type: "system",
          systemType: "leave",
        };

        rooms[roomId].messages.push(systemMessage);
        socket.to(roomId).emit("chat-system-message", systemMessage);

        socket.to(roomId).emit("user-left", {
          participantId: socket.id,
          peerId: participant.peerId,
          username: participant.username,
        });

        delete rooms[roomId].participants[socket.id];

        if (wasHost) {
          const remainingParticipants = Object.values(
            rooms[roomId].participants
          );
          if (remainingParticipants.length > 0) {
            const newHost = remainingParticipants[0];
            rooms[roomId].hostId = newHost.id;
            newHost.isHost = true;

            io.to(newHost.id).emit("host-assigned", { isHost: true });

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

        if (Object.keys(rooms[roomId].participants).length === 0) {
          setTimeout(() => {
            if (
              rooms[roomId] &&
              Object.keys(rooms[roomId].participants).length === 0
            ) {
              delete rooms[roomId];
              console.log(`Room ${roomId} has been removed due to inactivity`);
            }
          }, 60000);
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
      hostMasterControls: rooms[roomId].hostMasterControls,
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
    hostMasterControls: room.hostMasterControls,
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
    hostMasterControls: room.hostMasterControls,
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Debug endpoint: http://localhost:${PORT}/api/debug/rooms`);
});
