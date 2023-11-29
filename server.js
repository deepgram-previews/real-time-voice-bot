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
// import { ChatPromptTemplate, SystemMessagePromptTemplate } from 'langchain/prompts';
import models from "./models.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Deepgram } = pkg;
let socket = null;
let stt = null;
let globalSocket = null;
let chatbot = null;
let micOn = false;
let chatClientReady = false;
let lastMessageSentToDG = 0;
let gotOneResponseFromDG = false;
let speechChunk = null;

function resetToInitialState() {
  if (globalSocket) {
    globalSocket.removeAllListeners();
  }
  if (stt) {
    stt.removeAllListeners();
  }
  socket = null;
  stt = null;
  globalSocket = null;
  chatbot = null;
  micOn = false;
  chatClientReady = false;
  lastMessageSentToDG = 0;
  gotOneResponseFromDG = false;
  speechChunk = null;
}

async function promptAI(message) {
  if (message === undefined || message === 'undefined') {
    console.log("message is undefined");
    return;
  }
  // console.log('message: ', message);
  message += "\n\nKeep your response short.";
  const response = await chatbot.call({ input: message });
  // console.log('response: ', response);
  return response;
}

const initializeSTT = () => {
  const dg = new Deepgram(process.env.DEEPGRAM_API_KEY);
  stt = dg.transcription.live({
    language: "en-US",
    smart_format: true,
    model: "nova",
    interim_results: true,
    endpointing: 500,
    no_delay: false,
    utterance_end_ms: 1000,
  });
};

async function getTextToSpeech(message) {
  const tts_api = 'https://api.beta.deepgram.com/v1/speak';
  const response = await fetch(tts_api, {
    method: 'POST',
    headers: {
      'authorization': `token ${process.env.DEEPGRAM_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ text: message })
  });
  return response.blob();
}

const app = express();
app.use(express.static("public/"));

app.get("/", function (req, res) {
  res.sendFile(__dirname + "/index.html");
});

app.get("/new", async (req, res) => {
  let model = req.query.model;
  resetToInitialState();
  createWebsocket(model);
  let interval = setInterval(() => {
    if (chatClientReady) {
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

  try {
    let response = await promptAI(message);

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
const initDgConnection = () => {
  initializeSTT();
  addDeepgramTranscriptListener();
  addDeepgramOpenListener();
  addDeepgramCloseListener();
  addDeepgramErrorListener();
  // receive data from client and send to dgLive
  globalSocket.on("packet-sent", async (event) =>
    dgPacketResponse(event)
  );
};

const createWebsocket = (model) => {
  if (!socket) {
    socket = new Server(httpServer, {
      transports: "websocket",
      cors: {}
    });
    socket.on("connection", (clientSocket) => {
      globalSocket = clientSocket;

      if (process.env.OPEN_AI_API_KEY) {
        console.log("Creating new websocket for model '" + model + "'");
        chatClientReady = false;
        /*let prompt_ = ChatPromptTemplate.fromPromptMessages([
          SystemMessagePromptTemplate.fromTemplate(models[model]),
        ]);*/
        let llm = new ChatOpenAI({ openAIApiKey: process.env.OPEN_AI_API_KEY, temperature: 0 });
        let memory = new BufferMemory();
        // conversation = new ConversationChain({ llm: llm, memory: memory, prompt: prompt_ });
        chatbot = new ConversationChain({ llm: llm, memory: memory });
        // send the prompt as the initial message
        chatbot.call({ input: models[model] }).then(() => {
          console.log("websocket is ready");
          chatClientReady = true;
        });
      } else {
        throw new Error("Must set OPEN_AI_API_KEY");
      }

      initDgConnection();
      socket.on('disconnect', () => {
        console.log('User disconnected.');
        resetToInitialState();
      });

      globalSocket.emit("socketId", clientSocket.id);
    });
  }
};

const addDeepgramTranscriptListener = () => {
  stt.addListener("transcriptReceived", async (dgOutput) => {
    let dgJSON = JSON.parse(dgOutput);
    // console.log('debug:', dgJSON)
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
        console.log("WARNING: parsing dgJSON failed. Response from Deepgram is:", error);
      }
      if (utterance) {
        if (!speechChunk) {
          speechChunk = '';
        }
        if (dgJSON.speech_final) {
          speechChunk += utterance + ' ';
          globalSocket.emit("speech-final", { utterance: speechChunk, words });
          // console.log(`SPEECH_FINAL: ${speechChunk}`);
          speechChunk = '';
          words = [];
        } else if (dgJSON.is_final) {
          speechChunk += utterance + ' ';
          // console.log('IS_FINAL:', speechChunk);
        } else {
          globalSocket.emit("interim-result", { utterance, words });
          // console.log('INTERIM_RESULT:', utterance);
        }
      }
    } else {
      if (speechChunk !== undefined && speechChunk !== '') {
        globalSocket.emit("speech-final", { utterance: speechChunk, words });
        // console.log(`UTTERANCE_END_MS Triggered: ${speechChunk}`);
        console.log('Got `UtteranceEnd` message, considering last transcript to be "final"');
        speechChunk = '';
      } else {
        // console.log(`UTTERANCE_END_MS Not Triggered: ${speechChunk}`);
      }
    }
    gotOneResponseFromDG = true;
  });
};

const addDeepgramOpenListener = () => {
  stt.addListener("open", (msg) => {
    // console.log(`Deepgram websocket: CONNECTION OPEN!`);
  });
};

const addDeepgramCloseListener = () => {
  stt.addListener("close", async (msg) => {
    console.log(`Deepgram websocket: CONNECTION CLOSED!`);
    stt = null;
  });
};

const addDeepgramErrorListener = () => {
  stt.addListener("error", async (msg) => {
    console.log("ERROR MESG", msg);
    // console.log(`Deepgram websocket ERROR::Type:${msg.type} / Code:${msg.code}`);
  });
};

const dgPacketResponse = (event) => {
  if (stt && stt.getReadyState() === 1) {
    if ((!gotOneResponseFromDG) || (micOn && event.length !== 126)) {
      stt.send(event);
      lastMessageSentToDG = Date.now();
      // console.log("sent audio to DG");
    } else {
      // This method gets triggered every ~0.5 seconds so we can use it as an interval to send keep alives
      sendKeepAlive(stt);
    }
  } else {
    // console.log("did not send audio to DG", micOn);
  }
};

const sendKeepAlive = (dgLive) => {
  if (Date.now() - lastMessageSentToDG > 8000 && gotOneResponseFromDG) {
    lastMessageSentToDG = Date.now();
    dgLive._socket.send(
      JSON.stringify({
        type: "KeepAlive"
      })
    );
    // console.log("sent keep alive to DG");
  }
}

const PORT = 3000;
console.log('Starting Server on Port ', PORT);
httpServer.listen(PORT);

// createWebsocket('listener');
