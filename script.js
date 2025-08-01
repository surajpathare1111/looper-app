// Looper Pedal Board – Robust Looper Volumes, 120%, Strict (2025-08-01)

let audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
let micStream = null, micSource = null;
let dryGain = null, wetGain = null, convolver = null, delayNode = null, delayGain = null;
let mixDest = null, processedStream = null;
let reverbLevel = 0, delayTime = 0;
let masterLoopDuration = null, masterBPM = null, masterIsSet = false;
let liveMicMonitorGain = null, liveMicMonitoring = false;

const dividerSelectors = [
  null, null,
  document.getElementById('divider2'),
  document.getElementById('divider3'),
  document.getElementById('divider4')
];
const bpmLabel = document.getElementById('bpmLabel');

function showMsg(msg, color = '#ff4444') {
  let el = document.getElementById('startMsg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'startMsg';
    document.body.prepend(el);
  }
  Object.assign(el.style, {
    display: 'block', color,
    background: '#111a22cc', fontWeight: 'bold',
    borderRadius: '12px', padding: '12px 22px',
    position: 'fixed', left: '50%', top: '8%',
    transform: 'translate(-50%,0)', zIndex: 1000,
    textAlign: 'center'
  });
  el.innerHTML = msg;
}
function hideMsg() {
  const el = document.getElementById('startMsg');
  if (el) el.style.display = 'none';
}

// --- FX Graph Setup ---
async function ensureMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showMsg("❌ Microphone not supported on this device/browser!");
    throw new Error("getUserMedia not supported.");
  }
  if (micStream) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        latency: { ideal: 0.01 }
      }
    });
  } catch (e) {
    showMsg("❌ Microphone access denied!<br>Enable permission in app settings.", "#ff4444");
    throw e;
  }
  audioCtx.resume();
  micSource = audioCtx.createMediaStreamSource(micStream);

  // FX Chain
  delayNode = audioCtx.createDelay(2.0);
  delayGain = audioCtx.createGain();
  delayNode.delayTime.value = 0;
  delayGain.gain.value = 0.5;
  delayNode.connect(delayGain);
  delayGain.connect(delayNode);

  convolver = audioCtx.createConvolver();
  convolver.buffer = createReverbImpulse(3.0, 2.0);
  convolver.normalize = true;

  dryGain = audioCtx.createGain();
  wetGain = audioCtx.createGain();
  dryGain.gain.value = 1;
  wetGain.gain.value = 0;

  // Mic routing: mic > dry + delay > convolver > wet
  micSource.connect(dryGain);
  micSource.connect(delayNode);
  delayNode.connect(convolver);
  convolver.connect(wetGain);

  // For recording: dry + wet to MediaRecorder
  mixDest = audioCtx.createMediaStreamDestination();
  dryGain.connect(mixDest);
  wetGain.connect(mixDest);
  processedStream = mixDest.stream;

  // For live output: special monitor gain, only active if button ON
  liveMicMonitorGain = audioCtx.createGain();
  liveMicMonitorGain.gain.value = 0; // start with monitor muted
  dryGain.connect(liveMicMonitorGain);
  wetGain.connect(liveMicMonitorGain);
  liveMicMonitorGain.connect(audioCtx.destination);

  hideMsg();
}

function createReverbImpulse(durationSeconds, decayFactor) {
  const sampleRate = audioCtx.sampleRate;
  const length = sampleRate * durationSeconds;
  const impulse = audioCtx.createBuffer(2, length, sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decayFactor);
    }
  }
  return impulse;
}

