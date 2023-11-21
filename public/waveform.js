let wavesurfer, record, regions, micSelect
let scrollingWaveform = true
let startTime = 0;
const createWaveSurfer = () => {
    // Create an instance of WaveSurfer
    if (wavesurfer) {
        wavesurfer.destroy()
    }
    wavesurfer = WaveSurfer.create({
        container: '#mic',
        waveColor: 'rgb(200, 0, 200)',
        progressColor: 'rgb(100, 0, 100)',
        plugins: [
            WaveSurfer.Record.create({ scrollingWaveform, renderRecordedAudio: false }),
            WaveSurfer.Regions.create({  })
        ]
    })

    record = wavesurfer.plugins[0];
    regions = wavesurfer.plugins[1];
    // Render recorded audio
    record.on('record-end', (blob) => {

    })

    micSelect = document.querySelector('#mic-select')
        {
            // Mic selection
            WaveSurfer.Record.getAvailableAudioDevices().then((devices) => {
                devices.forEach((device, index) => {

                })
            })
        }
}

function stopLiveWaveform(){
    if (record.isPaused()) {
        record.resumeRecording()
        return
    }

    record.pauseRecording()
}

function startLiveWaveform(){
    const deviceId = 'default';
    record.startRecording({ deviceId }).then(() => {

    })
    const d = new Date();
    startTime = d.getMilliseconds();
}

createWaveSurfer()

let regionsArr = [];
function addRegion(word){
    const d = new Date();
    let now = d.getMilliseconds();
    let delta = (now - startTime) / 1000;
    let region = regions.addRegion({
        id: 'wavesurfer_region_',
        start: (word.start - delta)+ 2.5 ,
        end: (word.end - delta)+ 2.5 ,
        color: '#38edac44',
        drag: true,
        resize: false,
        attributes: {
            label: word.word
        }
    })
    regionsArr.push(region);

    // setInterval(()=>{
    //     updateRegions(word);
    // }, 1000)
}

function updateRegions(word){
    const d = new Date();
    let now = d.getMilliseconds();
    let delta = (now - startTime) / 1000 + 2.5;
    regionsArr.forEach((region, index)=>{
        // region.update({
        //     start: region.start - delta,
        //     end: region.end - delta,
        // });
        region.remove();
        
        regionsArr.splice(index, 1);
        word.start = word.start - delta;
        word.end = word.end - delta;
        addRegion(word);
    })
}