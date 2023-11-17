import 'dotenv/config'
import path from "path";
import express from "express";
import pkg from "@deepgram/sdk";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import { ChatOpenAI }  from "langchain/chat_models/openai";
import { HumanChatMessage, SystemChatMessage } from "langchain/schema";
import models from "./models.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Deepgram } = pkg;
let deepgrams = {};
let socket;
let dgLiveObjs = {};
let globalSockets = {};
let openAIChats = {};

async function promptAI(socketId, model, message){
  const response = await openAIChats[socketId].call([
    new SystemChatMessage(
      models[model]
    ),
    new HumanChatMessage(
      message
    ),
  ]);
  console.log(response);
  return response;
}

const app = express();
app.use(express.static("public/"));

app.get("/", function (req, res) {
  res.sendFile(__dirname + "/index.html");
});

app.get("/chat", async (req, res) => {
  // Respond with error if no API Key set
  if(!process.env.OPEN_AI_API_KEY){
    res.status(500).send({ err: 'No OpenAI API Key set in the .env file' });
    return;
  }
  let model = req.query.model;
  let message = req.query.message;
  let socketId = req.query.socketId;
  console.log('message',message);

  try {
    let response = await promptAI(socketId, model, message);

    res.send({ response });
  } catch (err) {
    console.log(err);
    res.status(500).send({ err: err.message ? err.message : err });
  }
});

const httpServer = createServer(app);

// Pull out connection logic so we can call it outside of the socket connection event
const initDgConnection = (socketId) => {
  dgLiveObjs[socketId] = createNewDeepgramLive(deepgrams[socketId]);
  addDeepgramTranscriptListener(socketId);
  addDeepgramOpenListener(socketId);
  addDeepgramCloseListener(socketId);
  addDeepgramErrorListener(socketId);
  // receive data from client and send to dgLive
  globalSockets[socketId].on("packet-sent", async (event) =>
    dgPacketResponse(event, socketId)
  );
};

const createWebsocket = () => {
  if(!socket){
    socket = new Server(httpServer, { transports: "websocket",
      cors: { }
    });
    socket.on("connection", (clientSocket) => {
      let socketId = clientSocket.id;
      console.log(`Connected on server side with ID: ${socketId}`);
      globalSockets[socketId] = clientSocket;
      if(!deepgrams[socketId]){
        deepgrams[socketId] = createNewDeepgram();
      }

      if(process.env.OPEN_AI_API_KEY){
        openAIChats[socketId] = new ChatOpenAI({ openAIApiKey: process.env.OPEN_AI_API_KEY, temperature: 0 });
      }

      initDgConnection(socketId);
      socket.on('disconnect', () => {
        console.log('User disconnected.', socketId);
        globalSockets[socketId].removeAllListeners();
        delete globalSockets[socketId];
        dgLiveObjs[socketId].removeAllListeners();
        delete dgLiveObjs[socketId];
        delete openAIChats[socketId];
      });

      globalSockets[socketId].emit("socketId", socketId);
    });
  }
}; 

const createNewDeepgram = () => {
  return new Deepgram(process.env.DEEPGRAM_API_KEY);
};

const createNewDeepgramLive = (dg) => {
  return dg.transcription.live({
    language: "en",
    punctuate: true,
    smart_format: true,
    model: "nova",
  });
};

const addDeepgramTranscriptListener = (socketId) => {
  let _socketId = socketId;
  dgLiveObjs[socketId].addListener("transcriptReceived", async (dgOutput) => {
    let dgJSON = JSON.parse(dgOutput);
    let utterance;
    try {
      utterance = dgJSON.channel.alternatives[0].transcript;
    } catch (error) {
      console.log(
        "WARNING: parsing dgJSON failed. Response from dgLive is:",
        error
      );
      console.log(dgJSON);
    }
    if (utterance) {
      globalSockets[_socketId].emit("print-transcript", utterance);
      console.log(`NEW UTTERANCE socketId: ${_socketId}: ${utterance}`);
    }
  });
};

const addDeepgramOpenListener = (socketId) => {
  dgLiveObjs[socketId].addListener("open", async (msg) =>
    console.log(`dgLive socketId: ${socketId} WEBSOCKET CONNECTION OPEN!`)
  );
};

const addDeepgramCloseListener = (socketId) => {
  dgLiveObjs[socketId].addListener("close", async (msg) => {
    console.log(`dgLive socketId: ${socketId} CONNECTION CLOSED!`);
    console.log(`Reconnecting`);
    createWebsocket();
  });
};

const addDeepgramErrorListener = (socketId) => {
  dgLiveObjs[socketId].addListener("error", async (msg) => {
    console.log("ERROR MESG", msg);
    console.log(`dgLive socketId: ${socketId} ERROR::Type:${msg.type} / Code:${msg.code}`);
  });
};

const dgPacketResponse = (event, socketId) => {
  if (dgLiveObjs[socketId].getReadyState() === 1) {
    dgLiveObjs[socketId].send(event);
  }
};

console.log('Starting Server on Port ', process.env.PORT);
httpServer.listen(process.env.PORT);

createWebsocket();
console.log('Running');