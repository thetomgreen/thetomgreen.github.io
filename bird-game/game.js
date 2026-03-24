// ── Difficulty settings ───────────────────────────────────────────────────────
// Difficulty controls the STYLE of fake name, not the length.
// All three lengths (short/medium/long) appear at every difficulty level.
//
// easy   → silly/funny names (Boingbird, Wobbly Flumpwren, Greater Giggly Noodlelark)
// medium → plausible invented names (Greysnipe, Dusky Thornwren, Pale-crowned Reedwarbler)
// hard   → convincing real-bird-pattern names (Yellow-naped Warbler, Lesser Rufous-fronted Pipit)

let selectedDifficulty = 'auto';
let adaptiveDifficulty = 'medium';
let recentResults = [];

function getStyle() {
  return selectedDifficulty === 'auto' ? adaptiveDifficulty : selectedDifficulty;
}

function setDifficulty(level) {
  selectedDifficulty = level;
  document.querySelectorAll('.diff-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.level === level);
  });
  updateAdaptiveLabel();
}

function updateAdaptiveDifficulty(correct) {
  recentResults.push(correct);
  if (recentResults.length > 5) recentResults.shift();
  if (recentResults.length < 3) return;
  const last3 = recentResults.slice(-3);
  const correct3 = last3.filter(Boolean).length;
  if (correct3 === 3) {
    if (adaptiveDifficulty === 'easy')        adaptiveDifficulty = 'medium';
    else if (adaptiveDifficulty === 'medium') adaptiveDifficulty = 'hard';
  } else if (correct3 <= 1) {
    if (adaptiveDifficulty === 'hard')        adaptiveDifficulty = 'medium';
    else if (adaptiveDifficulty === 'medium') adaptiveDifficulty = 'easy';
  }
  updateAdaptiveLabel();
}

function updateAdaptiveLabel() {
  const el = document.getElementById('adaptive-label');
  el.textContent = selectedDifficulty === 'auto' ? `(${adaptiveDifficulty})` : '';
}


// ── Photo fetching ───────────────────────────────────────────────────────────
async function fetchBirdPhoto(birdName) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(birdName)}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data.thumbnail?.source ?? null;
  } catch {
    return null;
  }
}

// ── Game state ───────────────────────────────────────────────────────────────
let score = 0, streak = 0, bestStreak = 0;
let currentRound = null, answered = false;
let birdPool = [];      // shuffled indices for main BIRDS pool
let hardBirdPool = [];  // shuffled indices for HARD_BIRDS pool
let photoPromises = [];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickTwoBirds() {
  const style = getStyle();
  if (style === 'hard') {
    if (hardBirdPool.length < 2) {
      hardBirdPool = shuffle([...Array(HARD_BIRDS.length).keys()]);
    }
    return [HARD_BIRDS[hardBirdPool.pop()], HARD_BIRDS[hardBirdPool.pop()]];
  }
  if (birdPool.length < 2) {
    birdPool = shuffle([...Array(BIRDS.length).keys()]);
  }
  return [BIRDS[birdPool.pop()], BIRDS[birdPool.pop()]];
}

function startRound() {
  answered = false;

  const [bird1, bird2] = pickTwoBirds();
  currentRound = { real: [bird1, bird2], fake: generateFakeName() };

  // Kick off photo fetches in background while user is thinking
  photoPromises = currentRound.real.map(b => fetchBirdPhoto(b.name));

  const options = shuffle([
    { name: currentRound.fake, isFake: true },
    { name: currentRound.real[0].name, isFake: false },
    { name: currentRound.real[1].name, isFake: false }
  ]);

  const cards = document.getElementById('bird-cards');
  cards.innerHTML = '';
  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'bird-btn';
    btn.dataset.fake = opt.isFake;
    btn.innerHTML = `<div class="bird-name">${opt.name}</div>`;
    btn.onclick = () => handleGuess(opt.isFake, opt.name);
    cards.appendChild(btn);
  });

  document.getElementById('result-panel').style.display = 'none';
}

async function handleGuess(pickedFake, pickedName) {
  if (answered) return;
  answered = true;

  if (pickedFake) {
    score++;
    streak++;
    if (streak > bestStreak) bestStreak = streak;
  } else {
    streak = 0;
  }

  if (selectedDifficulty === 'auto') updateAdaptiveDifficulty(pickedFake);

  document.getElementById('score').textContent = score;
  document.getElementById('best-streak').textContent = bestStreak;

  document.querySelectorAll('.bird-btn').forEach(btn => {
    btn.disabled = true;
    const isFakeBtn = btn.dataset.fake === 'true';
    const wasClicked = btn.querySelector('.bird-name').textContent === pickedName;
    btn.classList.add(isFakeBtn ? 'reveal-fake' : 'reveal-real');
    btn.innerHTML += `<div class="result-label ${isFakeBtn ? 'label-fake' : 'label-real'}">${isFakeBtn ? '✗ FAKE' : '✓ REAL'}</div>`;
    if (wasClicked && pickedFake)  btn.classList.add('correct');
    if (wasClicked && !pickedFake) btn.classList.add('wrong');
  });

  const header = document.getElementById('result-header');
  header.textContent = pickedFake
    ? (streak >= 3 ? `✓ Correct! 🔥 ${streak} in a row!` : '✓ Correct!')
    : `✗ Nope! The fake was: ${currentRound.fake}`;
  header.className = `result-header ${pickedFake ? 'win' : 'lose'}`;

  // Build result panel with photo placeholders
  const info = document.getElementById('real-birds-info');
  info.innerHTML = '';
  currentRound.real.forEach((bird, i) => {
    const div = document.createElement('div');
    div.className = 'real-bird';
    div.innerHTML = `
      <h3>${bird.name}</h3>
      <div class="photo-wrap" id="photo-wrap-${i}">
        <div class="photo-loading">loading photo…</div>
        <img id="bird-photo-${i}" class="bird-photo" alt="${bird.name}">
      </div>
      <p class="fun-fact">${bird.fact}</p>
    `;
    info.appendChild(div);
  });

  document.getElementById('streak-display').innerHTML =
    streak >= 2 ? `🔥 Current streak: <span>${streak}</span>` : '';

  const panel = document.getElementById('result-panel');
  panel.style.display = 'block';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Resolve photos (likely already fetched while user was thinking)
  const photos = await Promise.all(photoPromises);
  photos.forEach((src, i) => {
    const wrap = document.getElementById(`photo-wrap-${i}`);
    const img  = document.getElementById(`bird-photo-${i}`);
    if (!wrap || !img) return;
    if (src) {
      img.onload  = () => img.classList.add('loaded');
      img.onerror = () => { wrap.style.display = 'none'; };
      img.src = src;
    } else {
      wrap.style.display = 'none';
    }
  });
}

function nextRound() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
  setTimeout(startRound, 300);
}

startRound();
