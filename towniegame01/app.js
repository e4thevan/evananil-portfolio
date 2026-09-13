import { ROUND_SECONDS, TYPES, clamp, createRound, updateRound, duckGeometry, takePhoto, cameraVector, angleBetween } from './engine.js?v=2';

const $ = id => document.getElementById(id);
const app = $('app'), video = $('camera'), canvas = $('game');
const ctx = canvas.getContext('2d', { alpha: true });
const screens = [...document.querySelectorAll('.screen')];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
let state = 'landing', stream = null, cameraRequest = 0, practice = false, round = null;
let shore = .39, near = .84, width = 1, height = 1, raf = 0, previousFrame = 0;
let countdownLeft = 3, lastCount = -1, effects = [], messageUntil = 0, lastShot = -1000;
let portraitAllowed = false, imageReady = false, imagesPromise;
let audio, noise, soundOn = true, wake = null, cameraStalledAt = 0, lastVideoTime = -1;
let orientation = null, orientationAt = 0, baseline = null, driftStart = 0, motionEnabled = false;
const images = {}, pond = new Image();
const duckButtons = new Map();
pond.decoding = 'async';
pond.onload=()=>{if(practice)$('modeLabel').textContent='PRACTICE · KENNY’S POND PHOTO';};
pond.onerror=()=>{if(practice)$('modeLabel').textContent='PRACTICE · CAMERA OFF';};

function show(next) {
  state = next; app.dataset.state = next;
  screens.forEach(s => { const active = s.id === next; s.hidden = !active; s.classList.toggle('active', active); });
  $('hud').hidden = next !== 'playing';
  $('duckTargets').hidden = next !== 'playing';
  $('liveBadge').hidden = !['align','countdown','playing'].includes(next);
  $('modeLabel').textContent = practice ? (pond.complete&&pond.naturalWidth?'PRACTICE · KENNY’S POND PHOTO':'PRACTICE · CAMERA OFF') : 'LIVE AT KENNY’S POND';
  if (!['align','countdown','playing'].includes(next)) { ctx.clearRect(0,0,width,height); releaseWake(); }
  previousFrame = performance.now();
  if (['align','countdown','playing'].includes(next)) startLoop();
}
function refreshSize() {
  const oldLandscape = width > height;
  const box = app.getBoundingClientRect(); width = box.width; height = box.height;
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  if (oldLandscape !== (width > height) && ['playing','countdown'].includes(state)) {
    pause('Your view changed.', 'Point at the pond and match the far shore again. Your round is paused.');
  } else if (state === 'rotate' && width > height) enterAlignment();
}
addEventListener('resize', refreshSize);
window.visualViewport?.addEventListener('resize', refreshSize);
refreshSize();

function loadImages() {
  if (imageReady) return Promise.resolve();
  if (imagesPromise) return imagesPromise;
  imagesPromise = Promise.all(['mint','fast','diver','golden'].map(name => new Promise((resolve,reject) => {
    const img = new Image(); img.decoding='async';
    img.onload=()=>{images[name]=img;resolve();}; img.onerror=()=>reject(new Error('art'));
    img.src = new URL('assets/'+name+'.webp', import.meta.url).href;
  }))).then(()=>{imageReady=true;}).catch(e=>{imagesPromise=null;throw e;});
  return imagesPromise;
}
loadImages().catch(()=>{}); // Small sprites prewarm while the start screen is visible.

