window.addEventListener('DOMContentLoaded', function() {
  // ========== SELECTORS (IDs must match HTML) ==========
  const bpmLabel = document.getElementById('bpmLabel');
  const dividerSelectors = [
    null,
    null,
    document.getElementById('divider2'),
    document.getElementById('divider3'),
    document.getElementById('divider4'),
  ];

  // ========== AUDIO SETUP ==========
  let audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  let micStream = null, micSource = null, dryGain = null, wetGain = null, convolver = null, delayNode = null, delayGain = null, mixDest = null, processedStream = null;
  let reverbLevel = 0, delayTime = 0;
  let masterLoopDuration = null, masterBPM = null, masterIsSet = false;

  // ========== USER MESSAGES ==========
  function showMsg(msg, color = '#ff4444') {
    let el = document.getElementById('startMsg');
    if (!el) {
      el = document.createElement('div');
      el.id = 'startMsg';
      document.body.prepend(el);
    }
    el.innerHTML = msg;
    el.style.display = 'block';
    el.style.color = color;
    el.style.background = '#111a22cc';
    el.style.fontWeight = 'bold';
    el.style.borderRadius = '12px';
    el.style.padding = '12px 22px';
    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.top = '8%';
    el.style.transform = 'translate(-50%,0)';
    el.style.zIndex = 1000;
    el.style.textAlign = "center";
  }
  function hideMsg() {
    let el = document.getElementById('startMsg');
    if (el) el.style.display = 'none';
  }

  // ========== MIC PERMISSION (call only after tap) ==========
  async function ensureMic() {
    if (!micStream) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showMsg("❌ Microphone not supported on this device/browser!");
        throw new Error("getUserMedia not supported.");
      }
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        showMsg("❌ Microphone access denied!<br>Enable permission in app settings.", "#ff4444");
        throw e;
      }
      audioCtx.resume();
      micSource = audioCtx.createMediaStreamSource(micStream);
      // Delay node
      delayNode = audioCtx.createDelay(2.0);
      delayGain = audioCtx.createGain();
      delayNode.delayTime.value = 0;
      delayGain.gain.value = 0.5;
      // Reverb node
      convolver = audioCtx.createConvolver();
      convolver.buffer = createReverbImpulse(3.0, 2.0);
      convolver.normalize = true;
      dryGain = audioCtx.createGain();
      wetGain = audioCtx.createGain();
      dryGain.gain.value = 1;
      wetGain.gain.value = 0;
      // Routing: mic → [dry] + [delay→(feedback)→reverb] → mix → out
      micSource.connect(dryGain);
      micSource.connect(delayNode);
      delayNode.connect(delayGain);
      delayGain.connect(delayNode);
      delayNode.connect(convolver);
      convolver.connect(wetGain);
      mixDest = audioCtx.createMediaStreamDestination();
      dryGain.connect(mixDest);
      wetGain.connect(mixDest);
      processedStream = mixDest.stream;
      hideMsg();
    }
  }

  function createReverbImpulse(durationSeconds, decayFactor) {
    const sampleRate = audioCtx.sampleRate;
    const length = sampleRate * durationSeconds;
    const impulse = audioCtx.createBuffer(2, length, sampleRate);
    for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
      const buffer = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        buffer[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decayFactor);
      }
    }
    return impulse;
  }

  // ========== UNIVERSAL TAP/DRAG HELPERS ==========
  function addTapHandler(btn, handler) {
    if (!btn) return;
    btn.addEventListener('click', handler);
    btn.addEventListener('touchstart', function(e) {
      e.preventDefault(); handler(e);
    }, { passive: false });
  }
  function addHoldHandler(btn, onStart, onEnd) {
    let hold = false;
    btn.addEventListener('mousedown', function(e) { hold = true; onStart(e); });
    btn.addEventListener('touchstart', function(e) { hold = true; onStart(e); }, { passive: false });
    btn.addEventListener('mouseup', function(e) { if (hold) onEnd(e); hold = false; });
    btn.addEventListener('mouseleave', function(e) { if (hold) onEnd(e); hold = false; });
    btn.addEventListener('touchend', function(e) { if (hold) onEnd(e); hold = false; }, { passive: false });
    btn.addEventListener('touchcancel', function(e) { if (hold) onEnd(e); hold = false; }, { passive: false });
  }
  function addKnobDragHandler(knobElem, getValue, setValue, display, indicator, min=0, max=100, angleScale=2.7, units='%') {
    let dragging = false, startY = 0, startValue = 0;
    function dragStart(e) {
      e.preventDefault();
      dragging = true;
      startY = e.touches ? e.touches[0].clientY : e.clientY;
      startValue = getValue();
      document.addEventListener('mousemove', dragMove);
      document.addEventListener('mouseup', dragEnd);
      document.addEventListener('touchmove', dragMove, { passive: false });
      document.addEventListener('touchend', dragEnd, { passive: false });
    }
    function dragMove(e) {
      if (!dragging) return;
      e.preventDefault();
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      let newVal = Math.max(min, Math.min(max, Math.round(startValue + (startY - clientY))));
      setValue(newVal);
      if (display) display.textContent = newVal + units;
      if (indicator) indicator.style.transform = 'translateX(-50%) rotate(' + ((newVal - 50) * angleScale) + 'deg)';
    }
    function dragEnd(e) {
      dragging = false;
      document.removeEventListener('mousemove', dragMove);
      document.removeEventListener('mouseup', dragEnd);
      document.removeEventListener('touchmove', dragMove);
      document.removeEventListener('touchend', dragEnd);
    }
    if (!knobElem) return;
    knobElem.addEventListener('mousedown', dragStart);
    knobElem.addEventListener('touchstart', dragStart, { passive: false });
  }

  // ========== LOOPER CLASS ==========
  class Looper {
    constructor(index, recordKey, stopKey) {
      this.index = index;
      this.mainBtn = document.getElementById('mainLooperBtn' + index);
      this.stopBtn = document.getElementById('stopBtn' + index);
      this.looperIcon = document.getElementById('looperIcon' + index);
      this.ledRing = document.getElementById('progressBar' + index);
      this.stateDisplay = document.getElementById('stateDisplay' + index);
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
      this.updateUI();
      this.setRingProgress(0);

      if (index >= 2 && dividerSelectors[index]) {
        this.divider = parseFloat(dividerSelectors[index].value);
        dividerSelectors[index].addEventListener('change', e => {
          this.divider = parseFloat(e.target.value);
        });
        this.setDisabled(true);
      }

      // --- Microphone must be set up on first tap! ---
      addTapHandler(this.mainBtn, async () => {
        await ensureMic();
        await this.handleMainButton();
      });
      addHoldHandler(this.stopBtn, () => {
        if (this.state === 'ready') return;
        this.holdTimer = setTimeout(() => {
          this.clearLoop();
          this.holdTimer = null;
        }, 2000);
      }, () => {
        if (this.holdTimer) {
          clearTimeout(this.holdTimer);
          this.holdTimer = null;
          if (this.state === 'playing' || this.state === 'overdub') {
            this.stopPlayback();
          } else if (this.state === 'stopped') {
            this.resumePlayback();
          }
        }
      });
    }
    setLED(color) {
      const colors = { green: '#22c55e', red: '#e11d48', orange: '#f59e0b', gray: '#6b7280' };
      this.ledRing.style.stroke = colors[color] || '#fff';
      this.ledRing.style.filter = (color === 'gray') ? 'none' : 'drop-shadow(0 0 8px ' + (colors[color] + '88') + ')';
    }
    setRingProgress(ratio) {
      const RADIUS = 42, CIRCUM = 2 * Math.PI * RADIUS;
      const offset = CIRCUM * (1 - ratio);
      this.ledRing.style.strokeDasharray = CIRCUM;
      this.ledRing.style.strokeDashoffset = offset;
    }
    setIcon(symbol, color) {
      this.looperIcon.textContent = symbol;
      this.looperIcon.style.color = color ? color : '#fff';
    }
    setDisplay(text) { this.stateDisplay.textContent = text; }
    updateUI() {
      switch (this.state) {
        case 'ready': this.setLED('green'); this.setRingProgress(0); this.setIcon('▶'); this.setDisplay('Ready'); break;
        case 'recording': this.setLED('red'); this.setIcon('⦿', '#e11d48'); this.setDisplay('Recording...'); break;
        case 'playing': this.setLED('green'); this.setIcon('▶'); this.setDisplay('Playing'); break;
        case 'overdub': this.setLED('orange'); this.setIcon('⦿', '#f59e0b'); this.setDisplay('Overdubbing'); break;
        case 'stopped': this.setLED('gray'); this.setRingProgress(0); this.setIcon('▶', '#aaa'); this.setDisplay('Stopped'); break;
      }
      if (this.uiDisabled) {
        this.mainBtn.disabled = true; this.stopBtn.disabled = true;
        this.mainBtn.classList.add('disabled-btn'); this.stopBtn.classList.add('disabled-btn');
        this.setDisplay('WAIT: Set Track 1');
      } else {
        this.mainBtn.disabled = false; this.stopBtn.disabled = false;
        this.mainBtn.classList.remove('disabled-btn'); this.stopBtn.classList.remove('disabled-btn');
      }
    }
    setDisabled(val) { this.uiDisabled = val; this.updateUI(); }
    async handleMainButton() {
      if (this.state === 'ready') { await this.startRecording(); }
      else if (this.state === 'recording') { await this.stopRecordingAndPlay(); }
      else if (this.state === 'playing') { this.armOverdub(); }
      else if (this.state === 'overdub') { this.finishOverdub(); }
    }
    async startRecording() {
      if (!processedStream) await ensureMic();
      if (this.index >= 2 && !masterIsSet) return;
      this.state = 'recording'; this.updateUI(); this.chunks = [];
      this.mediaRecorder = new MediaRecorder(processedStream);
      this.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this.chunks.push(e.data); };
      this.mediaRecorder.onstop = () => { };
      this.mediaRecorder.start();
      const startTime = Date.now();
      let recMax = 12000;
      if (this.index >= 2 && masterLoopDuration) { recMax = masterLoopDuration * this.divider * 1000; }
      let self = this;
      function animateRec() {
        if (self.state === 'recording') {
          let elapsed = (Date.now() - startTime) / recMax;
          self.setRingProgress(Math.min(elapsed, 1));
          if (elapsed < 1) requestAnimationFrame(animateRec);
          if (elapsed >= 1) { self.stopRecordingAndPlay(); }
        }
      }
      animateRec();
    }
    async stopRecordingAndPlay() {
      if (!this.mediaRecorder) return;
      this.state = 'playing'; this.updateUI();
      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.chunks, { type: 'audio/webm' });
        const arrayBuf = await blob.arrayBuffer();
        audioCtx.decodeAudioData(arrayBuf, (buffer) => {
          this.loopBuffer = buffer;
          this.loopDuration = buffer.duration;
          if (this.index === 1) {
            masterLoopDuration = this.loopDuration;
            masterBPM = Math.round(60 / masterLoopDuration * 4); // Assume 4/4 bar
            masterIsSet = true;
            bpmLabel.textContent = `BPM: ${masterBPM}`;
            for (let k = 2; k <= 4; ++k) loopers[k].setDisabled(false);
          }
          this.startPlayback(true);
        });
      };
      this.mediaRecorder.stop();
    }
    startPlayback(resetPhase) {
      if (!this.loopBuffer) return;
      if (this.sourceNode) { try { this.sourceNode.stop(); } catch (e) {} }
      this.sourceNode = audioCtx.createBufferSource();
      this.sourceNode.buffer = this.loopBuffer;
      this.sourceNode.loop = true;
      this.sourceNode.connect(audioCtx.destination);
      let offset = 0;
      if (this.index !== 1 && masterIsSet && loopers[1].sourceNode) {
        const masterNow = audioCtx.currentTime - loopers[1].loopStartTime;
        offset = masterNow % masterLoopDuration;
        if (offset < 0) offset = 0;
      }
      this.loopStartTime = audioCtx.currentTime - offset;
      this.sourceNode.start(0, offset);
      this.state = 'playing';
      this.updateUI();
      this.animateProgress();
    }
    stopPlayback() {
      if (this.sourceNode) { try { this.sourceNode.stop(); } catch (e) {} }
      this.state = 'stopped'; this.updateUI();
    }
    resumePlayback() { this.startPlayback(); }
    armOverdub() {
      if (this.state !== 'playing') return;
      this.state = 'overdub'; this.updateUI();
      const now = audioCtx.currentTime;
      const elapsed = (now - this.loopStartTime) % this.loopDuration;
      setTimeout(() => { this.startOverdubRecording(); }, (this.loopDuration - elapsed) * 1000);
    }
    startOverdubRecording() {
      this.overdubChunks = [];
      this.mediaRecorder = new MediaRecorder(processedStream);
      this.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this.overdubChunks.push(e.data); };
      this.mediaRecorder.start();
      setTimeout(() => { this.finishOverdub(); }, this.loopDuration * 1000);
    }
    finishOverdub() {
      if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
        this.mediaRecorder.onstop = async () => {
          const odBlob = new Blob(this.overdubChunks, { type: 'audio/webm' });
          const origBuf = this.loopBuffer;
          const arrBuf = await odBlob.arrayBuffer();
          audioCtx.decodeAudioData(arrBuf, (newBuf) => {
            const origChan = origBuf.numberOfChannels > 0 ? origBuf.getChannelData(0) : null;
            const newChan = newBuf.getChannelData(0);
            const outLength = Math.max(origBuf.length, newBuf.length);
            const outBuf = audioCtx.createBuffer(1, outLength, origBuf.sampleRate);
            const outData = outBuf.getChannelData(0);
            for (let i = 0; i < outLength; i++) {
              const origSample = origChan ? origChan[i] : 0;
              const newSample = newChan[i] || 0;
              outData[i] = origSample + newSample;
            }
            this.loopBuffer = outBuf;
            this.loopDuration = outBuf.duration;
            this.startPlayback(true);
          });
        };
        this.mediaRecorder.stop();
      } else {
        this.state = 'playing'; this.updateUI();
      }
    }
    clearLoop() {
      if (this.sourceNode) { try { this.sourceNode.stop(); } catch (e) {} }
      this.loopBuffer = null; this.loopDuration = 0; this.state = 'ready'; this.updateUI();
      if (this.index === 1) {
        masterLoopDuration = null; masterBPM = null; masterIsSet = false;
        bpmLabel.textContent = `BPM: --`;
        for (let k = 2; k <= 4; ++k) loopers[k].setDisabled(true);
        for (let k = 2; k <= 4; ++k) loopers[k].clearLoop();
      }
    }
    animateProgress() {
      if (this.state === 'playing' && this.loopDuration > 0 && this.sourceNode) {
        const now = audioCtx.currentTime;
        const position = (now - this.loopStartTime) % this.loopDuration;
        this.setRingProgress(position / this.loopDuration);
        requestAnimationFrame(this.animateProgress.bind(this));
      } else {
        this.setRingProgress(0);
      }
    }
  }

  // ========== INITIALIZE LOOPERS ==========
  const keyMap = [
    { rec: 'w', stop: 's' },
    { rec: 'e', stop: 'd' },
    { rec: 'r', stop: 'f' },
    { rec: 't', stop: 'g' }
  ];
  window.loopers = [];
  for (let i = 1; i <= 4; i++) {
    loopers[i] = new Looper(i, keyMap[i - 1].rec, keyMap[i - 1].stop);
  }

  // ========== GLOBAL KEYBOARD SHORTCUTS ==========
  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    for (let i = 1; i <= 4; i++) {
      if (key === keyMap[i - 1].rec) {
        loopers[i].mainBtn.click();
        e.preventDefault();
      }
      if (key === keyMap[i - 1].stop) {
        if (loopers[i].state === 'playing' || loopers[i].state === 'overdub') {
          loopers[i].stopPlayback();
        } else if (loopers[i].state === 'stopped') {
          loopers[i].resumePlayback();
        }
        e.preventDefault();
      }
    }
  });

  // ========== REVERB KNOB ==========
  const reverbKnob = document.getElementById('reverbKnob');
  const knobIndicator = document.getElementById('knobIndicator');
  const reverbValueDisplay = document.getElementById('reverbValue');
  addKnobDragHandler(
    reverbKnob,
    () => reverbLevel,
    (val) => {
      reverbLevel = Math.max(0, Math.min(100, Math.round(val)));
      if (dryGain && wetGain) {
        dryGain.gain.value = (100 - reverbLevel) / 100;
        wetGain.gain.value = reverbLevel / 100;
      }
    },
    reverbValueDisplay, knobIndicator, 0, 100, 2.7, '%'
  );
  if (knobIndicator) knobIndicator.style.transform = 'translateX(-50%) rotate(-135deg)';

  // ========== DELAY KNOB ==========
  const delayKnob = document.getElementById('delayKnob');
  const delayKnobIndicator = document.getElementById('delayKnobIndicator');
  const delayValueDisplay = document.getElementById('delayValue');
  let delayMaxMs = 1000; // 0-1000 ms (1s)
  addKnobDragHandler(
    delayKnob,
    () => Math.round(delayTime * 1000),
    (val) => {
      let newVal = Math.max(0, Math.min(delayMaxMs, Math.round(val)));
      delayTime = newVal / 1000;
      if (delayNode) delayNode.delayTime.value = delayTime;
    },
    delayValueDisplay, delayKnobIndicator, 0, delayMaxMs, 0.27, ' ms'
  );
  if (delayKnobIndicator) delayKnobIndicator.style.transform = 'translateX(-50%) rotate(-135deg)';

  // ========== AUDIOCONTEXT RESUME ==========
  function resumeAudio() {
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
      hideMsg();
    }
  }
  window.addEventListener('click', resumeAudio, { once: true });
  window.addEventListener('touchstart', resumeAudio, { once: true });
  if (audioCtx.state === 'suspended') {
    showMsg("👆 Tap anywhere to start audio!", "#22ff88");
  }
});
