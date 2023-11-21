let socket;
let mediaRecorder;

let conversation = document.getElementById('conversation');
let mic = document.getElementById('mic');
let offset = 300;
let scrollOverride = false;
let recording = false;
let socketId = null;
let lineIndex = 0;
const apiOrigin = "http://localhost:3000";
const wssOrigin = "http://localhost:3000";

var audio_file = document.getElementById("audio_file");
let audioElm = null;
let loadWordsTimeout = null;

async function updateAudio(text){
    audioElm = document.createElement('audio');
    audioElm.setAttribute('controls', '');
    audioElm.setAttribute('autoplay', 'true');
    let source = document.createElement('source');

    let response = await getAudioForText(text);
    let data = await response.blob();
    const url = URL.createObjectURL(data);
    source.setAttribute('src', url);

    source.setAttribute('type', 'audio/mp3');

    audioElm.appendChild(source);

    audio_file.innerHTML = '';
    audio_file.appendChild(audioElm);
    audioElm.play();
}

async function getAudioForText(text){
    const url = apiOrigin + '/speak?text=' + text;

    return await fetch(url)
}

navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((stream) => {
    mediaRecorder = new MediaRecorder(stream);
    socket = io(wssOrigin, (options = { transports: ["websocket"] }));
  })
  .then(() => {
    socket.on("connect", async () => {
      if (mediaRecorder.state == "inactive") mediaRecorder.start(500);

      mediaRecorder.addEventListener("dataavailable", (event) => {
        socket.emit("packet-sent", event.data);
      });

      socket.addEventListener("interim-result", (msg) => {
        if(recording){
            // Handle Barge In
            audioElm.pause();
            clearTimeout(loadWordsTimeout);
            addText(msg, false, true);
        }
      });
      socket.addEventListener("speech-final", (msg) => {
        if(recording){
            addText(msg, false, true);
            lineIndex++;
            promptAI(socketId, msg);
        }
      });
      socket.addEventListener("socketId", (socket_id) => {
        socketId = socket_id;
      });
    });
  });

function addText(text, isAI, replaceLine){
    let div = document.getElementById('chat_line_'+lineIndex);
    
    if(!div){
      div = document.createElement('div');
    }
    if(replaceLine){
      div.innerHTML = '';
    }
    div.id = 'chat_line_'+lineIndex + (isAI ? '_ai' : '');
    div.className = 'response';
    div.style.color = isAI ? '#FFFFFF' : '#bd80dc';
    conversation.appendChild(div);
    if(replaceLine){
      div.innerHTML = text;
    }else {
      let words = text.replaceAll('\n', '<br>').split(' ');
      loadWords(div, words, 0);
    }
}

function loadWords(div, words, index){
    div.innerHTML += words[index] + ' ';
    if(index < words.length-1){
        loadWordsTimeout = setTimeout(()=>{
            loadWords(div, words, index+1);
        }, 100);
    }
}

async function promptAI(socketId, msg) {
    let model = document.getElementById('model').value;
    const response = await fetch(`${apiOrigin}/chat?socketId=${socketId}&model=${model}&message=${encodeURIComponent(msg)}`, {
      method: "GET"
    });

    const data = await response.json();

    // Make sure to configure your OpenAI API Key in config.json for this to work
    if(data && !data.err){
      lineIndex++;
      let reply = data.response.data.content;
      updateAudio(reply);
      addText(reply, true);
    } else {
      alert('Error: You must configure your OpenAI API Key in the config.json to use the "Respond with AI" feature.');
    }
}

function recordingStart(){
    recording = true;
    mic.setAttribute('src', 'mic_on.png');
}

function recordingStop(){
    setTimeout(()=>{
        recording = false;
    }, 1000)
    mic.setAttribute('src', 'mic_off.png');
}

function toggleRecording(){
    if(recording){
        recordingStop();
    } else {
        recordingStart();
    } 
}

function modelChanged(){
  document.getElementById('conversation').innerHTML = '';
}

document.getElementById('content').addEventListener('scroll', () => {
    var elem = document.getElementById('content');
    if(elem.scrollTop != elem.scrollHeight){
        scrollOverride = true;
    } else {
        scrollOverride = false;
    }
});

window.setInterval(function() {
    if(!scrollOverride){
        var elem = document.getElementById('content');
        elem.scrollTop = elem.scrollHeight;
    }
}, 200);