function addTapHandler(btn, fn) {
  if (!btn) return;
  btn.addEventListener('click', fn);
  btn.addEventListener('touchstart', e=>{e.preventDefault(); fn(e);}, {passive:false});
}
function addHoldHandler(btn, onStart, onEnd) {
  let hold=false;
  btn.addEventListener('mousedown',e=>{hold=true;onStart(e);});
  btn.addEventListener('touchstart',e=>{hold=true;onStart(e);},{passive:false});
  ['mouseup','mouseleave'].forEach(ev=>btn.addEventListener(ev,e=>{if(hold){onEnd(e);}hold=false;}));
  ['touchend','touchcancel'].forEach(ev=>btn.addEventListener(ev,e=>{if(hold){onEnd(e);}hold=false;},{passive:false}));
}
function addKnobDragHandler(el,getVal,setVal,disp,ind,min=0,max=100,scale=2.7,units='%'){
  let drag=false, startY=0, startV=0;
  function down(e){e.preventDefault(); drag=true; startY=(e.touches?e.touches[0].clientY:e.clientY); startV=getVal(); document.addEventListener('mousemove',move); document.addEventListener('mouseup',up);
    document.addEventListener('touchmove',move,{passive:false}); document.addEventListener('touchend',up,{passive:false});}
  function move(e){ if(!drag) return; e.preventDefault(); let y=(e.touches?e.touches[0].clientY:e.clientY); let v=Math.max(min,Math.min(max,Math.round(startV + (startY - y)))); setVal(v); if(disp) disp.textContent=v+units; if(ind) ind.style.transform='translateX(-50%) rotate('+((v-50)*scale)+'deg)'; }
  function up(){ drag=false; document.removeEventListener('mousemove',move); document.removeEventListener('mouseup',up); document.removeEventListener('touchmove',move); document.removeEventListener('touchend',up);}
  if(!el) return; el.addEventListener('mousedown',down); el.addEventListener('touchstart',down,{passive:false});
}

