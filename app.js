(() => {
  'use strict';

  const LABELS = {
    shoes: 'Παπούτσια', shirts: 'Μπλούζες', hoodies: 'Φούτερ', tracksuits: 'Φόρμες',
    jerseys: 'Φανέλες', pants: 'Παντελόνια', shorts: 'Σορτς', jackets: 'Μπουφάν',
    headwear: 'Καπέλα', accessories: 'Αξεσουάρ', watches: 'Ρολόγια', bags: 'Τσάντες',
    tech: 'Tech', womens: 'Γυναικεία',
  };
  const THEMES = ['asphalt', 'ecru', 'cobalt'];
  const OVERSCAN = 2;                       // extra rows kept above and below the viewport

  const $ = sel => document.querySelector(sel);
  const root = document.documentElement;
  const main = $('#main'), bar = $('#bar'), chipsEl = $('#chips'), progress = $('#progress');
  const searchEl = $('#q'), clearEl = $('#clear'), statusEl = $('#status'), subEl = $('#sub'), tallyEl = $('#tally');
  const sizer = $('#sizer'), grid = $('#grid'), emptyEl = $('#empty'), emptyText = $('#empty-text');
  const ghosts = $('#ghosts'), toTop = $('#to-top'), cardTpl = $('#card-tpl'), cursor = $('#cursor');
  const lb = $('#lb'), lbBackdrop = $('#lb-backdrop'), lbFrame = $('#lb-frame'), lbImg = $('#lb-img');
  const lbName = $('#lb-name'), lbSub = $('#lb-sub');

  const fmt = new Intl.NumberFormat('el-GR');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const mouse = matchMedia('(hover: hover) and (pointer: fine)');
  const fold = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const label = cat => LABELS[cat] || cat;
  const onScreen = r => r.bottom > 0 && r.top < innerHeight;

  // the springs live in style.css as linear() curves, so css and js move the same way
  const springsWork = CSS.supports('transition-timing-function', 'linear(0, 1)');
  const spring = name => {
    const cs = getComputedStyle(root);
    return {
      easing: springsWork ? cs.getPropertyValue(`--spring-${name}`).trim() : 'cubic-bezier(.2,.9,.3,1.12)',
      duration: parseFloat(cs.getPropertyValue(`--spring-${name}-dur`)) || 600,
    };
  };
  const SOFT = spring('soft'), SNAPPY = spring('snappy');

  let products = [];            // [{name, category, image}]
  let folded = [];              // lower-cased, accent-free names for searching
  let view = [];                // indices into products that pass the current filter, in order
  let category = 'all';
  let query = '';

  let cols = 2, gap = 12, rowH = 0, lastWidth = 0;
  let winStart = -1, winEnd = -1;
  let seen = new Uint8Array(0); // products that already played their reveal
  let veilNew = true;           // new cards start hidden and wait for the observer
  let introHold = 900;          // lets the title and chips land before the first cards
  let flung = false;            // scrolling too fast for staggered reveals
  const live = new Map();       // product index -> card element currently in the DOM
  const chipEls = new Map();
  const pill = document.createElement('span');

  /* ------------------------------------------------------------ themes */

  const swatches = [...document.querySelectorAll('.swatch')];
  const theme = () => (THEMES.includes(root.dataset.theme) ? root.dataset.theme : THEMES[0]);
  const markTheme = () => swatches.forEach(s => s.setAttribute('aria-pressed', String(s.dataset.set === theme())));

  function setTheme(name, from) {
    if (name === theme()) return;
    const apply = () => { root.dataset.theme = name; markTheme(); };
    try { localStorage.setItem('gallery-theme', name); } catch {}
    if (reduceMotion.matches) return apply();
    if (document.startViewTransition) {
      // the new theme grows out of the swatch as a circle
      const r = from.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      root.style.setProperty('--tx', `${x}px`);
      root.style.setProperty('--ty', `${y}px`);
      root.style.setProperty('--tr', `${Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))}px`);
      document.startViewTransition(apply);
    } else {
      root.classList.add('theming');
      apply();
      setTimeout(() => root.classList.remove('theming'), 560);
    }
  }

  swatches.forEach(s => s.addEventListener('click', () => setTheme(s.dataset.set, s)));
  markTheme();

  /* ------------------------------------------------------------ data */

  async function loadProducts() {
    if (location.protocol !== 'file:') {
      try {
        const res = await fetch('products.json', { cache: 'no-cache' });
        if (res.ok) return await res.json();
      } catch {}
    }
    // fetch is blocked on file://, products.js carries the same list as a script
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'products.js';
      s.onload = () => resolve(window.__PRODUCTS__ || []);
      s.onerror = () => reject(new Error('products.js'));
      document.head.append(s);
    });
  }

  /* ------------------------------------------------------------ filtering */

  function buildChips() {
    const present = new Set(products.map(p => p.category));
    const order = ['all',
      ...Object.keys(LABELS).filter(c => present.has(c)),
      ...[...present].filter(c => !(c in LABELS)).sort()];
    pill.className = 'chip-pill';
    chipsEl.append(pill);
    order.forEach((cat, i) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.cat = cat;
      chip.style.setProperty('--i', i);
      chip.innerHTML = '<span></span><span class="chip-n"></span>';
      chip.firstChild.textContent = cat === 'all' ? 'Όλα' : label(cat);
      chipsEl.append(chip);
      chipEls.set(cat, chip);
    });
  }

  // the one active background slides (and stretches) from the old chip to the new one
  function placePill(slide) {
    const chip = chipEls.get(category);
    if (!chip) return;
    const was = pill.getBoundingClientRect();
    pill.style.left = `${chip.offsetLeft}px`;
    pill.style.top = `${chip.offsetTop}px`;
    pill.style.width = `${chip.offsetWidth}px`;
    pill.style.height = `${chip.offsetHeight}px`;
    if (!slide || !was.width || reduceMotion.matches) return;
    const now = pill.getBoundingClientRect();
    pill.animate(
      [{ transform: `translate(${was.left - now.left}px,${was.top - now.top}px) scaleX(${was.width / now.width})` }, {}],
      { duration: SNAPPY.duration, easing: SNAPPY.easing });
  }

  function computeView() {
    const tokens = fold(query).split(/\s+/).filter(Boolean);
    const counts = { all: 0 };
    const next = [];
    for (let i = 0; i < products.length; i++) {
      const name = folded[i];
      let hit = true;
      for (const t of tokens) if (!name.includes(t)) { hit = false; break; }
      if (!hit) continue;
      const cat = products[i].category;
      counts.all++;
      counts[cat] = (counts[cat] || 0) + 1;
      if (category === 'all' || cat === category) next.push(i);
    }
    view = next;

    for (const [cat, chip] of chipEls) {
      const n = counts[cat] || 0;
      chip.lastChild.textContent = fmt.format(n);
      chip.classList.toggle('zero', n === 0);
      chip.setAttribute('aria-pressed', String(cat === category));
    }

    const parts = [`${fmt.format(view.length)} ${view.length === 1 ? 'προϊόν' : 'προϊόντα'}`];
    if (category !== 'all') parts.push(label(category));
    if (query.trim()) parts.push(`«${query.trim()}»`);
    statusEl.textContent = parts.join('  ·  ');

    emptyEl.hidden = view.length > 0;
    sizer.hidden = view.length === 0;
    emptyText.textContent = category !== 'all' && counts.all
      ? `Υπάρχουν ${fmt.format(counts.all)} αποτελέσματα σε άλλες κατηγορίες.`
      : 'Δοκίμασε άλλη λέξη ή άλλη κατηγορία.';
  }

  /* ------------------------------------------------------------ virtual grid */

  function measure() {
    const cs = getComputedStyle(grid);
    cols = Math.max(1, parseInt(cs.getPropertyValue('--cols'), 10) || 2);
    gap = parseFloat(cs.columnGap) || 0;
    const metaH = parseFloat(cs.getPropertyValue('--meta-h')) || 0;
    const cardW = (grid.clientWidth - gap * (cols - 1)) / cols;
    rowH = cardW + metaH + gap;           // square photo + caption + gap
  }

  function setHeight() {
    const rows = Math.ceil(view.length / cols);
    sizer.style.height = rows ? `${rows * rowH - gap}px` : '0px';
  }

  function createCard(pi) {
    const p = products[pi];
    const el = cardTpl.content.firstElementChild.cloneNode(true);
    const thumb = el.querySelector('.thumb');
    const img = thumb.firstElementChild;
    el._pi = pi;
    el.firstElementChild.setAttribute('aria-label', p.name);
    el.querySelector('.cat').textContent = label(p.category);
    el.querySelector('.name').textContent = p.name;
    img.addEventListener('load', () => thumb.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => thumb.classList.add('broken'), { once: true });
    img.src = p.image;
    if (img.complete && img.naturalWidth) thumb.classList.add('loaded', 'instant');
    if (veilNew && !seen[pi] && !reduceMotion.matches) veil(el);
    return el;
  }

  function veil(el) {
    el.classList.add('pre');
    revealer.observe(el);
  }

  // scroll reveal: whatever enters the viewport together comes into focus one after another
  const revealer = new IntersectionObserver(entries => {
    const hits = entries.filter(e => e.isIntersecting).map(e => e.target).sort((a, b) => a._pos - b._pos);
    hits.forEach((el, k) => {
      el.style.setProperty('--d', `${flung ? 0 : introHold + Math.min(k, 12) * 55}ms`);
      el.classList.remove('pre');
      revealer.unobserve(el);
      seen[el._pi] = 1;
    });
    if (hits.length) introHold = 0;
  }, { rootMargin: '0px 0px -3% 0px', threshold: 0.05 });

  function render(force, onRemove) {
    if (!rowH) return;
    const rows = Math.ceil(view.length / cols);
    const top = -sizer.getBoundingClientRect().top;
    const r0 = clamp(Math.floor(top / rowH) - OVERSCAN, 0, Math.max(rows - 1, 0));
    const r1 = clamp(Math.ceil((top + innerHeight) / rowH) + OVERSCAN, 0, rows);
    const start = r0 * cols, end = Math.min(view.length, r1 * cols);
    if (!force && start === winStart && end === winEnd) return;
    winStart = start;
    winEnd = end;

    const want = view.slice(start, end);
    const keep = new Set(want);
    for (const [pi, el] of live) {
      if (keep.has(pi)) continue;
      if (onRemove) onRemove(pi, el);
      if (tilt && tilt.el.parentNode === el) endTilt();
      revealer.unobserve(el);
      el.remove();
      live.delete(pi);
    }
    let ref = grid.firstChild;
    want.forEach((pi, k) => {
      let el = live.get(pi);
      if (!el) live.set(pi, el = createCard(pi));
      el._pos = start + k;
      if (el === ref) ref = ref.nextSibling;
      else grid.insertBefore(el, ref);
    });
    grid.style.top = `${r0 * rowH}px`;
  }

  // filter or search changed (FLIP): cards that stay glide to their new slot on a
  // spring, new ones come up in sequence, the ones that drop out shrink and fade
  function refresh(slidePill) {
    const motion = !reduceMotion.matches && rowH > 0;
    const before = new Map();
    if (motion) for (const [pi, el] of live) {
      if (!el.classList.contains('pre')) before.set(pi, el.getBoundingClientRect());
    }

    computeView();
    placePill(slidePill);
    setHeight();
    seen.fill(0);
    const listTop = scrollY + main.getBoundingClientRect().top - bar.offsetHeight;
    if (scrollY > listTop) scrollTo(0, listTop);

    veilNew = false;
    render(true, motion ? (pi, el) => leave(el, before.get(pi)) : null);
    veilNew = true;
    if (!motion) return;

    const cards = [...grid.children];
    const rects = cards.map(el => el.getBoundingClientRect());
    const unveil = [];
    let order = 0;
    cards.forEach((el, i) => {
      const now = rects[i], was = before.get(el._pi);
      const wasVisible = was && onScreen(was);
      if (!onScreen(now) && !wasVisible) {
        if (!el.classList.contains('pre')) veil(el);     // left for the scroll reveal
        return;
      }
      seen[el._pi] = 1;
      if (el.classList.contains('pre')) unveil.push(el);
      if (wasVisible) {
        const dx = was.left - now.left, dy = was.top - now.top;
        if (dx || dy) {
          el.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }],
            { duration: SOFT.duration, easing: SOFT.easing });
        }
      } else {
        el.animate([{ opacity: 0, transform: 'translateY(22px) scale(.94)' }, { opacity: 1, transform: 'none' }],
          { duration: SOFT.duration, delay: Math.min(order++, 16) * 30, easing: SOFT.easing, fill: 'backwards' });
      }
    });
    // these were waiting for the observer, show them without the css transition on top
    for (const el of unveil) { el.style.transition = 'none'; el.classList.remove('pre'); revealer.unobserve(el); }
    if (unveil.length) {
      void grid.offsetWidth;
      for (const el of unveil) el.style.transition = '';
    }
  }

  function leave(el, rect) {
    if (!rect || !onScreen(rect)) return;
    const g = el.cloneNode(true);
    g.className = 'card ghost';
    g.firstElementChild.removeAttribute('style');
    g.firstElementChild.classList.remove('tilting');
    g.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px`;
    ghosts.append(g);
    g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.78)' }],
      { duration: 300, easing: 'cubic-bezier(.4,0,.8,.4)', fill: 'forwards' }).onfinish = () => g.remove();
  }

  function relayout() {
    const width = grid.clientWidth;
    if (!width || width === lastWidth) return;
    lastWidth = width;
    // keep the first visible row in place while the column count changes
    const above = -sizer.getBoundingClientRect().top;
    const anchor = rowH && above > 0 ? Math.floor(above / rowH) * cols : -1;
    measure();
    setHeight();
    if (anchor >= 0) scrollTo(0, scrollY + sizer.getBoundingClientRect().top + Math.floor(anchor / cols) * rowH);
    render(true);
    placePill(false);
    if (lbOpen) fitFrame(lbImg.naturalWidth, lbImg.naturalHeight);
  }

  function chrome() {
    bar.classList.toggle('stuck', scrollY > 4 && bar.getBoundingClientRect().top <= 0);
    toTop.classList.toggle('show', scrollY > innerHeight * 1.2);
    const span = root.scrollHeight - innerHeight;
    progress.style.transform = `scaleX(${span > 0 ? clamp(scrollY / span, 0, 1) : 0})`;
  }

  let ticking = false, lastY = 0, lastT = 0, calm = 0;
  addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(now => {
      ticking = false;
      // flung past (more than ~3 screens a second): reveal without blur or stagger
      const speed = Math.abs(scrollY - lastY) / Math.max(1, now - lastT);
      lastY = scrollY;
      lastT = now;
      if (speed > 3.2 !== flung) root.classList.toggle('fast', flung = speed > 3.2);
      clearTimeout(calm);
      if (flung) calm = setTimeout(() => root.classList.toggle('fast', flung = false), 160);
      render(false);
      chrome();
    });
  }, { passive: true });

  new ResizeObserver(relayout).observe(sizer);
  addEventListener('resize', () => {
    relayout();
    render(false);
    chrome();
    if (lbOpen) fitFrame(lbImg.naturalWidth, lbImg.naturalHeight);
  });

  /* ------------------------------------------------------------ controls */

  let searchTimer = 0;
  searchEl.addEventListener('input', () => {
    clearEl.hidden = !searchEl.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { query = searchEl.value; refresh(false); }, 90);
  });

  function clearSearch() {
    if (!searchEl.value) return;
    searchEl.value = '';
    searchEl.dispatchEvent(new Event('input'));
  }

  clearEl.addEventListener('click', () => { clearSearch(); searchEl.focus(); });
  searchEl.addEventListener('keydown', e => { if (e.key === 'Escape') clearSearch(); });

  chipsEl.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    category = chip.dataset.cat === category ? 'all' : chip.dataset.cat;
    refresh(true);
    const active = chipEls.get(category);
    chipsEl.scrollTo({
      left: active.offsetLeft - (chipsEl.clientWidth - active.offsetWidth) / 2,
      behavior: reduceMotion.matches ? 'auto' : 'smooth',
    });
  });

  // a mouse wheel over the chip row scrolls it sideways
  chipsEl.addEventListener('wheel', e => {
    if (chipsEl.scrollWidth <= chipsEl.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    chipsEl.scrollLeft += e.deltaY;
  }, { passive: false });

  toTop.addEventListener('click', () => scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' }));

  grid.addEventListener('click', e => {
    const card = e.target.closest('.card');
    if (card) openLightbox(card._pos, card);
  });

  /* ------------------------------------------------------------ mouse extras: magnet, tilt, cursor */

  const fancy = () => mouse.matches && !reduceMotion.matches;

  // chips lean towards the cursor and spring back when it leaves
  let held = null, heldX = 0, heldY = 0;

  function letGo() {
    if (!held) return;
    for (const el of [held, pill]) {
      el.classList.remove('magnet');
      el.style.removeProperty('--mx');
      el.style.removeProperty('--my');
    }
    held = null;
    heldX = heldY = 0;
  }

  chipsEl.addEventListener('pointermove', e => {
    const chip = e.pointerType === 'mouse' && fancy() ? e.target.closest('.chip') : null;
    if (chip !== held) letGo();
    if (!chip) return;
    held = chip;
    const r = chip.getBoundingClientRect();        // already shifted by the last pull, so undo that
    heldX = clamp((e.clientX - (r.left - heldX + r.width / 2)) * .3, -12, 12);
    heldY = clamp((e.clientY - (r.top - heldY + r.height / 2)) * .45, -7, 7);
    for (const el of chip.dataset.cat === category ? [chip, pill] : [chip]) {
      el.classList.add('magnet');
      el.style.setProperty('--mx', `${heldX.toFixed(1)}px`);
      el.style.setProperty('--my', `${heldY.toFixed(1)}px`);
    }
  });
  chipsEl.addEventListener('pointerleave', letGo);

  // cards tilt in 3d towards the cursor while a soft light follows it across the photo
  let tilt = null;

  function endTilt() {
    if (!tilt) return;
    cancelAnimationFrame(tilt.raf);
    tilt.el.classList.remove('tilting');
    tilt.el.style.transform = '';
    tilt = null;
  }

  function tiltFrame() {
    const t = tilt;
    if (!t) return;
    t.x += (t.tx - t.x) * .16;
    t.y += (t.ty - t.y) * .16;
    t.el.style.transform = `perspective(900px) rotateX(${((.5 - t.y) * 11).toFixed(2)}deg) `
      + `rotateY(${((t.x - .5) * 13).toFixed(2)}deg) translate3d(0,-6px,0) scale(1.02)`;
    t.glare.style.transform = `translate3d(${(t.x * t.w).toFixed(1)}px,${(t.y * t.h).toFixed(1)}px,0)`;
    t.raf = Math.abs(t.tx - t.x) + Math.abs(t.ty - t.y) > .002 ? requestAnimationFrame(tiltFrame) : 0;
  }

  grid.addEventListener('pointermove', e => {
    const inner = e.pointerType === 'mouse' && fancy() ? e.target.closest('.card-inner') : null;
    if (tilt && tilt.el !== inner) endTilt();
    if (!inner) return;
    const r = inner.parentNode.getBoundingClientRect();   // the wrapper never rotates, so this stays steady
    if (!tilt) {
      tilt = { el: inner, glare: inner.querySelector('.glare'), x: .5, y: .5, raf: 0 };
      inner.classList.add('tilting');
    }
    tilt.w = r.width;
    tilt.h = r.height;
    tilt.tx = clamp((e.clientX - r.left) / r.width, 0, 1);
    tilt.ty = clamp((e.clientY - r.top) / r.height, 0, 1);
    if (!tilt.raf) tilt.raf = requestAnimationFrame(tiltFrame);
  });
  grid.addEventListener('pointerleave', endTilt);

  // a small dot follows the mouse and opens up over cards; touch screens keep none
  if (fancy()) {
    let cx = 0, cy = 0, tx = 0, ty = 0, raf = 0, shown = false;
    const frame = () => {
      cx += (tx - cx) * .32;
      cy += (ty - cy) * .32;
      cursor.style.transform = `translate3d(${cx.toFixed(1)}px,${cy.toFixed(1)}px,0)`;
      raf = Math.abs(tx - cx) + Math.abs(ty - cy) > .1 ? requestAnimationFrame(frame) : 0;
    };
    const hide = () => { shown = false; cursor.classList.remove('on'); };
    root.classList.add('has-cursor');
    addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse') return;
      tx = e.clientX;
      ty = e.clientY;
      if (!shown) {
        shown = true;
        cx = tx;
        cy = ty;
        root.classList.add('has-cursor');
        cursor.classList.add('on');
      }
      const el = e.target instanceof Element ? e.target : null;
      const card = !!el && !!el.closest('.card-inner');
      cursor.classList.toggle('is-card', card);
      cursor.classList.toggle('is-text', !!el && !!el.closest('.search') && !el.closest('.clear'));
      cursor.classList.toggle('is-link', !card && !!el && !!el.closest('button, .lb-frame'));
      if (!raf) raf = requestAnimationFrame(frame);
    }, { passive: true });
    addEventListener('pointerdown', () => cursor.classList.add('is-down'));
    addEventListener('pointerup', () => cursor.classList.remove('is-down'));
    root.addEventListener('pointerleave', hide);
    // a finger on a hybrid laptop: give the system cursor back until the mouse moves again
    addEventListener('touchstart', () => { hide(); root.classList.remove('has-cursor'); }, { passive: true });
  }

  /* ------------------------------------------------------------ lightbox */

  let lbOpen = false, lbPos = 0, lbToken = 0, lbPending = false;
  let lifted = null, lastFocus = null, drag = null;

  function fitFrame(nw, nh) {
    nw = nw || 600;
    nh = nh || 600;
    const narrow = innerWidth < 600;
    // small sources are not stretched past 1.3x, so they stay sharp
    const maxW = Math.min(innerWidth - (narrow ? 24 : 180), nw * 1.3, 780);
    const maxH = Math.min(innerHeight - (narrow ? 240 : 180), nh * 1.3);
    const s = Math.max(.1, Math.min(maxW / nw, maxH / nh));
    lbFrame.style.width = `${Math.round(nw * s)}px`;
    lbFrame.style.height = `${Math.round(nh * s)}px`;
  }

  function setCaption() {
    const p = products[view[lbPos]];
    const at = document.createElement('b');
    at.textContent = fmt.format(lbPos + 1);
    lbName.textContent = p.name;
    lbSub.replaceChildren(at, ` / ${fmt.format(view.length)}  ·  ${label(p.category)}`);
  }

  function preload(pos) {
    if (view.length < 2) return;
    new Image().src = products[view[(pos + view.length) % view.length]].image;
  }

  // the frame flies between the card's photo and its place in the lightbox on a spring
  function zoom(thumb, closing, startTransform) {
    const a = thumb.getBoundingClientRect(), b = lbFrame.getBoundingClientRect();
    const atCard = `translate(${a.left - b.left}px,${a.top - b.top}px) scale(${a.width / b.width},${a.height / b.height})`;
    return closing
      ? lbFrame.animate([{ transform: startTransform || 'none' }, { transform: atCard }],
          { duration: 360, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'forwards' })
      : lbFrame.animate([{ transform: atCard }, { transform: 'none' }], { duration: SOFT.duration, easing: SOFT.easing });
  }

  function dropLift() {
    if (lifted) lifted.classList.remove('lifted');
    lifted = null;
  }

  function openLightbox(pos, card) {
    if (lbOpen || lb.classList.contains('closing')) return;
    lbOpen = true;
    lbPos = pos;
    lastFocus = document.activeElement;
    endTilt();
    cursor.classList.remove('is-card');
    const cardImg = card && card.querySelector('img');
    lbImg.src = products[view[pos]].image;
    fitFrame(cardImg && cardImg.naturalWidth, cardImg && cardImg.naturalHeight);
    setCaption();
    lb.hidden = false;
    root.classList.add('lb-lock');
    void lb.offsetWidth;
    lb.classList.add('open');
    if (card && !reduceMotion.matches) {
      zoom(card.querySelector('.thumb'), false);
      lifted = card;
      card.classList.add('lifted');
    }
    $('#lb-close').focus({ preventScroll: true });
    preload(pos + 1);
    preload(pos - 1);
  }

  // scroll the grid behind the lightbox so the current product's card exists to fly back to
  function ensureVisible(pos) {
    const top = scrollY + sizer.getBoundingClientRect().top + Math.floor(pos / cols) * rowH;
    const barH = bar.offsetHeight, cardH = rowH - gap;
    if (top < scrollY + barH + 8 || top + cardH > scrollY + innerHeight - 8) {
      scrollTo(0, Math.max(0, top - barH - Math.max(16, (innerHeight - barH - cardH) / 2)));
    }
    veilNew = false;
    render(true);
    veilNew = true;
    for (const el of grid.children) {
      const hidden = el.classList.contains('pre');
      if (!onScreen(el.getBoundingClientRect())) {
        if (!hidden && !seen[el._pi]) veil(el);
        continue;
      }
      seen[el._pi] = 1;
      if (!hidden) continue;
      el.style.transition = 'none';
      el.classList.remove('pre');
      revealer.unobserve(el);
      requestAnimationFrame(() => { el.style.transition = ''; });
    }
  }

  function closeLightbox() {
    if (!lbOpen) return;
    lbOpen = false;
    lbToken++;
    lbPending = false;
    const startTransform = lbFrame.style.transform;
    lbFrame.getAnimations().forEach(a => a.cancel());
    lbFrame.style.transform = '';
    lbFrame.style.opacity = '';
    lbBackdrop.style.opacity = '';
    ensureVisible(lbPos);
    const card = live.get(view[lbPos]);
    lb.classList.add('closing');
    lb.classList.remove('open');

    const done = () => {
      lb.hidden = true;
      lb.classList.remove('closing');
      lbFrame.getAnimations().forEach(a => a.cancel());
      root.classList.remove('lb-lock');
      dropLift();
      const back = card ? card.firstElementChild : lastFocus;
      if (back && back.isConnected) back.focus({ preventScroll: true });
    };

    if (card && !reduceMotion.matches) {
      dropLift();
      lifted = card;
      card.classList.add('lifted');
      zoom(card.querySelector('.thumb'), true, startTransform).onfinish = done;
    } else {
      lbFrame.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' }).onfinish = done;
    }
  }

  // arrows and sideways swipes: the old photo slides out one way, the new one springs in from the other
  async function go(dir, fromX = 0) {
    if (!lbOpen || view.length < 2) return;
    const token = ++lbToken;
    const motion = !reduceMotion.matches;
    dropLift();
    lbPos = (lbPos + dir + view.length) % view.length;
    const src = products[view[lbPos]].image;
    setCaption();

    lbFrame.getAnimations().forEach(a => a.cancel());
    lbFrame.style.transform = '';
    let out = null;
    if (lbPending || !motion) {
      lbFrame.style.opacity = '0';                    // an earlier step already slid the photo out
    } else {
      lbFrame.style.opacity = '';
      out = lbFrame.animate(
        [{ transform: `translateX(${fromX}px)`, opacity: 1 - Math.min(.5, Math.abs(fromX) / 600) },
         { transform: `translateX(${fromX - dir * 110}px)`, opacity: 0 }],
        { duration: 160, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
    }
    lbPending = true;

    const next = new Image();
    next.src = src;
    await Promise.all([next.decode().catch(() => {}), out]);
    if (token !== lbToken || !lbOpen) return;

    lbPending = false;
    lbImg.src = src;
    fitFrame(next.naturalWidth, next.naturalHeight);
    lbFrame.getAnimations().forEach(a => a.cancel());
    lbFrame.style.opacity = '';
    if (motion) {
      lbFrame.animate([{ transform: `translateX(${dir * 130}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
        { duration: SOFT.duration, easing: SOFT.easing });
    }
    preload(lbPos + dir);
  }

  $('#lb-close').addEventListener('click', closeLightbox);
  $('#lb-prev').addEventListener('click', () => go(-1));
  $('#lb-next').addEventListener('click', () => go(1));

  // swipe / drag: sideways changes product, down closes, a tap outside the photo closes
  lb.addEventListener('pointerdown', e => {
    if (!lbOpen || e.button > 0 || e.target.closest('button')) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dy: 0, axis: null,
             t: performance.now(), inside: !!e.target.closest('.lb-stage') };
    lb.setPointerCapture(e.pointerId);
  });

  lb.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dx = e.clientX - drag.x;
    drag.dy = e.clientY - drag.y;
    if (!drag.axis) {
      if (Math.hypot(drag.dx, drag.dy) < 8) return;
      drag.axis = Math.abs(drag.dx) >= Math.abs(drag.dy) ? 'x' : 'y';
      if (!lbPending) lbFrame.getAnimations().forEach(a => a.cancel());
    }
    if (drag.axis === 'x') {
      lbFrame.style.transform = `translateX(${drag.dx}px)`;
      lbFrame.style.opacity = String(1 - Math.min(.5, Math.abs(drag.dx) / 600));
    } else {
      // pulled down: the photo follows and shrinks about its centre, the backdrop thins out
      const dy = Math.max(0, drag.dy), s = 1 - Math.min(.3, dy / 900);
      const w = lbFrame.offsetWidth, h = lbFrame.offsetHeight;
      lbFrame.style.transform = `translate(${(1 - s) * w / 2}px,${dy + (1 - s) * h / 2}px) scale(${s})`;
      lbBackdrop.style.opacity = String(1 - Math.min(.7, dy / 380));
    }
  });

  function endDrag(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    const released = e.type === 'pointerup';
    if (!d.axis) {
      if (released && !d.inside) closeLightbox();
      return;
    }
    const flick = performance.now() - d.t < 280;
    if (released && d.axis === 'x' && view.length > 1 && (Math.abs(d.dx) > 90 || (flick && Math.abs(d.dx) > 28))) {
      go(d.dx < 0 ? 1 : -1, d.dx);
    } else if (released && d.axis === 'y' && (d.dy > 110 || (flick && d.dy > 40))) {
      closeLightbox();
    } else {
      const from = lbFrame.style.transform;
      lbFrame.style.transform = '';
      lbFrame.style.opacity = '';
      lbBackdrop.style.opacity = '';
      if (from && !reduceMotion.matches) {
        lbFrame.animate([{ transform: from }, { transform: 'none' }], { duration: SNAPPY.duration, easing: SNAPPY.easing });
      }
    }
  }

  lb.addEventListener('pointerup', endDrag);
  lb.addEventListener('pointercancel', endDrag);

  addEventListener('keydown', e => {
    if (lbOpen) {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'Tab') {
        const stops = [...lb.querySelectorAll('button')];
        const i = stops.indexOf(document.activeElement);
        stops[(i + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
      } else return;
      e.preventDefault();
    } else if (e.key === '/' && document.activeElement !== searchEl) {
      e.preventDefault();
      searchEl.focus();
    }
  });

  /* ------------------------------------------------------------ start */

  // the tally next to the title counts up once the letters have landed
  function countUp(total) {
    if (reduceMotion.matches) { tallyEl.textContent = fmt.format(total); return; }
    tallyEl.textContent = '0';
    const begin = performance.now() + 820, length = 900;
    const step = now => {
      const k = clamp((now - begin) / length, 0, 1);
      tallyEl.textContent = fmt.format(Math.round(total * (1 - Math.pow(1 - k, 3))));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  loadProducts().then(list => {
    products = list.filter(p => p && p.name && p.image);
    folded = products.map(p => fold(p.name));
    seen = new Uint8Array(products.length);
    buildChips();
    computeView();
    placePill(false);
    subEl.textContent = `Ρούχα, παπούτσια και αξεσουάρ σε ${chipEls.size - 1} κατηγορίες.`;
    countUp(products.length);
    lastWidth = grid.clientWidth;
    measure();
    setHeight();
    render(true);
    chrome();
    document.fonts.ready.then(() => placePill(false));
  }).catch(() => {
    statusEl.textContent = 'Δεν βρέθηκε το products.json. Τρέξε πρώτα: python scrape.py';
  });
})();
