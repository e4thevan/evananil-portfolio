// Browser-independent simulation. Positions are normalized inside the water.
export const ROUND_SECONDS = 30;
export const TYPES = {
  mint: { points: 100, speed: 1, image: 'mint' },
  fast: { points: 200, speed: 1.7, image: 'fast' },
  tiny: { points: 300, speed: .85, image: 'mint' },
  diver: { points: 100, speed: 1.1, image: 'diver' },
  golden: { points: 1000, speed: 1.65, image: 'golden' }
};
export function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
export function createRound(random = Math.random) {
  return { time: 0, score: 0, shots: 0, photos: 0, streak: 0, multiplier: 1, bestMultiplier: 1, golden: false, goldenSpawned: false, nextSpawn: 0, id: 0, ducks: [], events: [], random };
}
export function spawnDuck(round, type) {
  const r = round.random;
  const depth = type === 'tiny' ? .09 : type === 'golden' ? .5 : .12 + r() * .74;
  const side = r() < .5 ? .2 : .8;
  const duck = { id: ++round.id, type, depth, x: side + (r() - .5) * .1, direction: side < .5 ? 1 : -1, age: 0, captured: -1, submerged: false, resurfaced: false, phase: r() * Math.PI * 2 };
  round.ducks.push(duck); round.events.push({ kind: 'splash', duck: { ...duck } });
  return duck;
}
export function updateRound(round, dt) {
  if (round.time >= ROUND_SECONDS) return;
  dt = clamp(dt, 0, ROUND_SECONDS - round.time);
  round.time += dt;
  if (!round.goldenSpawned && round.time >= 24) {
    round.goldenSpawned = true; spawnDuck(round, 'golden'); round.events.push({ kind: 'golden' });
  }
  if (round.time >= round.nextSpawn && round.time < 29) {
    const r = round.random();
    const type = round.time < 5 ? 'mint' : round.time < 15 ? (r < .3 ? 'tiny' : 'mint') : (r < .38 ? 'fast' : r < .7 ? 'diver' : 'mint');
    if (round.ducks.filter(d => d.captured < 0).length < 7) spawnDuck(round, type);
    round.nextSpawn = round.time + (round.time < 5 ? 1.8 : round.time < 15 ? 1.25 : .85);
  }
  for (const d of round.ducks) {
    d.age += dt;
    if (d.captured >= 0) { d.captured += dt; continue; }
    if (d.type === 'diver' && !d.resurfaced && d.age >= 2.4 && d.age < 4) {
      if (!d.submerged) { d.submerged = true; round.events.push({ kind: 'splash', duck: { ...d } }); }
      d.x += d.direction * .09 * dt;
    } else {
      if (d.submerged) { d.submerged = false; d.resurfaced = true; round.events.push({ kind: 'splash', duck: { ...d } }); }
      d.x += d.direction * (.025 + d.depth * .035) * TYPES[d.type].speed * dt;
    }
    if (d.x < .05 || d.x > .95) { d.x = clamp(d.x, .05, .95); d.direction *= -1; }
  }
  round.ducks = round.ducks.filter(d => d.captured < 0 ? d.age < (d.type === 'golden' ? 7 : 8) : d.captured < .75);
}
export function duckGeometry(duck, width, height, shore, near) {
  const waterTop = shore * height, waterBottom = near * height;
  const scale = clamp(height / 420, .78, 1.35);
  // Fit a complete sprite into the band even with a high far-shore setting.
  const wanted = (45 + duck.depth * 43) * scale * (duck.type === 'tiny' ? .78 : duck.type === 'golden' ? 1.12 : 1);
  const size = Math.min(wanted, (waterBottom-waterTop)*.74);
  const y = waterTop + size + 3 + duck.depth * Math.max(0, waterBottom - waterTop - size - 6);
  const margin = width * (.12 - duck.depth * .06) + size * .5;
  return { x: margin + duck.x * (width - 2 * margin), y, width: size, height: size, targetY: y - size * .46 };
}
export function takePhoto(round, x, y, width, height, shore, near) {
  if (round.time >= ROUND_SECONDS) return null;
  round.shots++;
  const candidates = [...round.ducks].sort((a,b) => b.depth - a.depth);
  const duck = candidates.find(d => {
    if (d.submerged || d.captured >= 0 || d.age < .15) return false;
    const p = duckGeometry(d, width, height, shore, near);
    const rx = Math.max(25, p.width * .52), ry = Math.max(25, p.height * .5);
    return ((x-p.x)/rx)**2 + ((y-p.targetY)/ry)**2 <= 1;
  });
  if (!duck) { round.streak = 0; round.multiplier = 1; return { hit: false }; }
  round.streak++;
  round.multiplier = Math.min(3, 1 + Math.floor((round.streak-1) / 3));
  round.bestMultiplier = Math.max(round.bestMultiplier, round.multiplier);
  const base = duck.type === 'diver' && duck.resurfaced ? 400 : TYPES[duck.type].points;
  const points = base * round.multiplier;
  round.score += points; round.photos++; duck.captured = 0;
  if (duck.type === 'golden') round.golden = true;
  return { hit: true, duck, points, multiplier: round.multiplier, resurfaced: duck.type === 'diver' && duck.resurfaced };
}
export function cameraVector(alpha, beta, gamma) {
  const a=alpha*Math.PI/180,b=beta*Math.PI/180,g=gamma*Math.PI/180;
  return [-(Math.cos(a)*Math.sin(g)+Math.sin(a)*Math.sin(b)*Math.cos(g)), -(Math.sin(a)*Math.sin(g)-Math.cos(a)*Math.sin(b)*Math.cos(g)), -Math.cos(b)*Math.cos(g)];
}
export function angleBetween(a,b) { return Math.acos(clamp(a.reduce((sum,v,i)=>sum+v*b[i],0),-1,1))*180/Math.PI; }
