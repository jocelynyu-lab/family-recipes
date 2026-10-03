(function () {
  "use strict";

  const MEMBER_KEY = "family-recipes:member";
  const RATING_KEY = "family-recipes:ratings";
  const LEVELS = { 1: "簡單", 2: "要一點耐心", 3: "請大人一起做" };
  const ALL = "全部";

  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const state = {
    member: readMember(),
    query: "",
    cat: ALL,
    ratings: {},
    openId: null,
    checked: {}, // recipeId -> Set of ingredient indexes
    store: null,
  };

  // ---------- helpers ----------
  function readMember() {
    try {
      const id = localStorage.getItem(MEMBER_KEY);
      return FAMILY.some((m) => m.id === id) ? id : null;
    } catch (e) { return null; }
  }
  function saveMember(id) { try { localStorage.setItem(MEMBER_KEY, id); } catch (e) {} }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("無法載入 " + src));
      document.head.appendChild(s);
    });
  }

  // ---------- rating storage ----------
  function localStore() {
    const read = () => {
      try { return JSON.parse(localStorage.getItem(RATING_KEY)) || {}; } catch (e) { return {}; }
    };
    let listener = () => {};
    return {
      shared: false,
      subscribe(fn) { listener = fn; fn(read()); },
      async set(rid, mid, val) {
        const all = read();
        all[rid] = Object.assign({}, all[rid], { [mid]: val });
        localStorage.setItem(RATING_KEY, JSON.stringify(all));
        listener(all);
      },
    };
  }

  async function firebaseStore(cfg) {
    const v = "10.12.2";
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore-compat.js`);
    firebase.initializeApp(cfg);
    const col = firebase.firestore().collection("ratings");
    return {
      shared: true,
      subscribe(fn) {
        col.onSnapshot(
          (snap) => {
            const all = {};
            snap.forEach((d) => { all[d.id] = d.data(); });
            fn(all);
          },
          (err) => {
            console.error(err);
            toast("評分沒辦法同步，請檢查 Firebase 設定");
          }
        );
      },
      set(rid, mid, val) { return col.doc(rid).set({ [mid]: val }, { merge: true }); },
    };
  }

  async function makeStore() {
    const cfg = window.FIREBASE_CONFIG;
    if (cfg && cfg.apiKey && cfg.projectId) {
      try { return await firebaseStore(cfg); }
      catch (e) {
        console.error(e);
        toast("連不上 Firebase，評分先存在這台裝置");
      }
    }
    return localStore();
  }

  // ---------- scores ----------
  function scoreOf(rid) {
    const r = state.ratings[rid] || {};
    const vals = FAMILY.map((m) => r[m.id]).filter((v) => typeof v === "number" && v >= 1 && v <= 5);
    if (!vals.length) return null;
    return { avg: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length };
  }
  const starString = (n) => "★".repeat(n) + "☆".repeat(5 - n);

  // ---------- render ----------
  function renderWho() {
    $("#who-list").innerHTML = FAMILY.map(
      (m) => `<button type="button" class="who-btn" data-member="${esc(m.id)}" aria-pressed="${m.id === state.member}">
        <span class="face" aria-hidden="true">${esc(m.emoji)}</span>${esc(m.name)}</button>`
    ).join("");
  }

  function renderChips() {
    const cats = [ALL, ...new Set(RECIPES.map((r) => r.category).filter(Boolean))];
    $("#chips").innerHTML = cats
      .map((c) => `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="${c === state.cat}">${esc(c)}</button>`)
      .join("");
  }

  function matches(r) {
    if (state.cat !== ALL && r.category !== state.cat) return false;
    const q = state.query.trim();
    if (!q) return true;
    const hay = [r.title, r.from, r.category, ...(r.ingredients || [])].join(" ");
    return hay.includes(q);
  }

  function cardHTML(r) {
    const s = scoreOf(r.id);
    const pic = r.image ? `<img class="card-img" src="${esc(r.image)}" alt="" loading="lazy">` : "";
    const score = s
      ? `<span class="st" aria-hidden="true">${starString(Math.round(s.avg))}</span> ${s.avg.toFixed(1)}（${s.n} 人評分）`
      : `<span class="none">還沒有人評分</span>`;
    return `<button type="button" class="card" data-open="${esc(r.id)}">
      ${pic}
      <span class="card-head"><span class="card-emoji" aria-hidden="true">${esc(r.emoji)}</span><span class="card-title">${esc(r.title)}</span></span>
      <span class="card-body">
        <span class="card-from">${esc(r.from)}的拿手菜</span>
        <span class="card-meta"><span>⏱ ${esc(r.time)} 分鐘</span><span>難度：${esc(LEVELS[r.level] || "")}</span></span>
        <span class="card-score">${score}</span>
      </span>
    </button>`;
  }

  function renderGrid() {
    const list = RECIPES.filter(matches);
    $("#grid").innerHTML = list.map(cardHTML).join("");
    $("#empty").hidden = list.length > 0;
  }

  function renderDetail() {
    const r = RECIPES.find((x) => x.id === state.openId);
    if (!r) return;

    // keep focus on the same star after re-render
    const focusedStar = document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.star : null;

    const rr = state.ratings[r.id] || {};
    const me = FAMILY.find((m) => m.id === state.member);
    const mine = me ? rr[me.id] : null;
    const checked = state.checked[r.id] || new Set();

    const top = r.image
      ? `<img class="d-img" src="${esc(r.image)}" alt="${esc(r.title)}">`
      : `<div class="d-emoji" aria-hidden="true">${esc(r.emoji)}</div>`;

    const rating = me
      ? `<p class="rate-who">${esc(me.emoji)} ${esc(me.name)}的評分</p>
         <div class="stars" role="group" aria-label="${esc(me.name)}的評分">
           ${[1, 2, 3, 4, 5].map((n) =>
             `<button type="button" class="star${mine >= n ? " on" : ""}" data-star="${n}" aria-label="${n} 顆星" aria-pressed="${mine === n}">★</button>`
           ).join("")}
         </div>`
      : `<p class="rate-need">先在最上面點選你是誰，就可以打分數了。</p>`;

    $("#detail-body").innerHTML = `
      <button type="button" class="close" data-close aria-label="關閉">✕</button>
      ${top}
      <h2 id="d-title" class="d-title">${esc(r.title)}</h2>
      <p class="d-meta">
        <span>${esc(r.from)}的拿手菜</span>
        <span>⏱ ${esc(r.time)} 分鐘</span>
        <span>難度：${esc(LEVELS[r.level] || "")}</span>
        ${r.serves ? `<span>${esc(r.serves)} 人份</span>` : ""}
      </p>

      <h3>要準備的材料</h3>
      <ul class="ing">
        ${(r.ingredients || []).map((x, i) =>
          `<li><label><input type="checkbox" data-ing="${i}"${checked.has(i) ? " checked" : ""}><span>${esc(x)}</span></label></li>`
        ).join("")}
      </ul>

      <h3>怎麼做</h3>
      <ol class="steps">${(r.steps || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ol>

      ${r.tip ? `<p class="tip"><strong>小撇步：</strong>${esc(r.tip)}</p>` : ""}

      <section class="rate">
        <h3>你覺得好吃嗎？</h3>
        ${rating}
        <ul class="family-scores">
          ${FAMILY.map((m) => {
            const v = rr[m.id];
            return `<li><span aria-hidden="true">${esc(m.emoji)}</span> ${esc(m.name)}
              ${v ? `<span class="fs" aria-label="${v} 顆星">${starString(v)}</span>` : `<span class="fs none">還沒評</span>`}</li>`;
          }).join("")}
        </ul>
      </section>`;

    if (focusedStar) {
      const btn = $(`#detail-body [data-star="${focusedStar}"]`);
      if (btn) btn.focus();
    }
  }

  function renderAll() {
    renderGrid();
    if (state.openId) renderDetail();
  }

  // ---------- open / close ----------
  function openRecipe(id) {
    if (!RECIPES.some((r) => r.id === id)) return;
    state.openId = id;
    renderDetail();
    const dlg = $("#detail");
    if (!dlg.open) dlg.showModal();
    dlg.scrollTop = 0;
    history.replaceState(null, "", "#" + encodeURIComponent(id));
  }

  // ---------- events ----------
  function bind() {
    $("#who-list").addEventListener("click", (e) => {
      const b = e.target.closest("[data-member]");
      if (!b) return;
      state.member = b.dataset.member;
      saveMember(state.member);
      renderWho();
      if (state.openId) renderDetail();
      const m = FAMILY.find((x) => x.id === state.member);
      toast(`嗨，${m.name}！`);
    });

    $("#chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-cat]");
      if (!b) return;
      state.cat = b.dataset.cat;
      renderChips();
      renderGrid();
    });

    $("#q").addEventListener("input", (e) => {
      state.query = e.target.value;
      renderGrid();
    });

    $("#grid").addEventListener("click", (e) => {
      const b = e.target.closest("[data-open]");
      if (b) openRecipe(b.dataset.open);
    });

    const dlg = $("#detail");
    dlg.addEventListener("click", async (e) => {
      if (e.target === dlg || e.target.closest("[data-close]")) { dlg.close(); return; }
      const star = e.target.closest("[data-star]");
      if (star && state.member && state.openId) {
        const val = Number(star.dataset.star);
        try {
          await state.store.set(state.openId, state.member, val);
          toast(`給了 ${val} 顆星，謝謝！`);
        } catch (err) {
          console.error(err);
          toast("評分沒有存成功，等一下再試一次");
        }
      }
    });
    dlg.addEventListener("change", (e) => {
      const box = e.target.closest("[data-ing]");
      if (!box || !state.openId) return;
      const set = state.checked[state.openId] || (state.checked[state.openId] = new Set());
      const i = Number(box.dataset.ing);
      box.checked ? set.add(i) : set.delete(i);
    });
    dlg.addEventListener("close", () => {
      const id = state.openId;
      state.openId = null;
      history.replaceState(null, "", location.pathname + location.search);
      const card = id && document.querySelector(`[data-open="${CSS.escape(id)}"]`);
      if (card) card.focus();
    });
  }

  // ---------- start ----------
  async function start() {
    renderWho();
    renderChips();
    renderGrid();
    bind();

    state.store = await makeStore();
    $("#sync").textContent = state.store.shared
      ? "評分會同步給全家人。"
      : "評分目前存在這台裝置上。";
    state.store.subscribe((all) => {
      state.ratings = all || {};
      renderAll();
    });

    const fromHash = decodeURIComponent(location.hash.slice(1));
    if (fromHash) openRecipe(fromHash);
  }

  start();
})();
