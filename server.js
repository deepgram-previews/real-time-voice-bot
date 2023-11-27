import 'dotenv/config'
import path from "path";
import express from "express";
import pkg from "@deepgram/sdk";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";
import { ChatOpenAI } from "langchain/chat_models/openai";
import { ConversationChain } from "langchain/chains";
import { BufferMemory } from "langchain/memory";
import { ChatPromptTemplate, SystemMessagePromptTemplate } from "langchain/prompts";
import models from "./models.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Deepgram } = pkg;
let deepgrams = {};
let socket;
let dgLiveObjs = {};
let globalSockets = {};
let openAIChats = {};
let TTS_API = 'https://api.beta.deepgram.com/v1/speak';
let PORT = 3000;
let micOn = false;
let websocketReady = false;
let keepAliveMessage = (new TextEncoder()).encode('{"type":"KeepAlive"}');
let lastMessageSent = 0;
let gotOneResponseFromDG = false;

async function promptAI(socketId, message) {
  if (message === undefined || message === 'undefined') {
    console.log("message is undefined");
    return;
  }
  // console.log('message: ', message);
  message += "\n\nKeep your response short.";
  const response = await openAIChats[socketId].call({ input: message });
  // console.log('response: ', response);
  return response;
}

async function readAllChunks(readableStream) {
  const reader = readableStream.getReader();
  const chunks = [];

  let done, value;
  while (!done) {
    ({ value, done } = await reader.read());
    if (done) {
      return chunks;
    }
    chunks.push(value);
  }
}