// === PHASE-LOCKED LOOPER CLASS – Now with robust stop/clear logic and per-looper volume!
class Looper {
  constructor(index, recordKey, stopKey) {
    this.index = index;
    this.mainBtn = document.getElementById('mainLooperBtn'+index);
    this.stopBtn = document.getElementById('stopBtn'+index);
    this.looperIcon = document.getElementById('looperIcon'+index);
    this.ledRing = document.getElementById('progressBar'+index);
    this.stateDisplay = document.getElementById('stateDisplay'+index);
    this.recordKey = recordKey;
    this.stopKey = stopKey;
    this.state = 'ready';
    this.mediaRecorder = null;
    this.chunks = [];
    this.loopBuffer = null;
    this.sourceNode = null;
    this.loopStartTime = 0;
    this.loopDuration = 0;
    this.overdubChunks = [];
    this.holdTimer = null;
    this.divider = 1;
    this.uiDisabled = false;

    // --- Per-looper volume (0–120%) ---
    this.gainNode = audioCtx.createGain();
    const volSlider = document.getElementById('volSlider'+index);
    const volValue = document.getElementById('volValue'+index);
    // Set initial value to 90%
    this.gainNode.gain.value = 0.9;
    if (volSlider && volValue) {
      volSlider.value = 90;
      volValue.textContent = '90%';
      volSlider.addEventListener('input', e => {
        const val = parseInt(volSlider.value, 10);
        this.gainNode.gain.value = val / 100;
        volValue.textContent = val + '%';
      });
    }

    this.updateUI();
    this.setRingProgress(0);
    if(index>=2 && dividerSelectors[index]){
      this.divider = parseFloat(dividerSelectors[index].value);
      dividerSelectors[index].addEventListener('change',e=>{ this.divider = parseFloat(e.target.value); });
      this.setDisabled(true);
    }

    // --- Robust STOP/CLEAR handler ---
    addHoldHandler(this.stopBtn,
      () => {
        if (this.state === 'ready') return;
        this.holdTimer = setTimeout(() => {
          this.clearLoop(); this.holdTimer = null;
        }, 2000);
      },
      () => {
        if (this.holdTimer) {
          clearTimeout(this.holdTimer);
          this.holdTimer = null;
          // Short press logic:
          if (this.state === 'playing' || this.state === 'overdub') {
            this.stopPlayback();
          } else if (this.state === 'stopped') {
            this.resumePlayback();
          } else if (this.state === 'recording') {
            this.abortRecording();
          }
        }
      }
    );

    // Main looper button tap handler (same as before)
    addTapHandler(this.mainBtn, async()=>{ await ensureMic(); await this.handleMainButton(); });
  }
  setLED(color){ const map={green:'#22c55e',red:'#e11d48',orange:'#f59e0b',gray:'#6b7280'}; this.ledRing.style.stroke = map[color]||'#fff'; this.ledRing.style.filter=(color==='gray'?'none':'drop-shadow(0 0 8px '+(map[color]+'88')+')'); }
  setRingProgress(r){ const R=42,C=2*Math.PI*R; this.ledRing.style.strokeDasharray=C; this.ledRing.style.strokeDashoffset=C*(1-r); }
  setIcon(s,c){ this.looperIcon.textContent=s; if(c) this.looperIcon.style.color=c; }
  setDisplay(txt){ this.stateDisplay.textContent=txt; }
  updateUI(){ switch(this.state){ case 'ready': this.setLED('green'); this.setRingProgress(0); this.setIcon('▶'); this.setDisplay('Ready'); break; case 'recording': this.setLED('red'); this.setIcon('⦿','#e11d48'); this.setDisplay('Recording...'); break; case 'playing': this.setLED('green'); this.setIcon('▶'); this.setDisplay('Playing'); break; case 'overdub': this.setLED('orange'); this.setIcon('⦿','#f59e0b'); this.setDisplay('Overdubbing'); break; case 'stopped': this.setLED('gray'); this.setRingProgress(0); this.setIcon('▶','#aaa'); this.setDisplay('Stopped'); break; case 'waiting': this.setLED('gray'); this.setRingProgress(0); this.setIcon('⏳','#aaa'); this.setDisplay('Waiting for sync...'); } if(this.uiDisabled){ this.mainBtn.disabled=true; this.stopBtn.disabled=true; this.mainBtn.classList.add('disabled-btn'); this.stopBtn.classList.add('disabled-btn'); this.setDisplay('WAIT: Set Track 1'); } else { this.mainBtn.disabled=false; this.stopBtn.disabled=false; this.mainBtn.classList.remove('disabled-btn'); this.stopBtn.classList.remove('disabled-btn'); } }
  setDisabled(v){ this.uiDisabled=v; this.updateUI(); }
  async handleMainButton(){ if(this.state==='ready'){ await this.phaseLockedRecording(); } else if(this.state==='recording'){ await this.stopRecordingAndPlay(); } else if(this.state==='playing'){ this.armOverdub(); } else if(this.state==='overdub'){ this.finishOverdub(); } }
  async phaseLockedRecording(){ if(!processedStream) await ensureMic(); if(this.index===1||!masterIsSet){ await this.startRecording(); return; } this.state='waiting'; this.updateUI(); this.setDisplay('Waiting for sync...'); const now=audioCtx.currentTime; const master=loopers[1]; const elapsed=(now-master.loopStartTime)%masterLoopDuration; const toNext=masterLoopDuration-elapsed; setTimeout(()=>{ this._startPhaseLockedRecording(masterLoopDuration*this.divider); }, toNext*1000); }
  async _startPhaseLockedRecording(len){ this.state='recording'; this.updateUI(); this.chunks=[]; this.mediaRecorder=new MediaRecorder(processedStream); this.mediaRecorder.ondataavailable=e=>{ if(e.data.size>0) this.chunks.push(e.data); }; this.mediaRecorder.start(); const start=Date.now(), self=this; (function recAnim(){ if(self.state==='recording'){ let pct=(Date.now()-start)/(len*1000); self.setRingProgress(Math.min(pct,1)); if(pct<1) requestAnimationFrame(recAnim); if(pct>=1) self.stopRecordingAndPlay(); } })(); setTimeout(()=>{ if(this.state==='recording') self.stopRecordingAndPlay(); }, len*1000); }
  async startRecording(){
    if(!processedStream) await ensureMic();
    if(this.index>=2&&!masterIsSet) return;
    this.state='recording'; this.updateUI(); this.chunks=[];
    this.mediaRecorder=new MediaRecorder(processedStream);
    this.mediaRecorder.ondataavailable=e=>{ if(e.data.size>0) this.chunks.push(e.data); };
    this.mediaRecorder.start();
    const start=Date.now(), self=this;
    let max = (this.index === 1) ? 60000 : (masterLoopDuration ? masterLoopDuration*this.divider*1000 : 12000); // MASTER capped at 1 min
    (function recAnim(){ if(self.state==='recording'){ let pct=(Date.now()-start)/max; self.setRingProgress(Math.min(pct,1)); if(pct<1) requestAnimationFrame(recAnim); if(pct>=1) self.stopRecordingAndPlay(); } })();
  }
  async stopRecordingAndPlay(){ if(!this.mediaRecorder) return; this.state='playing'; this.updateUI(); this.mediaRecorder.onstop=async()=>{ const blob=new Blob(this.chunks,{type:'audio/webm'}); const buf=await blob.arrayBuffer(); audioCtx.decodeAudioData(buf,buffer=>{ this.loopBuffer=buffer; this.loopDuration=buffer.duration; if(this.index===1){ masterLoopDuration=this.loopDuration; masterBPM=Math.round(60/this.loopDuration*4); masterIsSet=true; bpmLabel.textContent=`BPM: ${masterBPM}`; for(let k=2;k<=4;k++) loopers[k].setDisabled(false); } this.startPlayback(true); }); }; this.mediaRecorder.stop(); }
  abortRecording() {
    if (this.mediaRecorder && this.state === 'recording') {
      try { this.mediaRecorder.ondataavailable = null; this.mediaRecorder.stop(); } catch (e) {}
      this.mediaRecorder = null;
      this.chunks = [];
      this.state = 'ready';
      this.loopBuffer = null;
      this.loopDuration = 0;
      this.setRingProgress(0);
      this.updateUI();
    }
  }
  // === Robust Phase-Locked Playback ===
  startPlayback(reset) {
    if(!this.loopBuffer) return;
    if(this.sourceNode) { try{ this.sourceNode.stop(); }catch{} this.sourceNode.disconnect(); }
    this.sourceNode = audioCtx.createBufferSource();
    this.sourceNode.buffer = this.loopBuffer;
    this.sourceNode.loop = true;
    // Output: BufferSource → GainNode → Destination
    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(audioCtx.destination);
    let off = 0;
    if (
      this.index !== 1 &&
      masterIsSet &&
      loopers[1].sourceNode &&
      typeof loopers[1].loopStartTime === 'number' &&
      typeof masterLoopDuration === 'number' &&
      isFinite(masterLoopDuration) &&
      masterLoopDuration > 0
    ) {
      const master = loopers[1];
      const now = audioCtx.currentTime - master.loopStartTime;
      off = now % masterLoopDuration;
      if (isNaN(off) || off < 0 || off > this.loopBuffer.duration) off = 0;
    }
    if (isNaN(off) || off < 0 || off > this.loopBuffer.duration) off = 0;
    this.loopStartTime = audioCtx.currentTime - off;
    try {
      this.sourceNode.start(0, off);
    } catch (e) {
      try { this.sourceNode.start(0, 0); } catch (e2) {}
    }
    this.state = 'playing';
    this.updateUI();
    this.animateProgress();
  }
  resumePlayback() {
    if (this.index === 1) {
      this.startPlayback(true);
      for (let k = 2; k <= 4; ++k) {
        if (loopers[k].state === 'playing') {
          loopers[k].startPlayback(true);
        }
      }
    } else {
      this.startPlayback(true);
    }
  }
  stopPlayback() {
    if (this.sourceNode) { try { this.sourceNode.stop(); this.sourceNode.disconnect(); } catch (e) {} }
    this.state = 'stopped';
    this.updateUI();
  }
  armOverdub(){ if(this.state!=='playing') return; this.state='overdub'; this.updateUI(); const now=audioCtx.currentTime; const elapsed=(now-this.loopStartTime)%this.loopDuration; setTimeout(()=>{ this.startOverdubRecording(); }, (this.loopDuration-elapsed)*1000); }
  startOverdubRecording(){ this.overdubChunks=[]; this.mediaRecorder=new MediaRecorder(processedStream); this.mediaRecorder.ondataavailable=e=>{ if(e.data.size>0) this.overdubChunks.push(e.data); }; this.mediaRecorder.start(); setTimeout(()=>{ this.finishOverdub(); }, this.loopDuration*1000); }
  finishOverdub(){ if(this.mediaRecorder&&this.mediaRecorder.state==='recording'){ this.mediaRecorder.onstop=async()=>{ const od=new Blob(this.overdubChunks,{type:'audio/webm'}); const arr=await od.arrayBuffer(); audioCtx.decodeAudioData(arr,newBuf=>{ const orig=this.loopBuffer.getChannelData(0); const fresh=newBuf.getChannelData(0); const length=Math.max(orig.length,fresh.length); const out=audioCtx.createBuffer(1,length,this.loopBuffer.sampleRate); const data=out.getChannelData(0); for(let i=0;i<length;i++){ data[i]=(orig[i]||0)+(fresh[i]||0); } this.loopBuffer=out; this.loopDuration=out.duration; this.startPlayback(true); }); }; this.mediaRecorder.stop(); } else { this.state='playing'; this.updateUI(); } }
  clearLoop(){ if(this.sourceNode) { try{ this.sourceNode.stop(); this.sourceNode.disconnect(); }catch{} } this.loopBuffer=null; this.loopDuration=0; this.state='ready'; this.updateUI(); if(this.index===1){ masterLoopDuration=null; masterBPM=null; masterIsSet=false; bpmLabel.textContent='BPM: --'; for(let k=2;k<=4;k++) loopers[k].setDisabled(true); for(let k=2;k<=4;k++) loopers[k].clearLoop(); } }
  animateProgress(){ if(this.state==='playing'&&this.loopDuration>0&&this.sourceNode){ const now=audioCtx.currentTime; const pos=(now-this.loopStartTime)%this.loopDuration; this.setRingProgress(pos/this.loopDuration); requestAnimationFrame(this.animateProgress.bind(this)); } else this.setRingProgress(0); }
}

