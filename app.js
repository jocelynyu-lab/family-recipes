(function () {
  "use strict";

  const MEMBER_KEY = "family-recipes:member";
  const RATING_KEY = "family-recipes:ratings";
  const LEVELS = { 1: "簡單", 2: "要一點耐心", 3: "請大人一起做" };
  const ALL = "全部";
  const NOTE_MAX = 200;
  const WISH_KEY = "family-recipes:wishes";
  const WISH_TEXT_MAX = 30;

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
    drafts: {},  // recipeId -> 還沒送出的評語草稿
    wishes: [],  // 許願清單
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
      subscribeWishes(fn) { wishListener = fn; fn(readW()); },
      async addWish(w) {
        const all = readW();
        all.push(Object.assign({ id: "w" + Date.now() + Math.random().toString(36).slice(2, 6) }, w));
        writeW(all);
      },
      async updateWish(id, patch) {
        writeW(readW().map((w) => (w.id === id ? Object.assign({}, w, patch) : w)));
      },
      async deleteWish(id) { writeW(readW().filter((w) => w.id !== id)); },
    };
    function readW() {
      try {
        const today = ymd(new Date());
        return (JSON.parse(localStorage.getItem(WISH_KEY)) || []).filter((w) => w.date >= today);
      } catch (e) { return []; }
    }
    function writeW(all) { localStorage.setItem(WISH_KEY, JSON.stringify(all)); wishListener(all); }
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
            wunsub = wcol.where("date", ">=", ymd(new Date())).onSnapshot(
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
          }
          fn(user);
        });
      },
      signIn(email, pw) { return auth.signInWithEmailAndPassword(email, pw); },
      signOut() { return auth.signOut(); },
      set(rid, mid, val) { return col.doc(rid).set({ [mid]: val }, { merge: true }); },
      subscribeWishes(fn) { wishListener = fn; },
      addWish(w) { return wcol.add(w); },
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
  function reviewsOf(rid) {
    const r = state.ratings[rid] || {};
    const out = {};
    FAMILY.forEach((m) => {
      const rv = reviewOf(r[m.id]);
      if (rv && rv.stars >= 1 && rv.stars <= 5) out[m.id] = rv;
    });
    return out;
  }
  function scoreOf(rid) {
    const list = Object.values(reviewsOf(rid));
    if (!list.length) return null;
    return {
      avg: list.reduce((a, b) => a + b.stars, 0) / list.length,
      n: list.length,
      notes: list.filter((x) => x.note.trim()).length,
    };
  }
  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" }) : "");
  const starString = (n) => "★".repeat(n) + "☆".repeat(5 - n);

  // ---------- render ----------
  function renderWho() {
    $("#who-list").innerHTML = FAMILY.map(
      (m) => `<button type="button" class="who-btn" data-member="${esc(m.id)}" aria-pressed="${m.id === state.member}">
        <span class="face" aria-hidden="true">${esc(m.emoji)}</span>${esc(m.name)}</button>`
    ).join("") + (needsLogin() && state.member ? `<button type="button" class="logout" data-logout>登出</button>` : "");
  }

  const needsLogin = () => !!(state.store && state.store.shared);

  const ICON = {
    time: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
    level: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V14M12 20V9M19 20V4"/></svg>',
  };
  const PH = { "家常菜": "#fde8e1", "飯麵": "#fbefd6", "湯": "#e3eefb", "點心": "#f3e6f6" };

  function media(r, cls) {
    return r.image
      ? `<img src="${esc(r.image)}" alt="${cls === "d" ? esc(r.title) : ""}" loading="lazy">`
      : `<span class="ph" style="--ph:${PH[r.category] || "#eef0f4"}" aria-hidden="true">${esc(r.emoji)}</span>`;
  }

  function renderChips() {
    const cats = [ALL, ...new Set(RECIPES.map((r) => r.category).filter(Boolean))];
    $("#chips").innerHTML = cats
      .map((c) => `<button type="button" class="tab" data-cat="${esc(c)}" aria-pressed="${c === state.cat}">${esc(c)}</button>`)
      .join("");
  }

  function matches(r) {
    if (state.cat !== ALL && r.category !== state.cat) return false;
    const q = state.query.trim();
    if (!q) return true;
    const hay = [r.title, r.subtitle, r.from, r.category, ...(r.ingredients || [])].join(" ");
    return hay.includes(q);
  }

  function scoreHTML(s) {
    if (needsLogin() && !state.member) return `<span class="score-none">登入後看評分</span>`;
    return s
      ? `<span class="ico"><span class="st" aria-hidden="true">★</span>${s.avg.toFixed(1)}（${s.n} 人）</span>`
      : `<span class="score-none">還沒有人評分</span>`;
  }

  function noteCount(rid) {
    if (needsLogin() && !state.member) return "";
    const s = scoreOf(rid);
    return s && s.notes ? `<span class="ico" aria-label="${s.notes} 則評語">${ICON.note}${s.notes}</span>` : "";
  }

  function cardHTML(r) {
    return `<button type="button" class="card" data-open="${esc(r.id)}">
      <span class="media">${media(r)}${r.category ? `<span class="badge">${esc(r.category)}</span>` : ""}</span>
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

  function renderGrid() {
    const list = RECIPES.filter(matches);
    $("#grid").innerHTML = list.map(cardHTML).join("");
    $("#empty").hidden = list.length > 0;
    $("#count").textContent = list.length ? `共 ${list.length} 道菜` : "";
  }

  function renderDetail() {
    const r = RECIPES.find((x) => x.id === state.openId);
    if (!r) return;

    // 重新畫面時保留焦點與正在打字的位置
    const ae = document.activeElement;
    const focusedStar = ae && ae.dataset ? ae.dataset.star : null;
    const noteFocus = ae && ae.id === "note" ? [ae.selectionStart, ae.selectionEnd] : null;

    const reviews = reviewsOf(r.id);
    const me = FAMILY.find((m) => m.id === state.member);
    const myReview = me ? reviews[me.id] : null;
    const mine = myReview ? myReview.stars : 0;
    const draft = state.drafts[r.id] !== undefined ? state.drafts[r.id] : (myReview ? myReview.note : "");
    const checked = state.checked[r.id] || new Set();
    const s = scoreOf(r.id);

    const rating = me
      ? `<p class="rate-who">${esc(me.emoji)} ${esc(me.name)}，你給幾顆星？</p>
         <div class="stars" role="group" aria-label="${esc(me.name)}的評分">
           ${[1, 2, 3, 4, 5].map((n) =>
             `<button type="button" class="star${mine >= n ? " on" : ""}" data-star="${n}" aria-label="${n} 顆星" aria-pressed="${mine === n}">★</button>`
           ).join("")}
         </div>
         <div class="note-box">
           <label for="note" class="note-label">想說的話（可以不寫）</label>
           <textarea id="note" maxlength="${NOTE_MAX}" rows="3" placeholder="例如：蛋可以再嫩一點！下次想加起司。">${esc(draft)}</textarea>
           <div class="note-foot">
             <span class="note-count" id="note-count">${draft.length} / ${NOTE_MAX}</span>
             <button type="button" class="btn note-send" data-save-note>${myReview && myReview.note ? "更新評語" : "送出評語"}</button>
           </div>
         </div>`
      : `<p class="rate-need">${needsLogin() ? "先點最上面你的頭像登入，就可以打分數、寫評語，也能看全家的評語。" : "先在最上面點選你是誰，就可以打分數、寫評語了。"}</p>`;

    const canSee = !(needsLogin() && !me);
    const ordered = FAMILY.slice().sort((a, b) => ((reviews[b.id] || {}).at || 0) - ((reviews[a.id] || {}).at || 0));
    const reviewList = !canSee ? "" : `
      <h4 class="rv-h">大家的評語</h4>
      <ul class="reviews">
        ${ordered.map((m) => {
          const rv = reviews[m.id];
          return `<li class="rv${rv ? "" : " rv-empty"}">
            <div class="rv-head">
              <span class="rv-face" aria-hidden="true">${esc(m.emoji)}</span>
              <span class="rv-name">${esc(m.name)}</span>
              ${rv ? `<span class="st" aria-label="${rv.stars} 顆星">${starString(rv.stars)}</span>` : `<span class="rv-none">還沒評</span>`}
              ${rv && rv.at ? `<span class="rv-date">${fmtDate(rv.at)}</span>` : ""}
            </div>
            ${rv && rv.note ? `<p class="rv-note">${esc(rv.note)}</p>` : ""}
          </li>`;
        }).join("")}
      </ul>`;

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
          <span class="d-from">${esc(r.from)}的拿手菜</span>
          <h2 id="d-title" class="d-title">${esc(r.title)}</h2>
          ${r.subtitle ? `<p class="d-sub">${esc(r.subtitle)}</p>` : ""}
          <dl class="d-stats">
            <div><dt>時間</dt><dd>${esc(r.time)} 分鐘</dd></div>
            <div><dt>份量</dt><dd>${r.serves ? esc(r.serves) + " 人份" : "—"}</dd></div>
            <div><dt>難度</dt><dd>${esc(LEVELS[r.level] || "—")}</dd></div>
          </dl>
          <p class="d-avg">${scoreHTML(s)}</p>
          <button type="button" class="btn wish-this" data-wish-recipe="${esc(r.id)}">想吃這道，許願！</button>
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
            const m = FAMILY.find((x) => x.id === w.member) || { name: "?", emoji: "🙂" };
            const r = w.recipeId && RECIPES.find((x) => x.id === w.recipeId);
            const dish = r
              ? `<button type="button" class="wish-dish is-link" data-open="${esc(r.id)}">${esc(r.emoji)} ${esc(r.title)}</button>`
              : `<span class="wish-dish">${esc(w.text)}</span>`;
            const canDel = w.member === state.member || isParent;
            return `<li class="wish${w.granted ? " granted" : ""}">
              <span class="wish-face" aria-hidden="true">${esc(m.emoji)}</span>
              <div class="wish-main">
                <span class="wish-who">${esc(m.name)}想吃</span>
                ${dish}
                ${w.granted ? `<span class="wish-ok">✓ 爸媽答應了</span>` : ""}
              </div>
              <div class="wish-acts">
                ${isParent ? `<button type="button" class="mini${w.granted ? "" : " mini-solid"}" data-grant="${esc(w.id)}">${w.granted ? "取消答應" : "答應"}</button>` : ""}
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
    sel.innerHTML = `<option value="">選一道菜…</option>` +
      RECIPES.map((r) => `<option value="${esc(r.id)}">${esc(r.emoji)} ${esc(r.title)}</option>`).join("") +
      `<option value="__other">其他（自己寫）</option>`;
    sel.value = recipeId || "";
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
  function setWhen(v) {
    state.when = v;
    document.querySelectorAll("#wish-when [data-when]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.when === v)));
    $("#wish-date").hidden = v !== "pick";
  }

  function renderAll() {
    renderGrid();
    renderWishes();
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

  // ---------- login ----------
  function openLogin(id) {
    const m = FAMILY.find((x) => x.id === id);
    if (!m) return;
    if (!m.email) { toast(`${m.name}還沒有帳號，請大人到 recipes.js 設定 email`); return; }
    state.loginId = id;
    $("#login-face").textContent = m.emoji;
    $("#login-title").textContent = `${m.name}，請輸入密碼`;
    $("#login-email").value = m.email;
    $("#login-pw").value = "";
    $("#login-err").textContent = "";
    $("#login").showModal();
    $("#login-pw").focus();
  }

  // ---------- events ----------
  function bind() {
    $("#who-list").addEventListener("click", (e) => {
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
    $("#login-form").addEventListener("submit", async (e) => {
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
    $("#login-cancel").addEventListener("click", () => login.close());

    // ---- 許願 ----
    $("#make-wish").addEventListener("click", () => openWish(""));
    $("#wish-dish").addEventListener("change", (e) => {
      const other = e.target.value === "__other";
      $("#wish-text").hidden = !other;
      if (other) $("#wish-text").focus();
    });
    $("#wish-when").addEventListener("click", (e) => {
      const b = e.target.closest("[data-when]");
      if (!b) return;
      setWhen(b.dataset.when);
      if (b.dataset.when === "pick") $("#wish-date").focus();
    });
    $("#wish-cancel").addEventListener("click", () => $("#wish").close());
    $("#wish-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = $("#wish-err");
      const v = $("#wish-dish").value;
      const r = RECIPES.find((x) => x.id === v);
      const text = v === "__other" ? $("#wish-text").value.trim().slice(0, WISH_TEXT_MAX) : (r ? r.title : "");
      if (!v) { err.textContent = "選一道想吃的菜。"; return; }
      if (!text) { err.textContent = "寫下想吃的菜名。"; $("#wish-text").focus(); return; }
      const date = state.when === "today" ? addDays(0)
        : state.when === "tomorrow" ? addDays(1)
        : $("#wish-date").value;
      if (!date || date < ymd(new Date())) { err.textContent = "選今天或之後的日期。"; return; }
      const btn = $("#wish-go");
      btn.disabled = true;
      try {
        await state.store.addWish({
          member: state.member, date, recipeId: r ? r.id : "", text, at: Date.now(), granted: false,
        });
        $("#wish").close();
        toast(`許願成功！${dateLabel(date)}想吃${text}`);
      } catch (ex) {
        console.error(ex);
        err.textContent = "許願沒有送出，等一下再試一次。";
      } finally {
        btn.disabled = false;
      }
    });
    $("#wish-list").addEventListener("click", async (e) => {
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
      const wr = e.target.closest("[data-wish-recipe]");
      if (wr) { openWish(wr.dataset.wishRecipe); return; }
      if (!state.member || !state.openId) return;
      const rid = state.openId;
      const mine = reviewsOf(rid)[state.member];

      const star = e.target.closest("[data-star]");
      if (star) {
        const val = Number(star.dataset.star);
        try {
          await state.store.set(rid, state.member, { stars: val, note: mine ? mine.note : "", at: Date.now() });
          toast(`給了 ${val} 顆星，謝謝！`);
        } catch (err) {
          console.error(err);
          toast("評分沒有存成功，等一下再試一次");
        }
        return;
      }

      const send = e.target.closest("[data-save-note]");
      if (send) {
        if (!mine) { toast("先點星星打分數，再送出評語"); return; }
        const note = ($("#note").value || "").trim().slice(0, NOTE_MAX);
        send.disabled = true;
        try {
          await state.store.set(rid, state.member, { stars: mine.stars, note, at: Date.now() });
          delete state.drafts[rid];
          renderDetail();
          toast(note ? "評語送出了！" : "評語已清除");
        } catch (err) {
          console.error(err);
          send.disabled = false;
          toast("評語沒有存成功，等一下再試一次");
        }
      }
    });
    dlg.addEventListener("input", (e) => {
      if (e.target.id !== "note" || !state.openId) return;
      state.drafts[state.openId] = e.target.value;
      const c = $("#note-count");
      if (c) c.textContent = `${e.target.value.length} / ${NOTE_MAX}`;
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
    state.store.subscribeWishes((list) => {
      state.wishes = list || [];
      renderWishes();
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
    if (fromHash) openRecipe(fromHash);
  }

  start();
})();
