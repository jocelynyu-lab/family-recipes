(function () {
  "use strict";

  const MEMBER_KEY = "family-recipes:member";
  const RATING_KEY = "family-recipes:ratings";
  const LEVELS = { 1: "簡單", 2: "要一點耐心", 3: "請大人一起做" };
  const ALL = "全部";
  const NOTE_MAX = 200;
  const WISH_KEY = "family-recipes:wishes";
  const REVIEW_KEY = "family-recipes:reviews";
  const MEAL_KEY = "family-recipes:meals";
  const CUSTOM_KEY = "family-recipes:custom-recipes";
  const SLOTS = [["breakfast", "早餐"], ["lunch", "午餐"], ["dinner", "晚餐"]];
  const REVIEW_SHOW = 8; // 評分紀錄一開始顯示幾筆
  const WISH_TEXT_MAX = 30;
  const WISH_PER_DAY = 3; // 每個人同一天最多幾個願望（Firestore 規則也要一起改）

  const $ = (s) => document.querySelector(s);
  // 英文名字後面接中文時補一個空格，例如「Ethan 想吃」
  const nm = (n) => (/[A-Za-z0-9]$/.test(String(n)) ? n + " " : n);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const state = {
    member: readMember(),
    query: "",
    tags: new Set(), // 目前選的篩選標籤
    ratings: {},
    openId: null,
    checked: {}, // recipeId -> Set of ingredient indexes
    drafts: {},  // recipeId -> 還沒送出的評語草稿
    wishes: [],  // 許願清單
    reviews: [], // 每一次的評分紀錄（同一人可以評很多次）
    meals: [],   // 月曆上排好的料理
    custom: [],  // 爸媽在網站上新增的食譜
    view: "home",
    calMonth: null,
    calSel: null,
    showAll: {}, // recipeId -> 是否展開全部紀錄
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

  // recipes.js 的食譜 + 網站上新增的食譜
  // 資料庫（Firestore）裡的食譜為主；recipes.js 裡還沒匯入的食譜也會一起顯示
  function allRecipes() {
    const ids = new Set(state.custom.map((x) => x.id));
    const fileOnly = (typeof RECIPES !== "undefined" ? RECIPES : []).filter((r) => !ids.has(r.id));
    return state.custom.concat(fileOnly);
  }
  // 還沒存進資料庫的 recipes.js 食譜
  function pendingImport() {
    const ids = new Set(state.custom.map((x) => x.id));
    return (typeof RECIPES !== "undefined" ? RECIPES : []).filter((r) => !ids.has(r.id));
  }
  // 把一道食譜整理成資料庫要的格式
  function recipeData(r, overrides) {
    const int = (v, lo, hi, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
    const data = {
      title: String(r.title || "").slice(0, 40),
      subtitle: String(r.subtitle || "").slice(0, 80),
      tags: tagsOf(r).map(String).slice(0, 10),
      time: int(r.time, 1, 600, 30),
      level: [1, 2, 3].includes(r.level) ? r.level : 1,
      serves: int(r.serves, 1, 30, 3),
      icon: String(r.icon || "cooking-pot").slice(0, 40),
      ingredients: (r.ingredients || []).map((x) => String(x).slice(0, 100)).slice(0, 40),
      steps: (r.steps || []).map((x) => (typeof x === "string" ? x : (x && x.text) || "")).filter(Boolean).map((x) => x.slice(0, 300)).slice(0, 30),
      tip: String(r.tip || "").slice(0, 200),
      from: String(r.from || "").slice(0, 20),
      by: state.member,
      at: Date.now(),
    };
    if (r.image) data.image = String(r.image).slice(0, 200);
    if (r.color) data.color = String(r.color).slice(0, 20);
    return Object.assign(data, overrides || {});
  }

  // ---------- dates ----------
  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); }
  function dateLabel(s) {
    if (s === addDays(0)) return "今天";
    if (s === addDays(1)) return "明天";
    if (s === addDays(2)) return "後天";
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return `${m}/${d}（週${"日一二三四五六"[dt.getDay()]}）`;
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
    let wishListener = () => {};
    let mealListener = () => {};
    let customListener = () => {};
    let reviewListener = () => {};
    return {
      shared: false,
      subscribe(fn) { listener = fn; fn(read()); },
      async set(rid, mid, val) {
        const all = read();
        all[rid] = Object.assign({}, all[rid], { [mid]: val });
        localStorage.setItem(RATING_KEY, JSON.stringify(all));
        listener(all);
      },
      // ---- 許願 ----
      // ---- 評分紀錄 ----
      subscribeReviews(fn) { reviewListener = fn; fn(readR()); },
      async addReview(v) {
        const all = readR();
        all.push(Object.assign({ id: "r" + Date.now() + Math.random().toString(36).slice(2, 6) }, v));
        writeR(all);
      },
      async deleteReview(id) { writeR(readR().filter((v) => v.id !== id)); },
      // ---- 月曆 ----
      subscribeMeals(fn) { mealListener = fn; fn(readK(MEAL_KEY)); },
      async addMeal(m) {
        const all = readK(MEAL_KEY);
        all.push(Object.assign({ id: "m" + Date.now() + Math.random().toString(36).slice(2, 6) }, m));
        writeK(MEAL_KEY, all, mealListener);
      },
      async deleteMeal(id) { writeK(MEAL_KEY, readK(MEAL_KEY).filter((x) => x.id !== id), mealListener); },
      // ---- 網站上新增的食譜 ----
      subscribeCustom(fn) { customListener = fn; fn(readK(CUSTOM_KEY)); },
      async saveRecipe(id, data) {
        const all = readK(CUSTOM_KEY).filter((x) => x.id !== id);
        all.push(Object.assign({ id }, data));
        writeK(CUSTOM_KEY, all, customListener);
      },
      async deleteRecipe(id) { writeK(CUSTOM_KEY, readK(CUSTOM_KEY).filter((x) => x.id !== id), customListener); },
      subscribeWishes(fn) { wishListener = fn; fn(readW()); },
      async addWish(w, id) {
        const all = readW();
        if (all.some((x) => x.id === id)) throw new Error("slot taken");
        all.push(Object.assign({ id }, w));
        writeW(all);
      },
      async updateWish(id, patch) {
        writeW(readW().map((w) => (w.id === id ? Object.assign({}, w, patch) : w)));
      },
      async deleteWish(id) { writeW(readW().filter((w) => w.id !== id)); },
    };
    function readW() {
      try {
        return JSON.parse(localStorage.getItem(WISH_KEY)) || [];
      } catch (e) { return []; }
    }
    function writeW(all) { localStorage.setItem(WISH_KEY, JSON.stringify(all)); wishListener(all); }
    function readK(key) {
      try { return JSON.parse(localStorage.getItem(key)) || []; } catch (e) { return []; }
    }
    function writeK(key, all, fn) { localStorage.setItem(key, JSON.stringify(all)); fn(all); }
    function readR() {
      try { return JSON.parse(localStorage.getItem(REVIEW_KEY)) || []; } catch (e) { return []; }
    }
    function writeR(all) { localStorage.setItem(REVIEW_KEY, JSON.stringify(all)); reviewListener(all); }
  }

  async function firebaseStore(cfg) {
    const v = "10.12.2";
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-auth-compat.js`);
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore-compat.js`);
    firebase.initializeApp(cfg);
    const auth = firebase.auth();
    const col = firebase.firestore().collection("ratings");
    const wcol = firebase.firestore().collection("wishes");
    const rcol = firebase.firestore().collection("reviews");
    const mcol = firebase.firestore().collection("meals");
    const ccol = firebase.firestore().collection("recipes");
    let mealListener = () => {};
    let customListener = () => {};
    let extraUnsubs = [];
    let cunsub = null;
    // 訂閱一個集合，轉成陣列交給 fn
    const watch = (col, fn, label) => col.onSnapshot(
      (snap) => { const arr = []; snap.forEach((d) => arr.push(Object.assign({ id: d.id }, d.data()))); fn(arr); },
      (err) => { console.error(err); toast(label + "沒辦法讀取，請檢查 Firebase 規則設定"); }
    );
    let reviewListener = () => {};
    let runsub = null;
    let listener = () => {};
    let wishListener = () => {};
    let unsub = null;
    let wunsub = null;
    return {
      shared: true,
      subscribe(fn) { listener = fn; },
      // 登入狀態改變時：登入才讀評分，登出就清空
      onUser(fn) {
        auth.onAuthStateChanged((user) => {
          if (unsub) { unsub(); unsub = null; }
          if (wunsub) { wunsub(); wunsub = null; }
          if (runsub) { runsub(); runsub = null; }
          extraUnsubs.forEach((u) => u());
          extraUnsubs = [];
          // 食譜：登入前後都讀（規則設成公開時，沒登入也看得到）
          if (cunsub) { cunsub(); cunsub = null; }
          cunsub = ccol.onSnapshot(
            (snap) => { const arr = []; snap.forEach((d) => arr.push(Object.assign({ id: d.id }, d.data()))); customListener(arr); },
            (err) => {
              customListener([]);
              if (user) { console.error(err); toast("食譜沒辦法讀取，請檢查 Firebase 規則設定"); }
            }
          );
          if (user) {
            unsub = col.onSnapshot(
              (snap) => {
                const all = {};
                snap.forEach((d) => { all[d.id] = d.data(); });
                listener(all);
              },
              (err) => {
                console.error(err);
                toast("評分沒辦法讀取，請檢查 Firebase 規則設定");
              }
            );
            runsub = rcol.onSnapshot(
              (snap) => {
                const arr = [];
                snap.forEach((d) => arr.push(Object.assign({ id: d.id }, d.data())));
                reviewListener(arr);
              },
              (err) => {
                console.error(err);
                toast("評分紀錄沒辦法讀取，請檢查 Firebase 規則設定");
              }
            );
            extraUnsubs.push(watch(mcol, (a) => mealListener(a), "月曆"));
            wunsub = wcol.onSnapshot(
              (snap) => {
                const arr = [];
                snap.forEach((d) => arr.push(Object.assign({ id: d.id }, d.data())));
                wishListener(arr);
              },
              (err) => {
                console.error(err);
                toast("許願清單沒辦法讀取，請檢查 Firebase 規則設定");
              }
            );
          } else {
            listener({});
            wishListener([]);
            reviewListener([]);
            mealListener([]);
          }
          fn(user);
        });
      },
      signIn(email, pw) { return auth.signInWithEmailAndPassword(email, pw); },
      signOut() { return auth.signOut(); },
      set(rid, mid, val) { return col.doc(rid).set({ [mid]: val }, { merge: true }); },
      subscribeWishes(fn) { wishListener = fn; },
      subscribeReviews(fn) { reviewListener = fn; },
      addReview(v) { return rcol.add(v); },
      deleteReview(id) { return rcol.doc(id).delete(); },
      subscribeMeals(fn) { mealListener = fn; },
      addMeal(m) { return mcol.add(m); },
      deleteMeal(id) { return mcol.doc(id).delete(); },
      subscribeCustom(fn) { customListener = fn; },
      saveRecipe(id, data) { return ccol.doc(id).set(data); },
      deleteRecipe(id) { return ccol.doc(id).delete(); },
      // 用「日期_成員_編號」當文件 id，Firestore 規則就能限制一天最多 3 個
      addWish(w, id) { return wcol.doc(id).set(w); },
      updateWish(id, patch) { return wcol.doc(id).update(patch); },
      deleteWish(id) { return wcol.doc(id).delete(); },
    };
  }

  function authMessage(err) {
    const code = (err && err.code) || "";
    if (/invalid-credential|wrong-password|user-not-found|invalid-email/.test(code)) return "密碼不對，再試一次。";
    if (/too-many-requests/.test(code)) return "試太多次了，休息幾分鐘再試。";
    if (/network/.test(code)) return "網路好像斷了，檢查一下再試。";
    return "登入失敗，請大人幫忙看看。";
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
  // 每人每道菜一則：{ stars: 1~5, note: "評語", at: 時間 }（相容舊版只有數字的資料）
  function reviewOf(v) {
    if (typeof v === "number") return { stars: v, note: "", at: 0 };
    if (v && typeof v === "object") {
      return { stars: Number(v.stars) || 0, note: typeof v.note === "string" ? v.note : "", at: Number(v.at) || 0 };
    }
    return null;
  }
  // 某道菜的全部評分紀錄（新到舊）。舊版「每人一則」的資料也會一起列出來
  function reviewsOf(rid) {
    const out = [];
    const legacy = state.ratings[rid] || {};
    FAMILY.forEach((m) => {
      const rv = reviewOf(legacy[m.id]);
      if (rv && rv.stars >= 1 && rv.stars <= 5) {
        out.push({ id: `old-${rid}-${m.id}`, legacy: true, recipe: rid, member: m.id,
          stars: rv.stars, note: rv.note, date: rv.at ? ymd(new Date(rv.at)) : "", at: rv.at });
      }
    });
    state.reviews.forEach((v) => {
      if (v.recipe === rid && FAMILY.some((m) => m.id === v.member) && v.stars >= 1 && v.stars <= 5) out.push(v);
    });
    return out.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.at || 0) - (a.at || 0));
  }
  function avgOf(list) { return list.reduce((a, b) => a + b.stars, 0) / list.length; }
  function scoreOf(rid) {
    const list = reviewsOf(rid);
    if (!list.length) return null;
    return { avg: avgOf(list), n: list.length, notes: list.filter((x) => (x.note || "").trim()).length };
  }
  function dayLabel(d) {
    if (!d) return "";
    if (d === addDays(0)) return "今天";
    if (d === addDays(-1)) return "昨天";
    const [y, m, dd] = d.split("-").map(Number);
    return y === new Date().getFullYear() ? `${m}/${dd}` : `${y}/${m}/${dd}`;
  }
  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" }) : "");
  const starString = (n) => "★".repeat(n) + "☆".repeat(5 - n);

  // ---------- render ----------
  function renderWho() {
    $("#who-list").innerHTML = FAMILY.map(
      (m) => `<button type="button" class="who-btn" data-member="${esc(m.id)}" aria-pressed="${m.id === state.member}">
        ${avatar(m, "face")}${esc(m.name)}</button>`
    ).join("") + (needsLogin() && state.member ? `<button type="button" class="logout" data-logout>登出</button>` : "");
  }

  const needsLogin = () => !!(state.store && state.store.shared);

  const ICON = {
    time: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
    level: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V14M12 20V9M19 20V4"/></svg>',
  };
  // 每個標籤的代表色（圖示顏色）；卡片底色會自動用它調淡
  const TAG_COLOR = {
    早餐: "#c27803", 湯品: "#1d6fb8", 豬肉: "#d0465c", 牛肉: "#a2471f", 雞肉: "#d9731a",
    蔬菜: "#2f8a4c", 中式: "#c9352b", 西式: "#6a4bc4", 日式: "#c2416f",
    海鮮: "#0f7f86", 蔬食: "#2f8a4c", 麵食: "#b26b12", 點心: "#b03a8c",
  };
  // 舊格式相容：只有 category 的食譜，當成一個標籤
  const tagsOf = (r) => (Array.isArray(r.tags) ? r.tags : r.category ? [r.category] : []);
  // 食譜的顏色：recipes.js 有寫 color 就用它，否則依 TAG_GROUPS 的順序找第一個有顏色的標籤
  function colorOf(r) {
    if (r.color) return r.color;
    const rt = tagsOf(r);
    for (const g of tagGroups()) for (const t of g.tags) if (rt.includes(t) && TAG_COLOR[t]) return TAG_COLOR[t];
    return "#13305f";
  }
  function tint(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return `rgba(19,48,95,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const phColor = (r) => tint(colorOf(r), 0.12);

  // Lucide 圖示（icons.js）；找不到圖示時退回 emoji
  function svgIcon(name, cls) {
    const inner = typeof ICONS !== "undefined" ? ICONS[name] : null;
    if (!inner) return "";
    return `<svg class="lc${cls ? " " + cls : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  }
  const recipeGlyph = (r, cls) => svgIcon(r.icon, cls) || esc(r.emoji || "");
  // 家人頭像：有色圓底＋圖示
  function avatar(m, cls) {
    const color = m.color || "#13305f";
    const inner = svgIcon(m.icon) || esc(m.emoji || (m.name || "?").slice(0, 1));
    return `<span class="av${cls ? " " + cls : ""}" style="--av:${color};--av-bg:${tint(color, 0.14)}" aria-hidden="true">${inner}</span>`;
  }

  // 篩選分組：recipes.js 的 TAG_GROUPS，加上沒被分組的標籤
  function tagGroups() {
    const groups = (typeof TAG_GROUPS !== "undefined" ? TAG_GROUPS : []).map((g) => ({ name: g.name, tags: g.tags.slice() }));
    const known = new Set(groups.flatMap((g) => g.tags));
    const extra = [...new Set(allRecipes().flatMap(tagsOf))].filter((t) => !known.has(t));
    if (extra.length) groups.push({ name: "其他", tags: extra });
    return groups;
  }

  function media(r, cls) {
    return r.image
      ? `<img src="${esc(r.image)}" alt="${cls === "d" ? esc(r.title) : ""}" loading="lazy">`
      : `<span class="ph" style="--ph:${phColor(r)};color:${colorOf(r)}" aria-hidden="true">${recipeGlyph(r, "ph-ic")}</span>`;
  }

  function renderChips() {
    const groups = tagGroups();
    const count = (t) => allRecipes().filter((r) => tagsOf(r).includes(t)).length;
    $("#chips").innerHTML = groups.map((g) => `
      <div class="fgroup" role="group" aria-label="${esc(g.name)}">
        <span class="fgroup-name">${esc(g.name)}</span>
        <div class="fchips">
          ${g.tags.map((t) => `<button type="button" class="fchip" data-tag="${esc(t)}" aria-pressed="${state.tags.has(t)}">${esc(t)}<span class="fcount">${count(t)}</span></button>`).join("")}
        </div>
      </div>`).join("") +
      (state.tags.size ? `<button type="button" class="fclear" data-clear-tags>清除篩選</button>` : "");
  }

  function matches(r) {
    const rt = tagsOf(r);
    // 同組 OR、跨組 AND
    for (const g of tagGroups()) {
      const picked = g.tags.filter((t) => state.tags.has(t));
      if (picked.length && !picked.some((t) => rt.includes(t))) return false;
    }
    const q = state.query.trim();
    if (!q) return true;
    const hay = [r.title, r.subtitle, r.from, ...rt, ...(r.ingredients || [])].join(" ");
    return hay.includes(q);
  }

  function scoreHTML(s) {
    if (needsLogin() && !state.member) return `<span class="score-none">登入後看評分</span>`;
    return s
      ? `<span class="ico"><span class="st" aria-hidden="true">★</span>${s.avg.toFixed(1)}（${s.n} 次）</span>`
      : `<span class="score-none">還沒有人評分</span>`;
  }

  function noteCount(rid) {
    if (needsLogin() && !state.member) return "";
    const s = scoreOf(rid);
    return s && s.notes ? `<span class="ico" aria-label="${s.notes} 則評語">${ICON.note}${s.notes}</span>` : "";
  }

  function cardHTML(r) {
    return `<button type="button" class="card" data-open="${esc(r.id)}">
      <span class="media">${media(r)}${tagsOf(r).length ? `<span class="badges">${tagsOf(r).slice(0, 3).map((t) => `<span class="badge">${esc(t)}</span>`).join("")}</span>` : ""}</span>
      <span class="card-title">${esc(r.title)}</span>
      ${r.subtitle ? `<span class="card-sub">${esc(r.subtitle)}</span>` : ""}
      <span class="card-meta">
        <span class="ico">${ICON.time}${esc(r.time)} 分鐘</span>
        <span class="ico">${ICON.level}${esc(LEVELS[r.level] || "")}</span>
        ${scoreHTML(scoreOf(r.id))}
        ${noteCount(r.id)}
      </span>
    </button>`;
  }

  function renderAdmin() {
    const box = $("#admin-bar");
    if (!box) return;
    const parent = isEditorNow();
    const pend = pendingImport();
    $("#new-recipe").hidden = !parent;
    box.hidden = !(parent && pend.length);
    if (!box.hidden) {
      box.innerHTML = `<p><strong>recipes.js 裡還有 ${pend.length} 道食譜沒有存進資料庫。</strong>匯入後就能直接在網站上編輯，id 不變，所以評分、願望和月曆都會接得上。</p>
        <button type="button" class="btn" data-import>全部匯入</button>`;
    }
  }

  function renderGrid() {
    renderAdmin();
    const list = allRecipes().filter(matches);
    $("#grid").innerHTML = list.map(cardHTML).join("");
    $("#empty").hidden = list.length > 0;
    $("#count").textContent = list.length ? `共 ${list.length} 道菜` : "";
  }

  function renderDetail() {
    const r = allRecipes().find((x) => x.id === state.openId);
    if (!r) return;

    // 重新畫面時保留焦點與正在打字的位置
    const ae = document.activeElement;
    const focusedStar = ae && ae.dataset ? ae.dataset.star : null;
    const noteFocus = ae && ae.id === "note" ? [ae.selectionStart, ae.selectionEnd] : null;
    const dateFocus = ae && ae.id === "rv-date";

    const reviews = reviewsOf(r.id);
    const me = FAMILY.find((m) => m.id === state.member);
    const isParent = !!(me && me.parent);
    const today = ymd(new Date());
    const draft = state.drafts[r.id] || { stars: 0, note: "", date: today };
    const checked = state.checked[r.id] || new Set();
    const s = scoreOf(r.id);

    const rating = me
      ? `<p class="rate-who">${avatar(me, "av-sm")} ${esc(me.name)}，記錄這次吃起來的感覺</p>
         <div class="rv-form">
           <label class="note-label" for="rv-date">哪一天吃的？</label>
           <input id="rv-date" class="f-input rv-date-in" type="date" max="${today}" value="${esc(draft.date)}">
           <span class="note-label rv-stars-label">幾顆星？</span>
           <div class="stars" role="group" aria-label="這次的評分">
             ${[1, 2, 3, 4, 5].map((n) =>
               `<button type="button" class="star${draft.stars >= n ? " on" : ""}" data-star="${n}" aria-label="${n} 顆星" aria-pressed="${draft.stars === n}">★</button>`
             ).join("")}
           </div>
           <label for="note" class="note-label">想說的話（可以不寫）</label>
           <textarea id="note" maxlength="${NOTE_MAX}" rows="3" placeholder="例如：這次比較鹹，下次少放一點醬油。">${esc(draft.note)}</textarea>
           <div class="note-foot">
             <span class="note-count" id="note-count">${draft.note.length} / ${NOTE_MAX}</span>
             <button type="button" class="btn note-send" data-save-review>送出這次的評分</button>
           </div>
         </div>`
      : `<p class="rate-need">${needsLogin() ? "先點最上面你的頭像登入，就可以打分數、寫評語，也能看全家的紀錄。" : "先在最上面點選你是誰，就可以打分數、寫評語了。"}</p>`;

    const canSee = !(needsLogin() && !me);
    const perMember = FAMILY.map((m) => {
      const mine = reviews.filter((v) => v.member === m.id);
      return mine.length ? `<li>${avatar(m, "av-xs")} ${esc(m.name)}
        <span class="st" aria-hidden="true">★</span>${avgOf(mine).toFixed(1)}<span class="pm-n">（${mine.length} 次）</span></li>` : "";
    }).join("");
    const shown = state.showAll[r.id] ? reviews : reviews.slice(0, REVIEW_SHOW);
    const reviewList = !canSee ? "" : !reviews.length ? `<p class="rv-empty-all">還沒有人評分，來當第一個吧！</p>` : `
      <div class="rv-sum">
        <p class="rv-avg"><span class="st" aria-hidden="true">★</span> <strong>${s.avg.toFixed(1)}</strong> 全家平均（共 ${s.n} 次評分）</p>
        <ul class="pm">${perMember}</ul>
      </div>
      <h4 class="rv-h">評分紀錄</h4>
      <ul class="reviews">
        ${shown.map((v) => {
          const m = FAMILY.find((x) => x.id === v.member);
          const canDel = !v.legacy && (v.member === state.member || isParent);
          return `<li class="rv">
            <div class="rv-head">
              ${avatar(m, "rv-face")}
              <span class="rv-name">${esc(m.name)}</span>
              <span class="st" aria-label="${v.stars} 顆星">${starString(v.stars)}</span>
              <span class="rv-date">${v.date ? esc(dayLabel(v.date)) + "吃的" : ""}</span>
              ${canDel ? `<button type="button" class="mini rv-del" data-del-review="${esc(v.id)}" aria-label="刪除這筆評分">刪除</button>` : ""}
            </div>
            ${v.note ? `<p class="rv-note">${esc(v.note)}</p>` : ""}
          </li>`;
        }).join("")}
      </ul>
      ${reviews.length > REVIEW_SHOW ? `<button type="button" class="fclear rv-more" data-more-reviews>${state.showAll[r.id] ? "收起來" : `看全部 ${reviews.length} 筆紀錄`}</button>` : ""}`;

    const steps = (r.steps || []).map((st) => {
      const o = typeof st === "string" ? { text: st } : st || {};
      return `<li>${o.image ? `<img class="s-img" src="${esc(o.image)}" alt="" loading="lazy">` : ""}
        <div class="s-row"><p>${esc(o.text)}</p></div></li>`;
    }).join("");

    $("#detail-body").innerHTML = `
      <button type="button" class="close" data-close>關閉 ✕</button>
      <div class="d-top">
        <div class="d-media">${media(r, "d")}</div>
        <div class="d-info">
          ${r.from ? `<span class="d-from">${esc(nm(r.from))}的拿手菜</span>` : ""}
          <h2 id="d-title" class="d-title">${esc(r.title)}</h2>
          ${r.subtitle ? `<p class="d-sub">${esc(r.subtitle)}</p>` : ""}
          ${tagsOf(r).length ? `<div class="d-tags">${tagsOf(r).map((t) => `<button type="button" class="d-tag" data-filter-tag="${esc(t)}" aria-label="看所有「${esc(t)}」的食譜">${esc(t)}</button>`).join("")}</div>` : ""}
          <dl class="d-stats">
            <div><dt>時間</dt><dd>${esc(r.time)} 分鐘</dd></div>
            <div><dt>份量</dt><dd>${r.serves ? esc(r.serves) + " 人份" : "—"}</dd></div>
            <div><dt>難度</dt><dd>${esc(LEVELS[r.level] || "—")}</dd></div>
          </dl>
          <p class="d-avg">${scoreHTML(s)}</p>
          <button type="button" class="btn wish-this" data-wish-recipe="${esc(r.id)}">想吃這道，許願！</button>
          ${isEditorNow() ? `<div class="re-acts">
            <button type="button" class="mini" data-edit-recipe="${esc(r.id)}">編輯食譜</button>
            ${r.custom ? `<button type="button" class="mini" data-del-recipe="${esc(r.id)}">刪除食譜</button>` : ""}
          </div>` : ""}
        </div>
      </div>

      <div class="d-body">
        <section class="sec">
          <h3 class="sec-h">食材</h3>
          <ul class="ing">
            ${(r.ingredients || []).map((x, i) =>
              `<li><label><input type="checkbox" data-ing="${i}"${checked.has(i) ? " checked" : ""}><span>${esc(x)}</span></label></li>`
            ).join("")}
          </ul>
        </section>

        <section class="sec">
          <h3 class="sec-h">步驟</h3>
          <ol class="steps">${steps}</ol>
          ${r.tip ? `<p class="tip"><strong>小撇步　</strong>${esc(r.tip)}</p>` : ""}
        </section>

        <section class="rate">
          <h3 class="sec-h">好吃嗎？</h3>
          ${rating}
          ${reviewList}
        </section>
      </div>`;

    if (focusedStar) {
      const btn = $(`#detail-body [data-star="${focusedStar}"]`);
      if (btn) btn.focus();
    }
    if (noteFocus) {
      const ta = $("#note");
      if (ta) { ta.focus(); ta.setSelectionRange(noteFocus[0], noteFocus[1]); }
    }
    if (dateFocus && $("#rv-date")) $("#rv-date").focus();
  }

  // ---------- wish list ----------
  function renderWishes() {
    const box = $("#wish-list");
    if (needsLogin() && !state.member) {
      box.innerHTML = `<p class="wish-empty">登入後就能看到大家的願望，也能許願。</p>`;
      return;
    }
    const today = ymd(new Date());
    const list = state.wishes
      .filter((w) => w.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.at || 0) - (b.at || 0));
    if (!list.length) {
      box.innerHTML = `<p class="wish-empty">還沒有人許願。想吃什麼？點「我要許願」告訴大家。</p>`;
      return;
    }
    const me = FAMILY.find((x) => x.id === state.member);
    const isParent = !!(me && me.parent);
    const days = [];
    list.forEach((w) => {
      let g = days[days.length - 1];
      if (!g || g.date !== w.date) days.push((g = { date: w.date, items: [] }));
      g.items.push(w);
    });
    box.innerHTML = days.map((g) => `
      <section class="wish-day${g.date === today ? " is-today" : ""}">
        <h3 class="wish-date">${esc(dateLabel(g.date))}</h3>
        <ul class="wish-items">
          ${g.items.map((w) => {
            const m = FAMILY.find((x) => x.id === w.member) || { name: "?", icon: "smile" };
            const r = w.recipeId && allRecipes().find((x) => x.id === w.recipeId);
            const dish = r
              ? `<button type="button" class="wish-dish is-link" data-open="${esc(r.id)}"><span class="wd-ic" style="color:${colorOf(r)}">${recipeGlyph(r)}</span>${esc(r.title)}</button>`
              : `<span class="wish-dish">${esc(w.text)}</span>`;
            // 爸媽答應後，許願的人就不能自己刪掉；爸媽隨時都能刪
            const canDel = isParent || (w.member === state.member && !w.granted);
            // 右側狀態：爸媽看到可以按的「答應／已答應」，其他人看到綠色標籤
            const status = isParent
              ? (w.granted
                ? `<button type="button" class="mini mini-ok" data-grant="${esc(w.id)}" aria-pressed="true" title="再按一次可以取消答應">✓ 已答應</button>`
                : `<button type="button" class="mini mini-solid" data-grant="${esc(w.id)}" aria-pressed="false">答應</button>`)
              : (w.granted ? `<span class="mini mini-ok is-tag">✓ 爸媽答應了</span>` : "");
            return `<li class="wish${w.granted ? " granted" : ""}">
              <div class="wish-person">
                ${avatar(m, "wish-face")}
                <span class="wish-pname">${esc(m.name)}</span>
              </div>
              <div class="wish-main">
                <span class="wish-line"><span class="wish-verb">想吃</span>${dish}</span>
              </div>
              <div class="wish-acts">
                ${status}
                ${canDel ? `<button type="button" class="mini" data-del-wish="${esc(w.id)}" aria-label="刪除${esc(m.name)}的願望">刪除</button>` : ""}
              </div>
            </li>`;
          }).join("")}
        </ul>
      </section>`).join("");
  }

  function openWish(recipeId) {
    if (!state.member) {
      toast(needsLogin() ? "先點最上面你的頭像登入，才能許願" : "先在最上面選你是誰，才能許願");
      return;
    }
    const sel = $("#wish-dish");
    state.wishTag = "";
    renderWishTags();
    fillWishOptions(recipeId || "");
    $("#wish-text").value = "";
    $("#wish-text").hidden = true;
    setWhen("today");
    const d = $("#wish-date");
    d.min = ymd(new Date());
    d.value = addDays(0);
    $("#wish-err").textContent = "";
    $("#wish").showModal();
    (recipeId ? $("#wish-go") : sel).focus();
  }
  // 許願表單：用標籤縮小菜單
  const OTHER = "__other";
  function renderWishTags() {
    const used = new Set(allRecipes().flatMap(tagsOf));
    const tags = tagGroups().flatMap((g) => g.tags).filter((t) => used.has(t));
    $("#wish-tags").innerHTML = ["", ...tags].map((t) =>
      `<button type="button" class="wtag" data-wtag="${esc(t)}" aria-pressed="${t === state.wishTag}">${t ? esc(t) : "全部"}</button>`
    ).join("") +
      `<button type="button" class="wtag wtag-other" data-wtag="${OTHER}" aria-pressed="${state.wishTag === OTHER}">＋ 其他（自己寫）</button>`;
  }
  function fillWishOptions(keep) {
    const sel = $("#wish-dish");
    const other = state.wishTag === OTHER;
    // 選「其他」時藏起菜單，改成自己輸入
    sel.hidden = other;
    $("#wish-text").hidden = !other;
    if (other) return;
    const list = allRecipes().filter((r) => !state.wishTag || tagsOf(r).includes(state.wishTag));
    sel.innerHTML = `<option value="">選一道菜…（${list.length} 道）</option>` +
      list.map((r) => `<option value="${esc(r.id)}">${esc(r.title)}</option>`).join("");
    sel.value = list.some((r) => r.id === keep) ? keep : "";
  }

  function setWhen(v) {
    state.when = v;
    document.querySelectorAll("#wish-when [data-when]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.when === v)));
    $("#wish-date").hidden = v !== "pick";
  }

  function renderAll() {
    renderGrid();
    renderWishes();
    renderCalendar();
    renderRanking();
    if (state.openId) renderDetail();
  }

  // ---------- open / close ----------
  function openRecipe(id) {
    if (!allRecipes().some((r) => r.id === id)) return;
    state.openId = id;
    renderDetail();
    const dlg = $("#detail");
    if (!dlg.open) dlg.showModal();
    dlg.scrollTop = 0;
    history.replaceState(null, "", "#" + encodeURIComponent(id));
  }

  // ---------- views（食譜／月曆分頁） ----------
  const VIEWS = { home: "", cal: "#calendar", rank: "#ranking" };
  const viewHash = () => VIEWS[state.view] || location.pathname + location.search;
  function setView(v) {
    state.view = v in VIEWS ? v : "home";
    $("#view-home").hidden = state.view !== "home";
    $("#view-cal").hidden = state.view !== "cal";
    $("#view-rank").hidden = state.view !== "rank";
    document.querySelectorAll("[data-view]").forEach((b) => {
      if (b.dataset.view === state.view) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    if (!state.openId) history.replaceState(null, "", viewHash());
    if (state.view === "cal") renderCalendar();
    if (state.view === "rank") renderRanking();
    window.scrollTo(0, 0);
  }

  // ---------- calendar ----------
  const isParentNow = () => { const me = FAMILY.find((m) => m.id === state.member); return !!(me && me.parent); };
  // 可以維護食譜的人：recipes.js 裡標 editor: true 的成員
  const isEditorNow = () => { const me = FAMILY.find((m) => m.id === state.member); return !!(me && me.editor); };
  const findRecipe = (id) => (id ? allRecipes().find((x) => x.id === id) : null);
  function dayItems(date) {
    return {
      meals: state.meals.filter((m) => m.date === date).sort((a, b) => (a.at || 0) - (b.at || 0)),
      wishes: state.wishes.filter((w) => w.date === date && w.granted).sort((a, b) => (a.at || 0) - (b.at || 0)),
    };
  }
  const titleOf = (x) => { const r = findRecipe(x.recipeId); return r ? r.title : x.text; };
  function dishHTML(recipeId, text, cls) {
    const r = findRecipe(recipeId);
    return r
      ? `<button type="button" class="${cls} is-link" data-open="${esc(r.id)}"><span class="wd-ic" style="color:${colorOf(r)}">${recipeGlyph(r)}</span>${esc(r.title)}</button>`
      : `<span class="${cls}">${esc(text)}</span>`;
  }

  function renderCalendar() {
    const body = $("#cal-body");
    if (!body) return;
    if (!state.calMonth) { const t = new Date(); state.calMonth = new Date(t.getFullYear(), t.getMonth(), 1); }
    if (!state.calSel) state.calSel = ymd(new Date());
    const y = state.calMonth.getFullYear(), mo = state.calMonth.getMonth();
    $("#cal-title").textContent = `${y} 年 ${mo + 1} 月`;
    if (needsLogin() && !state.member) {
      body.innerHTML = `<p class="wish-empty">登入後就能看到家裡的月曆。</p>`;
      $("#cal-day").innerHTML = "";
      return;
    }
    const startDow = new Date(y, mo, 1).getDay();
    const days = new Date(y, mo + 1, 0).getDate();
    const today = ymd(new Date());
    let cells = "";
    for (let i = 0; i < startDow; i++) cells += `<span class="cal-cell is-pad" aria-hidden="true"></span>`;
    for (let d = 1; d <= days; d++) {
      const ds = ymd(new Date(y, mo, d));
      const { meals, wishes } = dayItems(ds);
      const items = SLOTS.map(([k, label]) => meals.filter((x) => x.slot === k)
        .map((x) => `<span class="cal-item slot-${k}"><b>${label[0]}</b>${esc(titleOf(x))}</span>`).join("")).join("");
      const dots = SLOTS.map(([k]) => meals.filter((x) => x.slot === k).map(() => `<i class="dot slot-${k}"></i>`).join("")).join("");
      // 答應的願望：月曆上只放一個「願」標記，內容看右邊明細
      const wishMark = wishes.length ? `<span class="cal-wish" title="有 ${wishes.length} 個答應的願望">願</span>` : "";
      const label = [meals.length ? `${meals.length} 道菜` : "", wishes.length ? `${wishes.length} 個答應的願望` : ""].filter(Boolean).join("、");
      cells += `<button type="button" class="cal-cell${ds === today ? " is-today" : ""}${ds === state.calSel ? " is-sel" : ""}"
        data-day="${ds}" aria-pressed="${ds === state.calSel}" aria-label="${mo + 1} 月 ${d} 日${label ? `，${label}` : ""}">
        <span class="cal-head"><span class="cal-num">${d}</span>${wishMark}</span>
        <span class="cal-items">${items}</span>
        ${meals.length ? `<span class="cal-dots" aria-hidden="true">${dots}</span>` : ""}
      </button>`;
    }
    body.innerHTML = `<div class="cal-dow" aria-hidden="true">${[..."日一二三四五六"].map((x) => `<span>${x}</span>`).join("")}</div>
      <div class="cal-grid">${cells}</div>`;
    renderCalDay();
  }

  function renderCalDay() {
    const box = $("#cal-day");
    const ds = state.calSel;
    const [y, m, d] = ds.split("-").map(Number);
    const dow = "日一二三四五六"[new Date(y, m - 1, d).getDay()];
    const { meals, wishes } = dayItems(ds);
    const parent = isParentNow();
    const today = ymd(new Date());
    box.innerHTML = `
      <h3 class="cal-day-h">${m}/${d}（週${dow}）${ds === today ? `<span class="cal-today-tag">今天</span>` : ""}</h3>
      <div class="cal-slots">
        ${SLOTS.map(([k, label]) => {
          const list = meals.filter((x) => x.slot === k);
          return `<section class="cal-slot slot-${k}">
            <h4>${label}</h4>
            ${list.length ? `<ul>${list.map((x) => `<li>
                ${dishHTML(x.recipeId, x.text, "cal-dish")}
                ${parent ? `<button type="button" class="mini" data-del-meal="${esc(x.id)}" aria-label="從${label}移除${esc(titleOf(x))}">移除</button>` : ""}
              </li>`).join("")}</ul>` : `<p class="cal-none">還沒排</p>`}
            ${parent ? `<button type="button" class="cal-add" data-add-meal="${k}">＋ 新增${label}</button>` : ""}
          </section>`;
        }).join("")}
      </div>
      ${wishes.length ? `<section class="cal-wishes">
        <h4>答應的願望</h4>
        <ul>${wishes.map((w) => {
          const mm = FAMILY.find((x) => x.id === w.member) || { name: "?", icon: "smile" };
          return `<li>${avatar(mm, "av-sm")}<span class="cal-wish-who">${esc(nm(mm.name))}想吃</span>${dishHTML(w.recipeId, w.text, "cal-dish")}</li>`;
        }).join("")}</ul>
      </section>` : ""}`;
  }

  // ---------- 新增料理（爸媽） ----------
  const MEAL_OTHER = "__other";
  function openMeal(slot) {
    if (!isParentNow()) return;
    state.mealSlot = slot;
    state.mealTag = "";
    const label = (SLOTS.find((x) => x[0] === slot) || [])[1] || "";
    const [, m, d] = state.calSel.split("-").map(Number);
    $("#meal-title").textContent = `${m}/${d} ${label}要煮什麼？`;
    $("#meal-text").value = "";
    $("#meal-err").textContent = "";
    $("#meal-newrecipe").hidden = !isEditorNow();
    renderMealTags();
    fillMealOptions("");
    const dlg = $("#meal");
    if (!dlg.open) dlg.showModal();
    $("#meal-dish").focus();
  }
  function renderMealTags() {
    const used = new Set(allRecipes().flatMap(tagsOf));
    const tags = tagGroups().flatMap((g) => g.tags).filter((t) => used.has(t));
    $("#meal-tags").innerHTML = ["", ...tags].map((t) =>
      `<button type="button" class="wtag" data-mtag="${esc(t)}" aria-pressed="${t === state.mealTag}">${t ? esc(t) : "全部"}</button>`
    ).join("") + `<button type="button" class="wtag wtag-other" data-mtag="${MEAL_OTHER}" aria-pressed="${state.mealTag === MEAL_OTHER}">＋ 只寫菜名</button>`;
  }
  function fillMealOptions(keep) {
    const sel = $("#meal-dish");
    const other = state.mealTag === MEAL_OTHER;
    sel.hidden = other;
    $("#meal-text").hidden = !other;
    if (other) return;
    const list = allRecipes().filter((r) => !state.mealTag || tagsOf(r).includes(state.mealTag));
    sel.innerHTML = `<option value="">選一道菜…（${list.length} 道）</option>` +
      list.map((r) => `<option value="${esc(r.id)}">${esc(r.title)}</option>`).join("");
    sel.value = list.some((r) => r.id === keep) ? keep : "";
  }

  // ---------- 新增／編輯食譜（只有 editor） ----------
  function openRecipeEditor(id, returnToMeal) {
    if (!isEditorNow()) return;
    const r = id ? allRecipes().find((x) => x.id === id) : null;
    state.reEditId = r ? r.id : null;
    state.reReturn = !!returnToMeal;
    state.reTags = new Set(r ? tagsOf(r) : []);
    state.reLevel = r ? r.level || 1 : 1;
    $("#redit-title").textContent = r ? "編輯食譜" : "新增食譜";
    $("#re-title").value = r ? r.title : "";
    // 英文名稱就是食譜的 id：新增時填，建立後不能改（評分、願望、月曆都靠它連結）
    const idBox = $("#re-id");
    idBox.value = r ? r.id : "";
    idBox.disabled = !!r;
    $("#re-id-hint").textContent = r
      ? "建立後就不能改，評分、願望和月曆都靠它連結。"
      : "只能用小寫英文、數字和連字號，例如 nikujaga、potato-pork-stew。網址也會用到它。";
    $("#re-sub").value = r ? r.subtitle || "" : "";
    $("#re-time").value = r ? r.time || 30 : 30;
    $("#re-serves").value = r ? r.serves || 3 : 3;
    $("#re-ing").value = r ? (r.ingredients || []).join("\n") : "";
    $("#re-steps").value = r ? (r.steps || []).map((x) => (typeof x === "string" ? x : x.text)).join("\n") : "";
    $("#re-tip").value = r ? r.tip || "" : "";
    const meNow = FAMILY.find((m) => m.id === state.member);
    $("#re-from").value = r ? r.from || "" : (meNow ? meNow.name : "");
    $("#re-err").textContent = "";
    const names = typeof ICONS !== "undefined" ? Object.keys(ICONS) : [];
    $("#re-icon").innerHTML = names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    $("#re-icon").value = r && names.includes(r.icon) ? r.icon : (names.includes("cooking-pot") ? "cooking-pot" : names[0] || "");
    renderReTags();
    renderReLevel();
    renderReIcon();
    if ($("#meal").open) $("#meal").close();
    $("#redit").showModal();
    $("#redit").scrollTop = 0;
    $("#re-title").focus();
  }
  function renderReTags() {
    $("#re-tags").innerHTML = tagGroups().flatMap((g) => g.tags).map((t) =>
      `<button type="button" class="wtag" data-retag="${esc(t)}" aria-pressed="${state.reTags.has(t)}">${esc(t)}</button>`
    ).join("");
  }
  function renderReLevel() {
    document.querySelectorAll("#re-level [data-level]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.level) === state.reLevel)));
  }
  function renderReIcon() {
    const r = { icon: $("#re-icon").value, tags: [...state.reTags] };
    $("#re-icon-prev").innerHTML = svgIcon(r.icon) ;
    $("#re-icon-prev").style.color = colorOf(r);
    $("#re-icon-prev").style.background = tint(colorOf(r), 0.12);
  }
  const lines = (v) => v.split("\n").map((x) => x.trim()).filter(Boolean);
  // 英文名稱 → id：轉小寫，空白和底線變連字號，去掉其他符號
  const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const slugify = (v) => String(v || "").toLowerCase().trim()
    .replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");

  // ---------- 排名 ----------
  const PERIODS = [["month", "本月"], ["3m", "近 3 個月"], ["year", "今年"], ["all", "全部"]];
  function periodStart(p) {
    const t = new Date();
    if (p === "month") return ymd(new Date(t.getFullYear(), t.getMonth(), 1));
    if (p === "3m") return ymd(new Date(t.getFullYear(), t.getMonth() - 2, 1));
    if (p === "year") return `${t.getFullYear()}-01-01`;
    return "";
  }
  // 依「食譜 id，沒有的話用菜名」分組計數
  function groupBy(list, fn) {
    const map = new Map();
    list.forEach((x) => {
      const key = x.recipeId ? "r:" + x.recipeId : "t:" + (x.text || "").trim();
      if (key === "t:") return;
      if (!map.has(key)) map.set(key, { key, recipeId: x.recipeId || "", text: x.text || "", items: [] });
      map.get(key).items.push(x);
    });
    return [...map.values()].map(fn);
  }
  function rankList(rows, valueOf, max, empty, same) {
    if (!rows.length) return `<p class="rk-empty">${empty}</p>`;
    // 同分同名次（例如 1、1、3）
    const ranks = [];
    rows.forEach((row, i) => { ranks[i] = i > 0 && same(rows[i - 1], row) ? ranks[i - 1] : i + 1; });
    return `<ol class="rk-list">${rows.map((row, i) => {
      const no = ranks[i];
      const r = findRecipe(row.recipeId);
      const name = r ? r.title : row.text;
      const color = r ? colorOf(r) : "#697284";
      const ic = r ? recipeGlyph(r) : svgIcon("utensils");
      const pct = max ? Math.max(4, Math.round((row.bar / max) * 100)) : 0;
      return `<li class="rk-row${no <= 3 ? " rk-top rk-top" + no : ""}">
        <span class="rk-no">${no}</span>
        <span class="rk-ic" style="color:${color};background:${tint(color, 0.12)}" aria-hidden="true">${ic}</span>
        <span class="rk-main">
          ${r ? `<button type="button" class="rk-name is-link" data-open="${esc(r.id)}">${esc(name)}</button>` : `<span class="rk-name">${esc(name)}</span>`}
          <span class="rk-bar" aria-hidden="true"><i style="width:${pct}%;background:${color}"></i></span>
          ${row.extra || ""}
        </span>
        <span class="rk-val">${valueOf(row)}</span>
      </li>`;
    }).join("")}</ol>`;
  }
  function whoHTML(items) {
    const ids = [...new Set(items.map((x) => x.member))];
    return `<span class="rk-who">${ids.map((id) => {
      const m = FAMILY.find((x) => x.id === id);
      return m ? avatar(m, "av-xs") : "";
    }).join("")}</span>`;
  }

  function renderRanking() {
    const box = $("#rank-grid");
    if (!box) return;
    if (!state.rankPeriod) state.rankPeriod = "all";
    $("#rank-period").innerHTML = PERIODS.map(([k, label]) =>
      `<button type="button" data-period="${k}" aria-pressed="${k === state.rankPeriod}">${label}</button>`).join("");
    if (needsLogin() && !state.member) {
      $("#rank-kpi").innerHTML = "";
      box.innerHTML = `<p class="wish-empty">登入後就能看到全家的排名。</p>`;
      return;
    }
    const start = periodStart(state.rankPeriod);
    const inRange = (d) => !start || (d && d >= start);

    // 評分：每道菜的平均星星
    const allReviews = [];
    const rating = allRecipes().map((r) => {
      const list = reviewsOf(r.id).filter((v) => inRange(v.date));
      allReviews.push(...list);
      return list.length ? { recipeId: r.id, text: r.title, avg: avgOf(list), n: list.length, bar: avgOf(list) } : null;
    }).filter(Boolean).sort((a, b) => b.avg - a.avg || b.n - a.n).slice(0, 10);

    // 上桌：月曆出現次數
    const meals = state.meals.filter((m) => inRange(m.date));
    const served = groupBy(meals, (g) => ({ ...g, n: g.items.length, bar: g.items.length }))
      .sort((a, b) => b.n - a.n).slice(0, 10);

    // 許願：被許願的次數
    const wishes = state.wishes.filter((w) => inRange(w.date));
    const wished = groupBy(wishes, (g) => ({ ...g, n: g.items.length, bar: g.items.length, extra: whoHTML(g.items) }))
      .sort((a, b) => b.n - a.n).slice(0, 10);

    // 答應：爸媽答應的次數與答應率
    const granted = groupBy(wishes, (g) => {
      const ok = g.items.filter((w) => w.granted);
      return { ...g, n: ok.length, total: g.items.length, bar: ok.length, extra: ok.length ? whoHTML(ok) : "" };
    }).filter((g) => g.n > 0).sort((a, b) => b.n - a.n || b.n / b.total - a.n / a.total).slice(0, 10);

    const okCount = wishes.filter((w) => w.granted).length;
    const allAvg = allReviews.length ? avgOf(allReviews).toFixed(1) : "–";
    $("#rank-kpi").innerHTML = [
      ["評分", `${allReviews.length}`, `次・平均 ★ ${allAvg}`],
      ["上桌", `${meals.length}`, "道菜"],
      ["許願", `${wishes.length}`, "個願望"],
      ["答應率", wishes.length ? `${Math.round((okCount / wishes.length) * 100)}%` : "–", `${okCount} / ${wishes.length}`],
    ].map(([k, v, u]) => `<div class="kpi"><dt>${k}</dt><dd><strong>${v}</strong><span>${u}</span></dd></div>`).join("");

    const max = (rows) => rows.reduce((m, r) => Math.max(m, r.bar), 0);
    box.innerHTML = `
      <section class="rk-card">
        <h3>評分最高</h3>
        <p class="rk-sub">平均星星，同分時評分次數多的排前面</p>
        ${rankList(rating, (r) => `<span class="st">★</span> ${r.avg.toFixed(1)}<small>${r.n} 次</small>`, 5, "這段期間還沒有人評分。",
          (a, b) => a.avg.toFixed(1) === b.avg.toFixed(1) && a.n === b.n)}
      </section>
      <section class="rk-card">
        <h3>最常上桌</h3>
        <p class="rk-sub">月曆上出現的次數</p>
        ${rankList(served, (r) => `${r.n}<small>次</small>`, max(served), "這段期間月曆上還沒有排菜。", (a, b) => a.n === b.n)}
      </section>
      <section class="rk-card">
        <h3>最多人許願</h3>
        <p class="rk-sub">被許願的次數，旁邊是許過願的人</p>
        ${rankList(wished, (r) => `${r.n}<small>次</small>`, max(wished), "這段期間還沒有人許願。", (a, b) => a.n === b.n)}
      </section>
      <section class="rk-card">
        <h3>爸媽答應最多</h3>
        <p class="rk-sub">答應的次數和答應率</p>
        ${rankList(granted, (r) => `${r.n}<small>${Math.round((r.n / r.total) * 100)}%</small>`, max(granted), "這段期間還沒有答應的願望。",
          (a, b) => a.n === b.n && a.n * b.total === b.n * a.total)}
      </section>`;
  }

  // ---------- login ----------
  function openLogin(id) {
    const m = FAMILY.find((x) => x.id === id);
    if (!m) return;
    if (!m.email) { toast(`${m.name}還沒有帳號，請大人到 recipes.js 設定 email`); return; }
    state.loginId = id;
    $("#login-face").innerHTML = avatar(m, "av-lg");
    $("#login-title").textContent = `${m.name}，請輸入密碼`;
    $("#login-email").value = m.email;
    $("#login-pw").value = "";
    $("#login-err").textContent = "";
    $("#login").showModal();
    $("#login-pw").focus();
  }

  // 綁定事件；找不到元素時只在主控台提醒，不讓整個網站停擺
  function on(sel, ev, fn) {
    const el = $(sel);
    if (!el) { console.warn("找不到 " + sel + "，請確認 index.html 是最新版"); return; }
    el.addEventListener(ev, fn);
  }

  // ---------- events ----------
  function bind() {
    on("#who-list", "click", (e) => {
      if (e.target.closest("[data-logout]")) {
        state.store.signOut().then(() => toast("已登出"));
        return;
      }
      const b = e.target.closest("[data-member]");
      if (!b) return;
      if (needsLogin()) {
        if (b.dataset.member !== state.member) openLogin(b.dataset.member);
        return;
      }
      state.member = b.dataset.member;
      saveMember(state.member);
      renderWho();
      renderAll();
      const m = FAMILY.find((x) => x.id === state.member);
      toast(`嗨，${m.name}！`);
    });

    const login = $("#login");
    on("#login-form", "submit", async (e) => {
      e.preventDefault();
      const m = FAMILY.find((x) => x.id === state.loginId);
      const pw = $("#login-pw").value;
      const btn = $("#login-go");
      if (!m || !pw) return;
      btn.disabled = true;
      $("#login-err").textContent = "";
      try {
        await state.store.signIn(m.email, pw);
        login.close();
        toast(`嗨，${m.name}！`);
      } catch (err) {
        console.error(err);
        $("#login-err").textContent = authMessage(err);
        $("#login-pw").select();
      } finally {
        btn.disabled = false;
      }
    });
    on("#login-cancel", "click", () => login.close());

    // ---- 許願 ----
    on("#make-wish", "click", () => openWish(""));
    on("#wish-tags", "click", (e) => {
      const b = e.target.closest("[data-wtag]");
      if (!b) return;
      state.wishTag = b.dataset.wtag;
      renderWishTags();
      fillWishOptions($("#wish-dish").value);
      $("#wish-err").textContent = "";
      if (state.wishTag === OTHER) { $("#wish-text").focus(); return; }
      const again = $(`#wish-tags [data-wtag="${CSS.escape(state.wishTag)}"]`);
      if (again) again.focus();
    });
    on("#wish-when", "click", (e) => {
      const b = e.target.closest("[data-when]");
      if (!b) return;
      setWhen(b.dataset.when);
      if (b.dataset.when === "pick") $("#wish-date").focus();
    });
    on("#wish-cancel", "click", () => $("#wish").close());
    on("#wish-form", "submit", async (e) => {
      e.preventDefault();
      const err = $("#wish-err");
      const other = state.wishTag === OTHER;
      const r = other ? null : allRecipes().find((x) => x.id === $("#wish-dish").value);
      const text = other ? $("#wish-text").value.trim().slice(0, WISH_TEXT_MAX) : (r ? r.title : "");
      if (other && !text) { err.textContent = "寫下想吃的菜名。"; $("#wish-text").focus(); return; }
      if (!other && !r) { err.textContent = "選一道想吃的菜，或點「其他」自己寫。"; $("#wish-dish").focus(); return; }
      const date = state.when === "today" ? addDays(0)
        : state.when === "tomorrow" ? addDays(1)
        : $("#wish-date").value;
      if (!date || date < ymd(new Date())) { err.textContent = "選今天或之後的日期。"; return; }
      const used = new Set(state.wishes.map((x) => x.id));
      const count = state.wishes.filter((x) => x.member === state.member && x.date === date).length;
      const slot = [...Array(WISH_PER_DAY).keys()].map((i) => `${date}_${state.member}_${i + 1}`).find((id) => !used.has(id));
      if (count >= WISH_PER_DAY || !slot) {
        err.textContent = `${dateLabel(date)}已經許了 ${WISH_PER_DAY} 個願望囉，換一天吧！`;
        return;
      }
      const btn = $("#wish-go");
      btn.disabled = true;
      try {
        await state.store.addWish({
          member: state.member, date, recipeId: r ? r.id : "", text, at: Date.now(), granted: false,
        }, slot);
        $("#wish").close();
        toast(`許願成功！${dateLabel(date)}想吃${text}`);
      } catch (ex) {
        console.error(ex);
        err.textContent = "許願沒有送出，等一下再試一次。";
      } finally {
        btn.disabled = false;
      }
    });
    on("#wish-list", "click", async (e) => {
      const open = e.target.closest("[data-open]");
      if (open) { openRecipe(open.dataset.open); return; }
      const g = e.target.closest("[data-grant]");
      if (g) {
        const w = state.wishes.find((x) => x.id === g.dataset.grant);
        if (!w) return;
        try {
          await state.store.updateWish(w.id, { granted: !w.granted });
          toast(w.granted ? "已取消答應" : "答應了！");
        } catch (ex) { console.error(ex); toast("沒有更新成功，等一下再試一次"); }
        return;
      }
      const d = e.target.closest("[data-del-wish]");
      if (d && confirm("確定要刪除這個願望嗎？")) {
        try { await state.store.deleteWish(d.dataset.delWish); toast("已刪除"); }
        catch (ex) { console.error(ex); toast("沒有刪除成功，等一下再試一次"); }
      }
    });

    // ---- 分頁 ----
    document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault();
      setView(b.dataset.view);
    }));

    // ---- 月曆 ----
    const shiftMonth = (n) => {
      const t = new Date();
      if (n === 0) state.calMonth = new Date(t.getFullYear(), t.getMonth(), 1);
      else state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + n, 1);
      const sameMonth = state.calMonth.getFullYear() === t.getFullYear() && state.calMonth.getMonth() === t.getMonth();
      state.calSel = sameMonth ? ymd(t) : ymd(state.calMonth);
      renderCalendar();
    };
    on("#rank-period", "click", (e) => {
      const b = e.target.closest("[data-period]");
      if (!b) return;
      state.rankPeriod = b.dataset.period;
      renderRanking();
      const again = $(`#rank-period [data-period="${state.rankPeriod}"]`);
      if (again) again.focus();
    });
    on("#rank-grid", "click", (e) => {
      const b = e.target.closest("[data-open]");
      if (b) openRecipe(b.dataset.open);
    });
    on("#cal-prev", "click", () => shiftMonth(-1));
    on("#cal-next", "click", () => shiftMonth(1));
    on("#cal-today", "click", () => shiftMonth(0));
    on("#cal-body", "click", (e) => {
      const c = e.target.closest("[data-day]");
      if (!c) return;
      state.calSel = c.dataset.day;
      renderCalendar();
      const again = $(`#cal-body [data-day="${state.calSel}"]`);
      if (again) again.focus();
      const panel = $("#cal-day");
      const rect = panel.getBoundingClientRect();
      if (rect.top > window.innerHeight - 80) panel.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    on("#cal-day", "click", async (e) => {
      const open = e.target.closest("[data-open]");
      if (open) { openRecipe(open.dataset.open); return; }
      const add = e.target.closest("[data-add-meal]");
      if (add) { openMeal(add.dataset.addMeal); return; }
      const del = e.target.closest("[data-del-meal]");
      if (del && confirm("確定要從月曆移除這道菜嗎？")) {
        try { await state.store.deleteMeal(del.dataset.delMeal); toast("已移除"); }
        catch (ex) { console.error(ex); toast("沒有移除成功，等一下再試一次"); }
      }
    });

    // ---- 新增料理 ----
    on("#meal-tags", "click", (e) => {
      const b = e.target.closest("[data-mtag]");
      if (!b) return;
      state.mealTag = b.dataset.mtag;
      renderMealTags();
      fillMealOptions($("#meal-dish").value);
      $("#meal-err").textContent = "";
      if (state.mealTag === MEAL_OTHER) { $("#meal-text").focus(); return; }
      const again = $(`#meal-tags [data-mtag="${CSS.escape(state.mealTag)}"]`);
      if (again) again.focus();
    });
    on("#meal-cancel", "click", () => $("#meal").close());
    on("#meal-newrecipe", "click", () => openRecipeEditor(null, true));
    on("#meal-form", "submit", async (e) => {
      e.preventDefault();
      const err = $("#meal-err");
      const other = state.mealTag === MEAL_OTHER;
      const r = other ? null : findRecipe($("#meal-dish").value);
      const text = other ? $("#meal-text").value.trim().slice(0, 40) : (r ? r.title : "");
      if (other && !text) { err.textContent = "寫下菜名。"; $("#meal-text").focus(); return; }
      if (!other && !r) { err.textContent = "選一道菜，或點「只寫菜名」。"; $("#meal-dish").focus(); return; }
      const btn = $("#meal-go");
      btn.disabled = true;
      try {
        await state.store.addMeal({
          date: state.calSel, slot: state.mealSlot, recipeId: r ? r.id : "", text, by: state.member, at: Date.now(),
        });
        $("#meal").close();
        const label = (SLOTS.find((x) => x[0] === state.mealSlot) || [])[1] || "";
        toast(`已加入${label}：${text}`);
      } catch (ex) {
        console.error(ex);
        err.textContent = "沒有加入成功，等一下再試一次。";
      } finally {
        btn.disabled = false;
      }
    });

    // ---- 食譜資料維護 ----
    on("#new-recipe", "click", () => openRecipeEditor(null, false));
    on("#admin-bar", "click", async (e) => {
      const b = e.target.closest("[data-import]");
      if (!b || !isEditorNow()) return;
      const list = pendingImport();
      if (!list.length) return;
      if (!confirm(`要把 ${list.length} 道食譜存進資料庫嗎？`)) return;
      b.disabled = true;
      let ok = 0;
      for (const r of list) {
        b.textContent = `匯入中… ${ok}/${list.length}`;
        try {
          const data = recipeData(r);
          await state.store.saveRecipe(r.id, data);
          state.custom = state.custom.filter((x) => x.id !== r.id).concat([Object.assign({ id: r.id, custom: true }, data)]);
          ok++;
        } catch (ex) {
          console.error("匯入失敗：" + r.id, ex);
        }
      }
      renderChips();
      renderAll();
      toast(ok === list.length ? `匯入完成，共 ${ok} 道` : `匯入 ${ok} 道，${list.length - ok} 道失敗（請看主控台）`);
    });

    // ---- 新增／編輯食譜 ----
    on("#re-tags", "click", (e) => {
      const b = e.target.closest("[data-retag]");
      if (!b) return;
      const t = b.dataset.retag;
      state.reTags.has(t) ? state.reTags.delete(t) : state.reTags.add(t);
      renderReTags();
      renderReIcon();
      const again = $(`#re-tags [data-retag="${CSS.escape(t)}"]`);
      if (again) again.focus();
    });
    on("#re-level", "click", (e) => {
      const b = e.target.closest("[data-level]");
      if (!b) return;
      state.reLevel = Number(b.dataset.level);
      renderReLevel();
    });
    on("#re-icon", "change", renderReIcon);
    on("#re-id", "input", (e) => {
      const el = e.target;
      const v = el.value.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "");
      if (v !== el.value) el.value = v;
    });
    const backToMeal = () => { if (state.reReturn) { openMeal(state.mealSlot); } };
    on("#re-cancel", "click", () => { $("#redit").close(); backToMeal(); });
    on("#redit-form", "submit", async (e) => {
      e.preventDefault();
      const err = $("#re-err");
      const title = $("#re-title").value.trim().slice(0, 40);
      if (!title) { err.textContent = "請填菜名。"; $("#re-title").focus(); return; }
      let newId = "";
      if (!state.reEditId) {
        newId = slugify($("#re-id").value);
        $("#re-id").value = newId;
        if (!newId) { err.textContent = "請填英文名稱。"; $("#re-id").focus(); return; }
        if (!ID_RE.test(newId) || newId.length < 2 || newId.length > 40) {
          err.textContent = "英文名稱只能用小寫英文、數字和連字號，2～40 個字。"; $("#re-id").focus(); return;
        }
        if (allRecipes().some((x) => x.id === newId) || ["calendar", "ranking"].includes(newId)) {
          err.textContent = `「${newId}」已經有人用了，換一個名字。`; $("#re-id").focus(); return;
        }
      }
      const me = FAMILY.find((m) => m.id === state.member);
      const num = (sel, lo, hi, def) => { const n = parseInt($(sel).value, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
      const data = {
        title,
        subtitle: $("#re-sub").value.trim().slice(0, 80),
        tags: [...state.reTags].slice(0, 10),
        time: num("#re-time", 1, 600, 30),
        level: state.reLevel,
        serves: num("#re-serves", 1, 30, 3),
        icon: $("#re-icon").value || "cooking-pot",
        ingredients: lines($("#re-ing").value).slice(0, 40).map((x) => x.slice(0, 100)),
        steps: lines($("#re-steps").value).slice(0, 30).map((x) => x.slice(0, 300)),
        tip: $("#re-tip").value.trim().slice(0, 200),
        from: $("#re-from").value.trim().slice(0, 20),
        by: state.member,
        at: Date.now(),
      };
      const old = state.reEditId && allRecipes().find((x) => x.id === state.reEditId);
      if (old && old.image) data.image = String(old.image).slice(0, 200);
      if (old && old.color) data.color = String(old.color).slice(0, 20);
      const id = state.reEditId || newId;
      const btn = $("#re-go");
      btn.disabled = true;
      try {
        await state.store.saveRecipe(id, data);
        state.custom = state.custom.filter((x) => x.id !== id).concat([Object.assign({ id, custom: true }, data)]);
        renderChips();
        renderAll();
        $("#redit").close();
        toast(state.reEditId ? "食譜已更新" : `新增了「${title}」`);
        if (state.reReturn) {
          openMeal(state.mealSlot);
          fillMealOptions(id);
        } else if (!state.reEditId) {
          openRecipe(id);
        }
      } catch (ex) {
        console.error(ex);
        err.textContent = "食譜沒有存成功，等一下再試一次。";
      } finally {
        btn.disabled = false;
      }
    });

    on("#chips", "click", (e) => {
      if (e.target.closest("[data-clear-tags]")) {
        state.tags.clear();
      } else {
        const b = e.target.closest("[data-tag]");
        if (!b) return;
        const t = b.dataset.tag;
        state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t);
      }
      renderChips();
      renderGrid();
      const again = e.target.closest("[data-tag]") && $(`#chips [data-tag="${CSS.escape(e.target.closest("[data-tag]").dataset.tag)}"]`);
      if (again) again.focus();
    });

    on("#q", "input", (e) => {
      state.query = e.target.value;
      renderGrid();
    });

    on("#grid", "click", (e) => {
      const b = e.target.closest("[data-open]");
      if (b) openRecipe(b.dataset.open);
    });

    const dlg = $("#detail");
    dlg.addEventListener("click", async (e) => {
      if (e.target === dlg || e.target.closest("[data-close]")) { dlg.close(); return; }
      const ft = e.target.closest("[data-filter-tag]");
      if (ft) {
        state.tags = new Set([ft.dataset.filterTag]);
        state.query = "";
        $("#q").value = "";
        dlg.close();
        renderChips();
        renderGrid();
        $("#chips").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const er = e.target.closest("[data-edit-recipe]");
      if (er) { openRecipeEditor(er.dataset.editRecipe, false); return; }
      const xr = e.target.closest("[data-del-recipe]");
      if (xr) {
        if (!confirm("確定要刪除這個食譜嗎？刪除後就找不回來了。")) return;
        try {
          const id = xr.dataset.delRecipe;
          await state.store.deleteRecipe(id);
          state.custom = state.custom.filter((x) => x.id !== id);
          dlg.close();
          renderChips();
          renderAll();
          toast("食譜已刪除");
        } catch (ex) { console.error(ex); toast("沒有刪除成功，等一下再試一次"); }
        return;
      }
      const wr = e.target.closest("[data-wish-recipe]");
      if (wr) { openWish(wr.dataset.wishRecipe); return; }
      if (!state.openId) return;
      const rid = state.openId;

      if (e.target.closest("[data-more-reviews]")) {
        state.showAll[rid] = !state.showAll[rid];
        renderDetail();
        return;
      }
      if (!state.member) return;
      const today = ymd(new Date());
      const draft = state.drafts[rid] || (state.drafts[rid] = { stars: 0, note: "", date: today });

      const star = e.target.closest("[data-star]");
      if (star) {
        draft.stars = Number(star.dataset.star);
        renderDetail();
        return;
      }

      const del = e.target.closest("[data-del-review]");
      if (del) {
        if (!confirm("確定要刪除這筆評分嗎？")) return;
        try { await state.store.deleteReview(del.dataset.delReview); toast("已刪除"); }
        catch (err) { console.error(err); toast("沒有刪除成功，等一下再試一次"); }
        return;
      }

      const send = e.target.closest("[data-save-review]");
      if (send) {
        if (!draft.stars) { toast("先點星星打分數"); return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date || "") || draft.date > today) { toast("請選今天或之前的日期"); return; }
        send.disabled = true;
        try {
          await state.store.addReview({
            recipe: rid,
            member: state.member,
            stars: draft.stars,
            note: (draft.note || "").trim().slice(0, NOTE_MAX),
            date: draft.date,
            at: Date.now(),
          });
          delete state.drafts[rid];
          renderDetail();
          toast(`記下來了！${dayLabel(draft.date)}給 ${draft.stars} 顆星`);
        } catch (err) {
          console.error(err);
          send.disabled = false;
          toast("評分沒有存成功，等一下再試一次");
        }
      }
    });
    dlg.addEventListener("input", (e) => {
      if (!state.openId || (e.target.id !== "note" && e.target.id !== "rv-date")) return;
      const draft = state.drafts[state.openId] || (state.drafts[state.openId] = { stars: 0, note: "", date: ymd(new Date()) });
      if (e.target.id === "note") {
        draft.note = e.target.value;
        const c = $("#note-count");
        if (c) c.textContent = `${e.target.value.length} / ${NOTE_MAX}`;
      } else {
        draft.date = e.target.value;
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
      history.replaceState(null, "", viewHash());
      const card = id && document.querySelector(`[data-open="${CSS.escape(id)}"]`);
      if (card) card.focus();
    });
  }

  // ---------- start ----------
  async function start() {
    renderWho();
    renderChips();
    renderGrid();
    renderWishes();
    bind();

    state.store = await makeStore();
    $("#sync").textContent = state.store.shared
      ? "評分會同步給全家人，登入後才能看和打分數。"
      : "評分目前存在這台裝置上。";
    state.store.subscribe((all) => {
      state.ratings = all || {};
      renderAll();
    });
    state.store.subscribeReviews((list) => {
      state.reviews = list || [];
      renderAll();
    });
    state.store.subscribeWishes((list) => {
      state.wishes = list || [];
      renderWishes();
      renderCalendar();
      renderRanking();
    });
    state.store.subscribeMeals((list) => {
      state.meals = list || [];
      renderCalendar();
      renderRanking();
    });
    state.store.subscribeCustom((list) => {
      state.custom = (list || []).map((x) => Object.assign({}, x, { custom: true }));
      renderChips();
      renderAll();
    });
    if (state.store.shared) {
      state.member = null;
      renderWho();
      renderAll();
      state.store.onUser((user) => {
        const email = user && user.email ? user.email.toLowerCase() : "";
        const m = FAMILY.find((x) => x.email && x.email.toLowerCase() === email);
        if (user && !m) {
          toast("這個帳號不在家人名單裡");
          state.store.signOut();
          return;
        }
        state.member = m ? m.id : null;
        renderWho();
        renderAll();
      });
    }

    const fromHash = decodeURIComponent(location.hash.slice(1));
    if (fromHash === "calendar") setView("cal");
    else if (fromHash === "ranking") setView("rank");
    else if (fromHash) openRecipe(fromHash);
  }

  start();
})();