const keyMap = [ {rec:'w',stop:'s'}, {rec:'e',stop:'d'}, {rec:'r',stop:'f'}, {rec:'t',stop:'g'} ];
window.loopers = [];
for(let i=1;i<=4;i++) loopers[i] = new Looper(i,keyMap[i-1].rec,keyMap[i-1].stop);

document.addEventListener('keydown', e => {
  const key = e.key.toLowerCase();
  loopers.forEach((lp, idx) => {
    if(idx===0) return;
    if(key===keyMap[idx-1].rec) { lp.mainBtn.click(); e.preventDefault(); }
    if(key===keyMap[idx-1].stop) {
      if(lp.state==='playing'||lp.state==='overdub') lp.stopPlayback();
      else if(lp.state==='stopped') lp.resumePlayback();
      else if(lp.state==='recording') lp.abortRecording();
      e.preventDefault();
    }
  });
});

// --- FX knob handlers ---
addKnobDragHandler(
  document.getElementById('reverbKnob'),
  () => reverbLevel,
  val => {
    reverbLevel = Math.max(0, Math.min(100, Math.round(val)));
    dryGain.gain.value = (100 - reverbLevel)/100;
    wetGain.gain.value = reverbLevel/100;
  },
  document.getElementById('reverbValue'),
  document.getElementById('knobIndicator'),
  0,100,2.7,'%'
);
if(document.getElementById('knobIndicator'))
  document.getElementById('knobIndicator').style.transform = 'translateX(-50%) rotate(-135deg)';