function stopCamera() {
  cameraRequest++;
  const old = stream; stream=null;
  old?.getTracks().forEach(t=>t.stop());
  video.pause(); video.srcObject=null; app.dataset.camera='false';
  lastVideoTime=-1; cameraStalledAt=0;
}
function streamAlive() { return !!stream?.getVideoTracks().some(t=>t.readyState==='live' && !t.muted); }
function timeout(promise, ms, name) {
  let handle;
  return Promise.race([promise, new Promise((_,reject)=>{handle=setTimeout(()=>reject(Object.assign(new Error(name),{name})),ms);})]).finally(()=>clearTimeout(handle));
}
function displayError(error) {
  const name=error?.name;
  const details = {
    Insecure: ['Open the secure game link.', 'Camera play needs a secure connection. Open https://evananil.com/towniegame01/ in Safari or Chrome.'],
    NotAllowedError: ['Camera access is off.', 'Allow this site to use your camera in Safari or Chrome’s site settings, then try again. Practice works without a camera.'],
    NotFoundError: ['No camera found.', 'Open this game on a phone with a rear camera. You can try practice here.'],
    NotReadableError: ['Your camera is busy.', 'Close any other app using the camera, then try again.'],
    CameraTimeout: ['Still waiting for the camera.', 'Check for a camera permission prompt. If this is a QR scanner or social app, open the link in Safari or Chrome and try again.'],
    PlaybackTimeout: ['The camera isn’t playing.', 'Open this link directly in Safari or Chrome, then try again.'],
    Unsupported: ['Open in Safari or Chrome.', 'This browser cannot open the camera. Copy the game link into your phone’s main browser, or try practice.']
  };
  const text=error?.message==='art' ? ['The ducks didn’t finish loading.', 'Check your connection and try again.'] : details[name] || ['We couldn’t open your camera.', 'Try again in your phone’s Safari or Chrome browser. Practice is also available.'];
  $('errorTitle').textContent=text[0]; $('errorText').textContent=text[1]; show('error');
}
async function openCamera() {
  stopCamera();
  const token=cameraRequest;
  if (!window.isSecureContext) throw Object.assign(new Error(),{name:'Insecure'});
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(),{name:'Unsupported'});
  const request=navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720},frameRate:{ideal:30,max:30}}});
  request.then(s=>{if(token!==cameraRequest)s.getTracks().forEach(t=>t.stop());},()=>{});
  const acquired=await timeout(request,20000,'CameraTimeout');
  if (token!==cameraRequest) { acquired.getTracks().forEach(t=>t.stop()); return false; }
  stream=acquired; video.srcObject=acquired; video.muted=true;
  await timeout(video.play(),10000,'PlaybackTimeout');
  if (token!==cameraRequest) return false;
  app.dataset.camera='true';
  const track=acquired.getVideoTracks()[0];
  track.addEventListener('ended',()=>{if(stream===acquired)cameraInterrupted();});
  track.addEventListener('mute',()=>{if(stream===acquired && ['playing','countdown'].includes(state))cameraInterrupted();});
  return true;
}
function cameraInterrupted() { pause('The camera was interrupted.', 'Your score is safe. Reopen the camera, then point back at the pond.'); stopCamera(); }
async function begin(usePractice, resume=false) {
  if(state==='loading') return;
  practice=usePractice;
  if(!resume){round=null;effects=[];portraitAllowed=false;for(const b of duckButtons.values())b.remove();duckButtons.clear();}
  unlockAudio(); show('loading');
  try {
    if (practice) {
      stopCamera();
      pond.src ||= new URL('assets/kenny-pond.webp',import.meta.url).href;
      await loadImages();
      if(state!=='loading')return;
    } else {
      const token = cameraRequest+1;
      const [opened] = await Promise.all([openCamera(), loadImages()]);
      if (!opened || token!==cameraRequest || state!=='loading') return;
    }
    if(width<=height && !portraitAllowed) show('rotate'); else enterAlignment();
  } catch(e) { if(state!=='loading')return; stopCamera();displayError(e); }
}
function enterAlignment() {
  $('readyButton').innerHTML=round ? 'Resume round <span>→</span>' : 'Ready · 30 seconds <span>→</span>';
  $('alignEyebrow').textContent=round?'TIME & SCORE ARE SAFE':'ONE QUICK ALIGNMENT';
  $('alignTitle').textContent=round?'Point back toward the pond.':'Find the far shore.';
  $('motionButton').hidden=practice || !window.DeviceOrientationEvent || motionEnabled;
  $('motionNote').textContent=practice?'Practice uses a photo. Camera play uses your pond.':motionEnabled?'Turn reminder on. Keep your phone steady.':'Optional motion check. Realign anytime.';
  show('align');
}
function ready() {
  if(state!=='align' || !imageReady)return;
  if(!practice && !streamAlive()){begin(false,true);return;}
  unlockAudio(); requestImmersive(); requestWake();
  if(!round)round=createRound();
  effects=[]; countdownLeft=3;lastCount=-1;
  baseline=motionEnabled && performance.now()-orientationAt<2000 ? orientation : null;
  driftStart=0;lastShot=-1000;
  show('countdown');
}
function pause(title='Point back toward the pond.', text='Stay at your bench. Match the shoreline again when you’re ready.') {
  if(!['playing','countdown','align','rotate'].includes(state))return;
  $('pauseTitle').textContent=title; $('pauseText').textContent=text;
  $('endButton').textContent=round?'Finish this round':'Back to start';
  show('paused');
}
async function resume() {
  if(practice || streamAlive()) enterAlignment(); else await begin(false,true);
}
function home() {
  stopCamera();round=null;effects=[];baseline=null;for(const b of duckButtons.values())b.remove();duckButtons.clear();
  show('landing');
  if(document.fullscreenElement)document.exitFullscreen?.().catch(()=>{});
}
function finish(early=false) {
  if(!round){home();return;}
  stopCamera();
  $('finalScore').textContent=round.score.toLocaleString();
  $('finalPhotos').textContent=round.photos;
  $('finalCombo').textContent=round.photos ? round.bestMultiplier+'×' : '0×';
  $('accuracy').textContent=(round.shots?Math.round(round.photos/round.shots*100):0)+'%';
  $('rank').textContent=round.score>=5000?'Kenny’s Pond has a new head photographer.':round.score>=2000?'You have an eye for the rare ones.':round.photos?'A fine collection of curious locals.':'The ducks are ready for a second take.';
  $('resultMode').textContent=practice?'PRACTICE COMPLETE':early?'SAFARI FINISHED':'THAT’S A WRAP · 30 SECONDS';
  $('resultDuck').src=round.golden?'assets/golden.webp':'assets/mint.webp';
  $('goldenResult').textContent=round.golden?'THE GOLDEN SHOT · CAPTURED':'KENNY’S POND · PHOTO FINISH';
  try {
    const key=practice?'townie-practice-best-v1':'townie-kenny-best-v1';
    const best=Math.max(0, Number(localStorage.getItem(key)) || 0);
    $('personalBest').textContent=round.score>best?'NEW PERSONAL BEST · ON THIS PHONE':'BEST ON THIS PHONE · '+Math.max(best,round.score).toLocaleString();
    if(round.score>best)localStorage.setItem(key,String(round.score));
  } catch { $('personalBest').textContent='Great photos. No account needed.'; }
  show('results');tone(660,.18,.055);
}
function startLoop() { if(!raf) {previousFrame=performance.now();raf=requestAnimationFrame(frame);} }
function frame(now) {
  raf=0;
  if(document.hidden || !['align','countdown','playing'].includes(state))return;
  const elapsed=(now-previousFrame)/1000;previousFrame=now;
  if(elapsed>3 && ['countdown','playing'].includes(state)){pause('Let’s get your view back.', 'The game paused while your phone was busy. Realign to continue.');return;}
  const dt=elapsed;
  if(state==='countdown') {
    countdownLeft-=dt; const count=Math.max(1,Math.ceil(countdownLeft));
    if(count!==lastCount){lastCount=count;$('countNumber').textContent=count;tone(350+count*90,.07,.035);}
    if(countdownLeft<=0){show('playing');cameraStalledAt=now;announce(practice?'PRACTICE · TAP THE FICTIONAL DUCKS':'TAP A DUCK TO TAKE ITS PHOTO',2);tone(880,.13,.06);}
  } else if(state==='playing') {
    if(!practice) {
      if(video.currentTime!==lastVideoTime){lastVideoTime=video.currentTime;cameraStalledAt=now;}
      else if(now-cameraStalledAt>2200){cameraInterrupted();return;}
    }
    if(baseline && orientation && now-orientationAt<1500 && !practice) {
      if(angleBetween(baseline,orientation)>28){driftStart ||= now; if(now-driftStart>550){pause();return;}}else driftStart=0;
    }
    // Preserve elapsed time at low frame rates without making movement jump.
    for(let remaining=dt;remaining>0;remaining-=1/30)updateRound(round,Math.min(1/30,remaining));
    for(const e of round.events.splice(0)) {
      if(e.kind==='golden'){announce('GOLDEN DUCK · 1,000 PTS',2.5);tone(880,.15,.05);tone(1320,.25,.04,.14);}
      else if(e.duck){const p=duckGeometry(e.duck,width,height,shore,near);effects.push({kind:'splash',x:p.x/width,y:p.y/height,t:0,size:p.width});}
    }
    updateHud();
    if(round.time>=ROUND_SECONDS){finish();return;}
  }
  effects.forEach(e=>e.t+=dt);effects=effects.filter(e=>e.t<1);
  if(now>messageUntil)$('feedback').classList.remove('show');
  render(now);
  if(!raf)raf=requestAnimationFrame(frame);
}
function updateHud() {
  $('score').textContent=round.score.toLocaleString();
  const remaining=Math.max(0,Math.ceil(ROUND_SECONDS-round.time));
  if($('timer').dataset.remaining!==String(remaining)){$('timer').dataset.remaining=remaining;$('timer').innerHTML=remaining+'<span>s</span>';}
  $('timeFill').style.transform='scaleX('+((ROUND_SECONDS-round.time)/ROUND_SECONDS)+')';
  $('phase').textContent=(practice?'PRACTICE · ':'')+(round.time<5?'MEET THE LOCALS':round.time<15?'SMALL DUCKS · BIG POINTS':round.time<24?'DIVE & DASH':'GOLDEN HOUR');
}
function announce(text,seconds=.9) { $('feedback').textContent=text;$('feedback').classList.add('show');messageUntil=performance.now()+seconds*1000; }

