(() => {
  // ── Rotate-for-full-experience prompt (mobile portrait only) ──
  const rotatePrompt = document.getElementById('rotate-prompt');
  const isMobilePortrait = () => window.matchMedia('(max-width: 900px) and (orientation: portrait)').matches;
  const ROTATE_SEEN_KEY = 'evan_rotate_seen_v1';
  function dismissRotate() {
    if (!rotatePrompt.classList.contains('show')) return;
    rotatePrompt.classList.add('dismissed');
    sessionStorage.setItem(ROTATE_SEEN_KEY, '1');
    setTimeout(() => rotatePrompt.classList.remove('show', 'dismissed'), 600);
  }
  if (isMobilePortrait() && sessionStorage.getItem(ROTATE_SEEN_KEY) !== '1') {
    rotatePrompt.classList.add('show');
    rotatePrompt.setAttribute('aria-hidden', 'false');
    rotatePrompt.addEventListener('click', dismissRotate, { once: false });
    rotatePrompt.addEventListener('touchend', dismissRotate, { passive: true });
  }
  // Auto-dismiss if the user rotates to landscape
  window.addEventListener('orientationchange', () => {
    if (!isMobilePortrait()) dismissRotate();
  });

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const loader = document.getElementById('loader');
  const loaderFill = document.querySelector('.loader-fill');
  const loaderPercent = document.getElementById('loader-percent');
  const progressFill = document.querySelector('.progress-fill');
  const scrollHint = document.getElementById('scroll-hint');

  const scenes = [
    { folder: 'assets/scene0/', prefix: 'frame-', count: 192 },
    { folder: 'assets/scene1/', prefix: 'frame-', count: 121 },
    { folder: 'assets/scene2/', prefix: 'frame-', count: 121 },
    { folder: 'assets/scene3/', prefix: 'frame-', count: 96 },
  ];

  const groups = [
    { scenes: [0],       spacerId: 'group0-spacer', panToNext: true },
    { scenes: [1, 2, 3], spacerId: 'group1-spacer', panToNext: false },
  ];

  const PAN_START = 0.75;
  const OVERLAP_FRAMES = 0.15;

  const frameImages = scenes.map(() => []);
  const totalFrames = scenes.reduce((s, sc) => s + sc.count, 0);
  let loadedCount = 0;
  let hasScrolled = false;

  function resize() {
    canvas.width = canvas.parentElement.offsetWidth;
    canvas.height = canvas.parentElement.offsetHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  function pad(n) { return String(n).padStart(3, '0'); }

  function initCharSplit() {
    document.querySelectorAll('[data-split]').forEach((el) => {
      const text = el.textContent;
      el.textContent = '';
      [...text].forEach((char, i) => {
        const span = document.createElement('span');
        span.className = 'char';
        span.textContent = char === ' ' ? '\u00A0' : char;
        span.style.transitionDelay = `${i * 0.08}s`;
        el.appendChild(span);
      });
    });
  }

  function loadFrames() {
    return new Promise((resolve) => {
      scenes.forEach((scene, si) => {
        for (let i = 1; i <= scene.count; i++) {
          const img = new Image();
          img.decoding = 'async';
          img.src = `${scene.folder}${scene.prefix}${pad(i)}.jpg`;
          const done = () => {
            loadedCount++;
            const pct = Math.round((loadedCount / totalFrames) * 100);
            loaderFill.style.width = pct + '%';
            loaderPercent.textContent = pct;
            if (loadedCount >= totalFrames) resolve();
          };
          img.onload = () => {
            // Force a decode so the bitmap is GPU-ready before first scroll paint.
            // Avoids per-frame decode stalls mid-scroll (the scene-2 "scroll does nothing" lag).
            if (img.decode) {
              img.decode().then(done).catch(done);
            } else { done(); }
          };
          img.onerror = done;
          frameImages[si][i - 1] = img;
        }
      });
    });
  }

  function drawFrame(img) {
    if (!img || !img.naturalWidth) return;
    const cw = canvas.width, ch = canvas.height;
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const scale = Math.max(cw / iw, ch / ih);
    const dw = iw * scale, dh = ih * scale;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
  }

  function drawComposite(topImg, botImg, panProgress) {
    const cw = canvas.width, ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    // Overlap the two images by 2px on the seam so subpixel rounding never exposes a line.
    [topImg, botImg].forEach((img, idx) => {
      if (!img || !img.naturalWidth) return;
      const iw = img.naturalWidth, ih = img.naturalHeight;
      const scale = Math.max(cw / iw, ch / ih);
      const dw = iw * scale, dh = ih * scale;
      const baseDy = (ch - dh) / 2 + (idx === 0 ? -panProgress * ch : ch - panProgress * ch);
      // idx 0 (top) grows 2px downward past the seam; idx 1 (bot) starts 2px earlier.
      const dy = Math.floor(baseDy) + (idx === 0 ? 0 : -2);
      const dhExt = Math.ceil(dh) + 2;
      const dx = Math.floor((cw - dw) / 2);
      const dwExt = Math.ceil(dw) + 1;
      ctx.drawImage(img, dx, dy, dwExt, dhExt);
    });
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function getGroupFrame(group, progress, startOffset) {
    let total = 0;
    for (const si of group.scenes) total += scenes[si].count;
    const avail = total - startOffset;
    const target = Math.min(total - 1, Math.max(0, startOffset + Math.floor(progress * avail)));
    let acc = 0;
    for (const si of group.scenes) {
      if (target < acc + scenes[si].count) return frameImages[si][target - acc];
      acc += scenes[si].count;
    }
    const lastSi = group.scenes[group.scenes.length - 1];
    return frameImages[lastSi][scenes[lastSi].count - 1];
  }

  function getGroupTotalFrames(group) {
    let t = 0;
    for (const si of group.scenes) t += scenes[si].count;
    return t;
  }

  // Spacer elements for scroll measurement
  const spacerEls = groups.map((g) => document.getElementById(g.spacerId));

  // ── Scroll dwell / "slow breaks" on text sections ──
  // During a text block's [enter, leave] window, frame advance slows to HOLD_WEIGHT
  // so users naturally dwell on the text instead of scrolling past it.
  const HOLD_WEIGHT = 0.18; // 18% of normal speed during text dwells
  function buildWarpSegments(holdsRaw) {
    if (!holdsRaw || !holdsRaw.length) return [{ ps: 0, pe: 1, fps: 0, fpe: 1 }];
    const holds = holdsRaw
      .map(h => ({ start: Math.max(0, h.start), end: Math.min(1, h.end) }))
      .filter(h => h.end > h.start)
      .sort((a, b) => a.start - b.start);
    const merged = [];
    for (const h of holds) {
      if (merged.length && h.start <= merged[merged.length - 1].end) {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, h.end);
      } else merged.push({ ...h });
    }
    const segs = [];
    let cursor = 0;
    for (const h of merged) {
      if (h.start > cursor) segs.push({ ps: cursor, pe: h.start, w: 1 });
      segs.push({ ps: h.start, pe: h.end, w: HOLD_WEIGHT });
      cursor = h.end;
    }
    if (cursor < 1) segs.push({ ps: cursor, pe: 1, w: 1 });
    let total = 0;
    for (const s of segs) total += (s.pe - s.ps) * s.w;
    let acc = 0;
    for (const s of segs) {
      s.fps = acc / total;
      acc += (s.pe - s.ps) * s.w;
      s.fpe = acc / total;
    }
    return segs;
  }
  function warpProgress(p, segs) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    for (const s of segs) {
      if (p <= s.pe) {
        const t = (p - s.ps) / Math.max(1e-6, s.pe - s.ps);
        return s.fps + t * (s.fpe - s.fps);
      }
    }
    return 1;
  }
  // Derive holds per group from the DOM (single source of truth: data-enter/leave)
  const groupWarp = groups.map((_, gi) => {
    const raw = [];
    document.querySelectorAll(`.text-block[data-group="${gi}"]`).forEach(b => {
      raw.push({ start: parseFloat(b.dataset.enter), end: parseFloat(b.dataset.leave) });
    });
    return buildWarpSegments(raw);
  });

  // Text blocks grouped by data-group
  const textBlocksByGroup = {};
  document.querySelectorAll('.text-block[data-group]').forEach((block) => {
    const gi = block.dataset.group;
    if (!textBlocksByGroup[gi]) textBlocksByGroup[gi] = [];
    textBlocksByGroup[gi].push(block);
  });

  // Cinematic easing via GSAP (falls back gracefully when GSAP hasn't loaded yet)
  let cineEase = 'expo.out';
  function ensureGsap() {
    if (!window.gsap) return false;
    if (!cineEase._registered && window.CustomEase) {
      try {
        gsap.registerPlugin(CustomEase);
        CustomEase.create('cine', '0.16, 1, 0.3, 1');
        cineEase = 'cine';
        cineEase._registered = true;
      } catch (e) { /* keep expo.out */ }
    }
    return true;
  }

  function animateBlock(block, show) {
    if (!ensureGsap()) return; // CSS opacity on .visible will still work
    gsap.killTweensOf(block);
    if (show) {
      gsap.fromTo(block,
        { opacity: 0, y: 34, scale: 0.975, filter: 'blur(6px)' },
        { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)',
          duration: 1.15, ease: cineEase, overwrite: true });
    } else {
      gsap.to(block, {
        opacity: 0, y: -20, scale: 0.99, filter: 'blur(4px)',
        duration: 0.55, ease: 'power2.inOut', overwrite: true,
      });
    }
  }

  function updateTextBlocks() {
    const wh = window.innerHeight;
    spacerEls.forEach((spacer, gi) => {
      if (!spacer) return;
      const rect = spacer.getBoundingClientRect();
      const sH = spacer.offsetHeight;
      const progress = Math.min(1, Math.max(0, -rect.top / Math.max(1, sH - wh)));
      const blocks = textBlocksByGroup[gi] || [];
      blocks.forEach((block) => {
        const enter = parseFloat(block.dataset.enter);
        const leave = parseFloat(block.dataset.leave);
        const shouldShow = progress >= enter && progress <= leave;
        const isShowing = block.classList.contains('visible');
        if (shouldShow && !isShowing) {
          block.classList.add('visible');
          animateBlock(block, true);
        } else if (!shouldShow && isShowing) {
          block.classList.remove('visible');
          animateBlock(block, false);
        }
      });
    });
  }

  function updateProgress() {
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    progressFill.style.height = (docHeight > 0 ? (scrollTop / docHeight) * 100 : 0) + '%';
  }

  let ticking = false;

  function onScroll() {
    if (!hasScrolled && window.scrollY > 50) {
      hasScrolled = true;
      scrollHint.classList.add('hidden');
    }
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const wh = window.innerHeight;
      let drawn = false;

      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];
        const spacer = spacerEls[gi];
        if (!spacer) continue;
        const rect = spacer.getBoundingClientRect();

        if (rect.bottom > 0 && rect.top < wh) {
          const sH = spacer.offsetHeight;
          const progress = Math.min(1, Math.max(0, -rect.top / (sH - wh)));
          const isFirst = gi === 0;
          const startOffset = isFirst ? 0 : Math.floor(OVERLAP_FRAMES * getGroupTotalFrames(group));
          const hasNext = gi < groups.length - 1;

          if (group.panToNext && hasNext && progress >= PAN_START) {
            const panRaw = (progress - PAN_START) / (1 - PAN_START);
            const panProgress = easeInOutCubic(panRaw);
            const currentFrame = getGroupFrame(group, progress, startOffset);
            const nextGroup = groups[gi + 1];
            const nextTotal = getGroupTotalFrames(nextGroup);
            const nextIdx = Math.min(nextTotal - 1, Math.floor(panRaw * OVERLAP_FRAMES * nextTotal));
            let acc = 0, nextFrame = null;
            for (const si of nextGroup.scenes) {
              if (nextIdx < acc + scenes[si].count) { nextFrame = frameImages[si][nextIdx - acc]; break; }
              acc += scenes[si].count;
            }
            drawComposite(currentFrame, nextFrame, panProgress);
          } else {
            drawFrame(getGroupFrame(group, progress, startOffset));
          }
          drawn = true;
          break;
        }
      }

      if (!drawn) {
        const lg = groups[groups.length - 1];
        const ls = lg.scenes[lg.scenes.length - 1];
        drawFrame(frameImages[ls][scenes[ls].count - 1]);
      }

      updateTextBlocks();
      updateProgress();
      ticking = false;
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });

  initCharSplit();

  loadFrames().then(() => {
    window.scrollTo(0, 0);
    loader.classList.add('done');
    drawFrame(frameImages[0][0]);
    setTimeout(() => { updateTextBlocks(); updateProgress(); onScroll(); }, 50);
  });

  // ── Review Modal ──
  // Beta review capture. Submissions go to the REVIEW_EMAIL below via formsubmit.co.
  // To change destination: edit REVIEW_EMAIL. First submission will trigger a one-time
  // activation email from formsubmit.co — confirm it and every review after lands in inbox.
  const REVIEW_EMAIL = 'evananil.jr@gmail.com';
  const reviewModal = document.getElementById('review-modal');
  const reviewForm = document.getElementById('review-form');
  const reviewClose = document.querySelector('.review-close');
  const reviewSendBtn = document.querySelector('.review-send');
  let reviewShown = false;
  const REVIEW_SEEN_KEY = 'evan_review_seen_v1';

  function openReview() {
    if (reviewShown) return;
    if (localStorage.getItem(REVIEW_SEEN_KEY) === '1') return;
    reviewShown = true;
    reviewModal.classList.add('open');
    reviewModal.setAttribute('aria-hidden', 'false');
  }
  function closeReview() {
    reviewModal.classList.remove('open');
    reviewModal.setAttribute('aria-hidden', 'true');
  }

  // Watch for end of scroll
  function checkEndOfScroll() {
    const sh = document.documentElement.scrollHeight - window.innerHeight;
    if (sh <= 0) return;
    const nearEnd = (window.scrollY / sh) >= 0.98;
    if (nearEnd) openReview();
  }
  window.addEventListener('scroll', () => {
    if (!hasScrolled) return;
    checkEndOfScroll();
  }, { passive: true });

  reviewClose.addEventListener('click', closeReview);
  reviewModal.querySelector('.review-backdrop').addEventListener('click', closeReview);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeReview(); });

  reviewForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(reviewForm);
    // Honeypot check
    if (fd.get('_honey')) return;
    const payload = {
      name: (fd.get('name') || 'Anonymous').toString().trim(),
      message: (fd.get('message') || '').toString().trim(),
      _subject: 'New review on evananil.com',
      _captcha: 'false',
      _template: 'table',
      page: location.href,
      userAgent: navigator.userAgent,
      submittedAt: new Date().toISOString(),
    };
    if (!payload.message) return;
    reviewSendBtn.disabled = true;
    reviewSendBtn.querySelector('.review-send-label').textContent = 'Sending…';
    try {
      const res = await fetch(`https://formsubmit.co/ajax/${REVIEW_EMAIL}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('bad response');
      localStorage.setItem(REVIEW_SEEN_KEY, '1');
      reviewModal.classList.add('sent');
      setTimeout(closeReview, 2600);
    } catch (err) {
      reviewSendBtn.disabled = false;
      reviewSendBtn.querySelector('.review-send-label').textContent = 'Try again';
      console.warn('Review submit failed', err);
    }
  });
})();