addKnobDragHandler(
  document.getElementById('delayKnob'),
  () => Math.round(delayTime*1000),
  val => { delayTime = val/1000; if(delayNode) delayNode.delayTime.value = delayTime; },
  document.getElementById('delayValue'),
  document.getElementById('delayKnobIndicator'),
  0,1000,0.27,' ms'
);
if(document.getElementById('delayKnobIndicator'))
  document.getElementById('delayKnobIndicator').style.transform = 'translateX(-50%) rotate(-135deg)';

// --- LIVE MIC MONITOR BUTTON ---
const monitorBtn = document.getElementById('monitorBtn');
if(monitorBtn) {
  monitorBtn.addEventListener('click', () => {
    liveMicMonitoring = !liveMicMonitoring;
    liveMicMonitorGain.gain.value = liveMicMonitoring ? 1 : 0;
    monitorBtn.textContent = liveMicMonitoring ? 'Live MIC ON 🎤' : 'Live MIC OFF';
    monitorBtn.classList.toggle('active', liveMicMonitoring);
  });
  liveMicMonitorGain && (liveMicMonitorGain.gain.value = 0);
  monitorBtn.textContent = 'Live MIC OFF';
  monitorBtn.classList.remove('active');
}

// --- AUDIO UNLOCK ---
function resumeAudio() {
  if(audioCtx.state==='suspended') { audioCtx.resume(); hideMsg(); }
}
window.addEventListener('click', resumeAudio, { once:true });
window.addEventListener('touchstart', resumeAudio, { once:true });
if(audioCtx.state==='suspended') {
  showMsg("👆 Tap anywhere to start audio!", "#22ff88");
  showMsg("🎤 Tap 'Live MIC' to sing/play with FX over your loops (like a stage).", "#22ff88");
}