function practiceBackground() {
  ctx.fillStyle='#23474e';ctx.fillRect(0,0,width,height);
  if(pond.complete && pond.naturalWidth) {
    const scale=Math.max(width/pond.naturalWidth,height/pond.naturalHeight);
    const dw=pond.naturalWidth*scale,dh=pond.naturalHeight*scale;
    const y=clamp(height*.39-dh*.40,height-dh,0);
    ctx.drawImage(pond,(width-dw)/2,y,dw,dh);
    ctx.fillStyle='#10282e14';ctx.fillRect(0,0,width,height);
  } else {
    const g=ctx.createLinearGradient(0,0,0,height);g.addColorStop(0,'#839caa');g.addColorStop(.39,'#365f63');g.addColorStop(.4,'#244e57');g.addColorStop(1,'#102e3b');ctx.fillStyle=g;ctx.fillRect(0,0,width,height);
  }
}
function render(now) {
  ctx.clearRect(0,0,width,height);
  if(practice)practiceBackground();
  if(state==='align') {
    const far=shore*height,bottom=near*height;
    ctx.fillStyle='rgba(190,249,196,.075)';ctx.beginPath();ctx.moveTo(width*.2,far);ctx.lineTo(width*.8,far);ctx.lineTo(width*.94,bottom);ctx.lineTo(width*.06,bottom);ctx.closePath();ctx.fill();
    const examples=[{type:'tiny',depth:.12,x:.2,direction:1,phase:0,age:2,captured:-1},{type:'mint',depth:.7,x:.76,direction:-1,phase:1,age:2,captured:-1}];
    examples.forEach(d=>drawDuck(d,now,true));
  } else if(round) [...round.ducks].sort((a,b)=>a.depth-b.depth).forEach(d=>drawDuck(d,now,false));
  if(state==='playing') syncDuckTargets();
  effects.forEach(drawEffect);
}
function syncDuckTargets() {
  const available=round.ducks.filter(d=>!d.submerged && d.captured<0 && d.age>=.15);
  const labels={mint:'Mint duck',tiny:'Tiny duck',fast:'Speedy duck',diver:'Diving duck',golden:'Golden duck'};
  for(const [id,button] of duckButtons)if(!available.some(d=>d.id===id)){button.remove();duckButtons.delete(id);}
  for(const d of available) {
    let button=duckButtons.get(d.id);
    if(!button){
      button=document.createElement('button');button.className='duck-target';
      button.onpointerdown=e=>{if(e.isPrimary && e.button===0){e.preventDefault();shoot(e.clientX,e.clientY);}};
      button.onclick=e=>{if(e.detail===0){const pos=duckGeometry(d,width,height,shore,near);shoot(pos.x,pos.targetY);}};
      $('duckTargets').append(button);duckButtons.set(d.id,button);
    }
    const p=duckGeometry(d,width,height,shore,near);
    button.setAttribute('aria-label','Photograph '+labels[d.type]+', '+(d.type==='diver'&&d.resurfaced?400:TYPES[d.type].points)+' base points');
    Object.assign(button.style,{left:p.x+'px',top:p.targetY+'px',width:Math.max(50,p.width*1.04)+'px',height:Math.max(50,p.height)+'px',zIndex:String(Math.round(d.depth*100))});
  }
}
function ellipse(x,y,rx,ry,color,line=1) {
  ctx.strokeStyle=color;ctx.lineWidth=line;ctx.beginPath();ctx.ellipse(x,y,Math.max(.1,rx),Math.max(.1,ry),0,0,Math.PI*2);ctx.stroke();
}
function drawDuck(d,now,guide=false) {
  const p=duckGeometry(d,width,height,shore,near),img=images[TYPES[d.type].image];if(!img)return;
  const bob=reduced?0:Math.sin(now*.004+d.phase)*1.4;
  const entering=clamp(d.age/.35,0,1),leaving=d.captured<0?1:clamp(1-d.captured/.75,0,1);
  const expiry=d.captured>=0?1:clamp((8-d.age)/.55,0,1);
  const alpha=entering*leaving*expiry*(guide?.65:1);
  ctx.save();ctx.globalAlpha=alpha;
  // Every layer is clipped to the calibrated band, including wakes and reflections.
  ctx.beginPath();ctx.rect(0,shore*height,width,(near-shore)*height);ctx.clip();
  for(let i=0;i<3;i++){const wave=((now/1500+d.phase+i/3)%1);ellipse(p.x-d.direction*(i+1)*p.width*.15,p.y+1,p.width*(.35+wave*.25),2+wave*4,'rgba(221,255,246,'+(.55*(1-wave))+')',1.1);}
  if(d.submerged) {
    for(let i=0;i<4;i++){const rise=(now*.0018+i*.24)%1;ellipse(p.x-i*d.direction*7,p.y-rise*12,2+rise*2,2+rise*2,'#dcfff3',1.1);}
    ctx.restore();return;
  }
  if(d.type==='golden') {
    const glow=ctx.createRadialGradient(p.x,p.targetY,4,p.x,p.targetY,p.width*.8);glow.addColorStop(0,'#fff4a844');glow.addColorStop(1,'#ffdb4400');ctx.fillStyle=glow;ctx.fillRect(p.x-p.width,p.y-p.width*1.4,p.width*2,p.width*1.7);
    for(let i=0;i<4;i++){const t=now*.001+i*1.6;const x=p.x+Math.cos(t)*p.width*.65,y=p.targetY+Math.sin(t)*p.height*.58;ctx.fillStyle='#fff3a0';ctx.fillRect(x-2,y-4,4,8);ctx.fillRect(x-4,y-2,8,4);}
  }
  ctx.save();ctx.translate(p.x,p.y+3);ctx.scale(d.direction,-.22);ctx.globalAlpha=alpha*.12;ctx.drawImage(img,-p.width/2,-p.height,p.width,p.height);ctx.restore();
  ctx.save();ctx.translate(p.x,p.y+bob);ctx.scale(d.direction,1);
  if(d.captured>=0)ctx.rotate(-.07*Math.sin(d.captured*12));
  ctx.shadowColor='rgba(2,26,32,.8)';ctx.shadowBlur=2;ctx.shadowOffsetY=1;
  ctx.drawImage(img,-p.width/2,-p.height*entering,p.width,p.height);
  ctx.restore();
  if(d.type==='diver' && d.resurfaced && d.captured<0){ctx.fillStyle='#edffd4';ctx.font='bold 10px Arial';ctx.textAlign='center';ctx.strokeStyle='#10282e';ctx.lineWidth=3;ctx.strokeText('+400',p.x,p.y-p.height-5);ctx.fillText('+400',p.x,p.y-p.height-5);}
  ctx.restore();
}
function drawEffect(e) {
  const x=e.x*width,y=e.y*height,t=e.t;
  ctx.save();ctx.globalAlpha=1-t;
  if(e.kind==='splash') {
    for(let i=0;i<7;i++){const a=(i/6)*Math.PI;const px=x+Math.cos(a)*t*e.size*.7,py=y-Math.sin(a)*t*28+t*t*24;ctx.fillStyle='#cfffea';ctx.beginPath();ctx.arc(px,py,2*(1-t)+.7,0,7);ctx.fill();}
    ellipse(x,y,12+t*45,3+t*10,'#d7fff2',1.6);
  } else {
    ctx.strokeStyle=e.hit?'#e0ff91':'#f3f4e6';ctx.lineWidth=2;const s=24+t*12;
    for(const [sx,sy] of [[-1,-1],[1,-1],[-1,1],[1,1]]){ctx.beginPath();ctx.moveTo(x+sx*(s-9),y+sy*s);ctx.lineTo(x+sx*s,y+sy*s);ctx.lineTo(x+sx*s,y+sy*(s-9));ctx.stroke();}
    if(e.text){ctx.font='800 23px Arial';ctx.textAlign='center';ctx.lineWidth=4;ctx.strokeStyle='#10282e';ctx.strokeText(e.text,x,y-36-t*30);ctx.fillStyle='#efffc7';ctx.fillText(e.text,x,y-36-t*30);}
  }
  ctx.restore();
}
function shoot(x,y) {
  const now=performance.now();
  if(state!=='playing' || now-lastShot<240 || !round)return;
  lastShot=now; const shot=takePhoto(round,x,y,width,height,shore,near);if(!shot)return;
  unlockAudio(); shutterSound(shot.hit ? (shot.duck.depth*.5+.5) : .4);
  effects.push({kind:'photo',x:x/width,y:y/height,t:0,hit:shot.hit,text:shot.hit?'+'+shot.points:''});
  if(!reduced){$('flash').classList.remove('flash');void $('flash').offsetWidth;$('flash').classList.add('flash');}
  if(shot.hit) {
    announce((shot.duck.type==='golden'?'GOLDEN SHOT':shot.resurfaced?'DIVE BONUS':'NICE SHOT')+'  +'+shot.points+(shot.multiplier>1?' · '+shot.multiplier+'× COMBO':''));
    try{navigator.vibrate?.(shot.duck.type==='golden'?[20,40,30]:12);}catch{}
    tone(500+round.multiplier*180,.09,.04,.05);
  } else announce('JUST WATER · TRY THE NEXT DUCK',.55);
  updateHud();
}
canvas.addEventListener('pointerdown',e=>{if(e.isPrimary && e.button===0){e.preventDefault();const rect=canvas.getBoundingClientRect();shoot(e.clientX-rect.left,e.clientY-rect.top);}});
$('shutterButton').onclick=()=>shoot(width/2,height*.57);
addEventListener('keydown',e=>{if(e.code==='Space' && e.target===document.body && state==='playing'){e.preventDefault();shoot(width/2,height*.57);} if(e.key==='Escape')pause();});