async function getTextToSpeech(message) {
  const response = await fetch(TTS_API, {
    method: 'POST',
    headers: {
      'authorization': `token ${process.env.DEEPGRAM_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ text: message })
  });
  return response.blob();
}

const createNewDeepgram = () => {
  return new Deepgram(process.env.DEEPGRAM_API_KEY);
};

const createNewDeepgramLive = (dg) => {
  return dg.transcription.live({
    language: "en-US",
    smart_format: true,
    model: "nova",
    interim_results: true,
    endpointing: 500,
    no_delay: false,
    utterance_end_ms: 1000,
  });
};

const app = express();
app.use(express.static("public/"));

app.get("/", function (req, res) {
  res.sendFile(__dirname + "/index.html");
});

app.get("/new", async (req, res) => {
  let model = req.query.model;
  createWebsocket(model);
  let interval = setInterval(() => {
    if (websocketReady) {
      clearInterval(interval);
      res.status(200).send();
    }
  }, 100);
});

app.get("/mic-toggle", async (req, res) => {
  let turn_on = req.query.on === "true";
  if (turn_on) {
    micOn = true;
    // console.log("turned on mic");
  } else {
    micOn = false;
    // console.log("turned off mic");
  }
  res.status(200).send();
});

app.get("/chat", async (req, res) => {
  // Respond with error if no API Key set
  if (!process.env.OPEN_AI_API_KEY) {
    res.status(500).send({ err: 'No OpenAI API Key set in the .env file' });
    return;
  }
  let message = req.query.message;
  let socketId = req.query.socketId;

  try {
    let response = await promptAI(socketId, message);

    res.send({ response });
  } catch (err) {
    console.log(err);
    res.status(500).send({ err: err.message ? err.message : err });
  }
});

app.get("/speak", async (req, res) => {
  // Respond with error if no API Key set
  if (!process.env.DEEPGRAM_API_KEY) {
    res.status(500).send({ err: 'No DEEPGRAM_API_KEY set in the .env file' });
    return;
  }
  let text = req.query.text;
  // remove code blocks from the text
  if (text.includes("```")) {
    text = text.replace(/```[\s\S]*?```/g, '\n\n');
  }

  try {
    let response = await getTextToSpeech(text);

    res.type(response.type)
    response.arrayBuffer().then((buf) => {
      res.send(Buffer.from(buf))
    });
  } catch (err) {
    console.log(err);
    res.status(500).send({ err: err.message ? err.message : err });
  }
});

const httpServer = createServer(app);

// Pull out connection logic so we can call it outside of the socket connection event
const initDgConnection = (socketId) => {
  if (!deepgrams[socketId]) {
    deepgrams[socketId] = createNewDeepgram();
  }
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

const createWebsocket = (model) => {
  if (!socket) {
    socket = new Server(httpServer, {
      transports: "websocket",
      cors: {}
    });
    socket.on("connection", (clientSocket) => {
      let socketId = clientSocket.id;
      // console.log(`Connected on server side with ID: ${socketId}`);
      globalSockets[socketId] = clientSocket;

      if (process.env.OPEN_AI_API_KEY) {
        console.log("Creating new websocket for model '" + model + "'");
        websocketReady = false;
        let prompt_ = ChatPromptTemplate.fromPromptMessages([
          SystemMessagePromptTemplate.fromTemplate(models[model]),
        ]);
        let llm = new ChatOpenAI({ openAIApiKey: process.env.OPEN_AI_API_KEY, temperature: 0 });
        let memory = new BufferMemory();
        // let conversation = new ConversationChain({llm: llm, memory: memory, prompt: prompt_});
        let conversation = new ConversationChain({ llm: llm, memory: memory });
        openAIChats[socketId] = conversation;
        // send the prompt as the initial message
        openAIChats[socketId].call({ input: models[model] }).then(() => {
          // console.log("websocket is ready", socketId);
          console.log("websocket is ready");
          websocketReady = true;
        });
      } else {
        throw new Error("Must set OPEN_AI_API_KEY");
      }

      initDgConnection(socketId);
      socket.on('disconnect', () => {
        console.log('User disconnected.', socketId);
        globalSockets[socketId].removeAllListeners();
        delete globalSockets[socketId];
        dgLiveObjs[socketId].removeAllListeners();
        delete dgLiveObjs[socketId];
        delete openAIChats[socketId];
        delete speechChunks[socketId];
      });

      globalSockets[socketId].emit("socketId", socketId);
    });
  }
};

let speechChunks = {};
const addDeepgramTranscriptListener = (socketId) => {
  let _socketId = socketId;
  dgLiveObjs[socketId].addListener("transcriptReceived", async (dgOutput) => {
    let dgJSON = JSON.parse(dgOutput);
    let words = [];
    if (dgJSON.channel) {
      if (dgJSON.channel.alternatives[0].transcript !== '') {
        console.log('Deepgram response:');
        console.log('  is_final:    ', dgJSON.is_final);
        console.log('  speech_final:', dgJSON.speech_final);
        console.log('  transcript:  ', dgJSON.channel.alternatives[0].transcript, '\n');
      }
      let utterance;
      try {
        utterance = dgJSON.channel.alternatives[0].transcript;
        words = words.concat(dgJSON.channel.alternatives[0].words);
      } catch (error) {
        console.log(
          "WARNING: parsing dgJSON failed. Response from dgLive is:",
          error
        );
      }
      if (utterance) {
        if (!speechChunks[socketId]) {
          speechChunks[socketId] = '';
        }
        if (dgJSON.speech_final) {
          speechChunks[socketId] += utterance + ' ';
          globalSockets[_socketId].emit("speech-final", { utterance: speechChunks[socketId], words });
          // console.log(`SPEECH_FINAL socketId: ${_socketId}: ${speechChunks[socketId]}`);
          speechChunks[socketId] = '';
          words = [];
        } else if (dgJSON.is_final) {
          speechChunks[socketId] += utterance + ' ';
          // console.log('IS_FINAL:', speechChunks[socketId]);
        } else {
          globalSockets[_socketId].emit("interim-result", { utterance, words });
          // console.log('INTERIM_RESULT:', utterance);
        }
        // console.log('debug:',dgJSON)
      }
    } else {
      if (speechChunks[socketId] !== undefined && speechChunks[socketId] !== '') {
        globalSockets[_socketId].emit("speech-final", { utterance: speechChunks[socketId], words });
        // console.log(`UTTERANCE_END_MS Triggered socketId: ${_socketId}: ${speechChunks[socketId]}`);
        console.log('Got `UtteranceEnd` message, considering last transcript to be "final"');
        speechChunks[socketId] = '';
      } else {
        // console.log(`UTTERANCE_END_MS Not Triggered socketId: ${_socketId}: ${speechChunks[socketId]}`);
      }
    }
    gotOneResponseFromDG = true;
  });
};

const addDeepgramOpenListener = (socketId) => {
  dgLiveObjs[socketId].addListener("open", (msg) => {
    // console.log(`dgLive socketId: ${socketId} WEBSOCKET CONNECTION OPEN!`);
  });
};

const addDeepgramCloseListener = (socketId) => {
  dgLiveObjs[socketId].addListener("close", async (msg) => {
    console.log(`dgLive socketId: ${socketId} CONNECTION CLOSED!`);
    // console.log(`Reconnecting`);
    dgLiveObjs[socketId] = null;
    delete dgLiveObjs[socketId];
  });
};

const addDeepgramErrorListener = (socketId) => {
  dgLiveObjs[socketId].addListener("error", async (msg) => {
    console.log("ERROR MESG", msg);
    // console.log(`dgLive socketId: ${socketId} ERROR::Type:${msg.type} / Code:${msg.code}`);
  });
};

const dgPacketResponse = (event, socketId) => {
  if (dgLiveObjs[socketId] && dgLiveObjs[socketId].getReadyState() === 1) {
    // dgLiveObjs[socketId].send(event);
    // console.log("sent audio to DG");
    if ((!gotOneResponseFromDG) || (micOn && event.length !== 126)) {
      dgLiveObjs[socketId].send(event);
      lastMessageSent = Date.now();
      // console.log("sent audio to DG");
    } else {
      sendKeepAlive(dgLiveObjs[socketId]);
    }
  } else {
    // console.log("did not send audio to DG", micOn);
  }
};

const sendKeepAlive = (dgLive) => {
  if (Date.now() - lastMessageSent > 8000 && gotOneResponseFromDG) {
    lastMessageSent = Date.now();
    dgLive._socket.send(
      JSON.stringify({
        type: "KeepAlive"
      })
    );
    // console.log("sent keep alive to DG");
  }
}

console.log('Starting Server on Port ', PORT);
httpServer.listen(PORT);

// createWebsocket('listener');