function unlockAudio() {
  if(!soundOn)return;
  try {
    audio ||= new (window.AudioContext||window.webkitAudioContext)();
    if(audio.state==='suspended')audio.resume().catch(()=>{});
    if(!noise){noise=audio.createBuffer(1,Math.floor(audio.sampleRate*.085),audio.sampleRate);const data=noise.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*(1-i/data.length);}
  } catch{}
}
function tone(hz,length,volume,delay=0) {
  if(!soundOn || !audio || audio.state!=='running')return;
  try {const t=audio.currentTime+delay,o=audio.createOscillator(),g=audio.createGain();o.type='sine';o.frequency.value=hz;g.gain.setValueAtTime(volume,t);g.gain.exponentialRampToValueAtTime(.001,t+length);o.connect(g).connect(audio.destination);o.onended=()=>{o.disconnect();g.disconnect();};o.start(t);o.stop(t+length+.02);}catch{}
}
function shutterSound(volume) {
  if(!soundOn || !audio || !noise || audio.state!=='running')return;
  try{const s=audio.createBufferSource(),g=audio.createGain(),f=audio.createBiquadFilter();s.buffer=noise;f.type='highpass';f.frequency.value=1200;g.gain.value=.11*volume;s.connect(f).connect(g).connect(audio.destination);s.onended=()=>{s.disconnect();f.disconnect();g.disconnect();};s.start();}catch{}
}
$('soundButton').onclick=()=>{
  soundOn=!soundOn;$('soundButton').innerHTML=soundOn?'♪ <span>Sound on</span>':'♪ <span>Sound off</span>';$('soundButton').setAttribute('aria-pressed',String(!soundOn));$('soundButton').setAttribute('aria-label',soundOn?'Mute sound':'Enable sound');
  if(soundOn){unlockAudio();tone(650,.1,.05);}
};
function requestImmersive() {
  // Invoked on Ready's user gesture; unavailable APIs never block play.
  if(!document.fullscreenElement && width>height && matchMedia('(pointer: coarse)').matches)document.documentElement.requestFullscreen?.().catch(()=>{});
}
async function requestWake() {
  try{if(navigator.wakeLock && !wake){const acquired=await navigator.wakeLock.request('screen');if(['countdown','playing','align'].includes(state))wake=acquired;else acquired.release();}}catch{}
}
function releaseWake() {const old=wake;wake=null;old?.release().catch(()=>{});}
$('motionButton').onclick=async()=>{
  try {
    const API=window.DeviceOrientationEvent;if(!API)return;
    const permission=typeof API.requestPermission==='function'?await API.requestPermission():'granted';
    if(permission!=='granted'){$('motionNote').textContent='Motion is off. Pause / realign still works.';return;}
    if(!motionEnabled)addEventListener('deviceorientation',e=>{
      if(![e.alpha,e.beta,e.gamma].every(v=>typeof v==='number' && Number.isFinite(v)))return;
      orientation=cameraVector(e.alpha,e.beta,e.gamma);orientationAt=performance.now();
      if(state==='align')$('motionNote').textContent='Turn reminder on. Keep your phone steady.';
    });
    motionEnabled=true;$('motionButton').hidden=true;$('motionNote').textContent='Waiting for motion… Realign anytime.';
  } catch{$('motionNote').textContent='Motion unavailable. Use Pause / realign.';}
};
$('shoreline').oninput=e=>{shore=Number(e.target.value)/100;$('shoreGuide').style.top=(shore*100)+'%';};
$('nearline').oninput=e=>{near=Number(e.target.value)/100;$('nearGuide').style.top=(near*100)+'%';};
$('playButton').onclick=()=>begin(false);
$('previewButton').onclick=()=>begin(true);
$('readyButton').onclick=ready;
$('portraitButton').onclick=()=>{portraitAllowed=true;enterAlignment();};
$('pauseButton').onclick=()=>pause();
$('resumeButton').onclick=resume;
$('endButton').onclick=()=>round?finish(true):home();
$('againButton').onclick=()=>begin(practice);
$('doneButton').onclick=home;
$('alignExit').onclick=home;
$('cancelCamera').onclick=home;
$('errorBack').onclick=home;
$('retryButton').onclick=()=>begin(practice,!!round);
$('errorDemo').onclick=()=>begin(true);

document.addEventListener('visibilitychange',()=>{
  if(document.hidden) {
    if(['playing','countdown','align','rotate'].includes(state))pause('Welcome back to the pond.', 'Your round is paused. Reopen the view and realign when you’re ready.');
    else if(state==='loading'){stopCamera();show('landing');}
    stopCamera();audio?.suspend().catch(()=>{});
  }
});
addEventListener('pagehide',()=>{stopCamera();releaseWake();cancelAnimationFrame(raf);raf=0;});
addEventListener('pageshow',e=>{if(e.persisted)home();});
