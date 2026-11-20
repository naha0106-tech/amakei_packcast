/* 챙길까? — 예보 확신도 기반 준비물 추천
 *
 * 흐름: 도시·날짜·시간 선택 → Open-Meteo 앙상블 예보(82개 시나리오) 불러오기
 *      → 외출 시간대만 잘라내기 → 시나리오마다 판단 → 개수 세기 → 화면 표시
 */

// ───────────────────────── 판단 기준 (데이터 쌓이면 조정) ─────────────────────────
const RULES = {
  sure: 0.85,          // 다수 의견이 85% 이상이면 "확실"
  likely: 0.65,        // 65% 이상이면 "아마도", 그 아래는 "애매함"
  rainMm: 0.1,         // 1시간 비 0.1mm 이상이면 비 온 것으로 봄
  snowCm: 0.1,         // 1시간 눈 0.1cm 이상이면 눈 온 것으로 봄
  umbrellaNeed: 0.5,   // 비 온 시나리오가 50% 이상이면 우산
  umbrellaMaybe: 0.2,  // 20~49%면 접이식
  glovesFeels: -5,     // 체감 -5°C 이하면 장갑·목도리
  windyMs: 9,          // 풍속 9m/s 이상이면 강풍
  icyHours: 6,         // 기온 0°C 이하 + 앞선 6시간 안에 비·눈 → 결빙 주의
};

const COAT_LEVELS = [
  { max: 4, name: "패딩", color: "#3b4cc0" },
  { max: 8, name: "코트", color: "#5a7be0" },
  { max: 11, name: "트렌치코트", color: "#7fa6f0" },
  { max: 16, name: "자켓", color: "#a7c5f5" },
  { max: 19, name: "맨투맨", color: "#f2c46d" },
  { max: 22, name: "얇은 가디건", color: "#f0a254" },
  { max: 27, name: "얇은 셔츠", color: "#e8794a" },
  { max: Infinity, name: "반팔", color: "#d6455d" },
];

const ENSEMBLE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble";
const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

// ───────────────────────── 계산 (화면과 분리된 순수 함수) ─────────────────────────

const coatLevel = (t) => COAT_LEVELS.findIndex((l) => t <= l.max);

// 온도 → 색 (-15°C 진한 파랑 ~ 30°C 빨강, 온도에 고정된 색)
function tempColor(t) {
  const stops = [[-15, [40, 50, 160]], [-5, [59, 76, 192]], [5, [127, 166, 240]], [15, [242, 196, 109]], [22, [232, 121, 74]], [30, [214, 69, 93]]];
  if (t <= stops[0][0]) return `rgb(${stops[0][1]})`;
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    if (t <= t1) {
      const [t0, c0] = stops[i - 1];
      const f = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((c, k) => Math.round(c + (c1[k] - c) * f)).join(",")})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1]})`;
}

function confidenceOf(share) {
  if (share >= RULES.sure) return { key: "sure", label: "확실" };
  if (share >= RULES.likely) return { key: "likely", label: "아마도" };
  return { key: "unsure", label: "애매함" };
}
// 예/아니오 판단의 확신도: 다수 쪽 비율
const yesNoConfidence = (p) => confidenceOf(Math.max(p, 1 - p));

/** 응답(hourly)에서 82개 시나리오를 시나리오별로 묶는다.
 *  항목 이름 예: precipitation_member01_ecmwf_ifs025_ensemble, precipitation_ncep_gefs025(기준 시나리오) */
function parseMembers(hourly) {
  const prefix = "precipitation_";
  return Object.keys(hourly)
    .filter((k) => k.startsWith(prefix))
    .map((k) => {
      const id = k.slice(prefix.length);
      return {
        id,
        model: id.includes("ecmwf") ? "ECMWF" : "GFS",
        precip: hourly["precipitation_" + id],
        rain: hourly["rain_" + id],
        snow: hourly["snowfall_" + id],
        feels: hourly["apparent_temperature_" + id],
        temp: hourly["temperature_2m_" + id],
        wind: hourly["wind_speed_10m_" + id],
      };
    })
    .filter((m) => Array.isArray(m.precip) && Array.isArray(m.feels));
}

const pad = (n) => String(n).padStart(2, "0");

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 외출 시간대(출발~귀가)에 해당하는 시간 칸 번호들. 귀가가 출발보다 이르면 다음 날 귀가로 본다. */
function windowIndices(times, date, startH, endH) {
  const from = `${date}T${pad(startH)}:00`;
  const toDate = endH > startH ? date : addDays(date, 1);
  const to = `${toDate}T${pad(endH)}:00`;
  const idx = [];
  times.forEach((t, i) => { if (t >= from && t <= to) idx.push(i); });
  return { idx, from, to };
}

const isNum = (v) => typeof v === "number" && !Number.isNaN(v);
const val = (arr, i) => (arr && isNum(arr[i]) ? arr[i] : null);

/** 시나리오마다 판단하고 개수를 센다. */
function judge(members, idx) {
  const per = [];
  for (const m of members) {
    const feels = idx.map((i) => val(m.feels, i)).filter(isNum);
    if (feels.length === 0) continue; // 이 시간대 자료가 없는 시나리오는 제외
    const minFeels = Math.min(...feels);
    const rain = idx.some((i) => (val(m.rain, i) ?? 0) >= RULES.rainMm);
    const snow = idx.some((i) => (val(m.snow, i) ?? 0) >= RULES.snowCm);
    const wet = idx.some((i) => (val(m.precip, i) ?? 0) >= RULES.rainMm);
    const maxWind = Math.max(0, ...idx.map((i) => val(m.wind, i)).filter(isNum));
    const icy = idx.some((i) => {
      const t = val(m.temp, i);
      if (t === null || t > 0) return false;
      let sum = 0;
      for (let j = Math.max(0, i - RULES.icyHours); j <= i; j++) sum += val(m.precip, j) ?? 0;
      return sum >= RULES.rainMm;
    });
    per.push({ m, minFeels, rain, snow, wet, maxWind, icy });
  }

  const n = per.length;
  if (n === 0) return null;
  const share = (f) => per.filter(f).length / n;

  // 옷: 시나리오별 최저 체감온도 → 옷 단계 → 가장 많이 나온 단계
  const levelCount = new Array(COAT_LEVELS.length).fill(0);
  per.forEach((p) => levelCount[coatLevel(p.minFeels)]++);
  const ranked = levelCount
    .map((c, i) => ({ i, c }))
    .filter((x) => x.c > 0)
    .sort((a, b) => b.c - a.c);
  const top = ranked[0];
  const sortedFeels = per.map((p) => p.minFeels).sort((a, b) => a - b);
  const q = (r) => sortedFeels[Math.min(n - 1, Math.max(0, Math.round(r * (n - 1))))];

  // 시간대별 최고 강수확률 (일반 예보처럼 시간마다 따로 본 값)
  let hourlyMax = 0;
  for (const i of idx) {
    const k = per.filter((p) => (val(p.m.precip, i) ?? 0) >= RULES.rainMm).length;
    hourlyMax = Math.max(hourlyMax, k / n);
  }

  return {
    n,
    per,
    rain: share((p) => p.rain),
    snow: share((p) => p.snow),
    wet: share((p) => p.wet),
    hourlyMax,
    gloves: share((p) => p.minFeels <= RULES.glovesFeels),
    windy: share((p) => p.maxWind >= RULES.windyMs),
    icy: share((p) => p.icy),
    coat: {
      level: top.i,
      share: top.c / n,
      second: ranked[1] ? ranked[1].i : null,
      low: q(0.1),
      mid: q(0.5),
      high: q(0.9),
    },
  };
}

// 미세먼지 등급 (환경부 기준)
function airGrade(pm10, pm25) {
  const g10 = pm10 <= 30 ? 0 : pm10 <= 80 ? 1 : pm10 <= 150 ? 2 : 3;
  const g25 = pm25 <= 15 ? 0 : pm25 <= 35 ? 1 : pm25 <= 75 ? 2 : 3;
  return Math.max(g10, g25);
}
const AIR_NAMES = ["좋음", "보통", "나쁨", "매우 나쁨"];

/** 판단 결과 → 화면에 보여줄 항목들 */
function buildItems(r, air) {
  const items = [];
  const pct = (p) => Math.round(p * 100);
  const cnt = (p) => Math.round(p * r.n);

  // 겉옷
  const coatName = COAT_LEVELS[r.coat.level].name;
  const coatConf = confidenceOf(r.coat.share);
  const range = `체감 ${Math.round(r.coat.low)}~${Math.round(r.coat.high)}°C`;
  items.push({
    key: "coat", icon: "🧥", on: true, conf: coatConf,
    what: coatConf.key === "unsure" && r.coat.second !== null
      ? `${coatName} 또는 ${COAT_LEVELS[r.coat.second].name} (겹쳐 입기)`
      : coatName,
    why: `외출 중 가장 추울 때 ${range} · ${r.n}개 중 ${cnt(r.coat.share)}개가 ${coatName}`,
  });

  // 우산
  const rc = yesNoConfidence(r.rain);
  items.push({
    key: "umbrella", icon: "☂️", conf: rc,
    on: r.rain >= RULES.umbrellaMaybe,
    what: r.rain >= RULES.umbrellaNeed ? "우산 챙기세요"
      : r.rain >= RULES.umbrellaMaybe ? "접이식 우산 챙기면 안심" : "우산 필요 없어요",
    why: `${r.n}개 중 ${cnt(r.rain)}개에서 외출 중 비 (${pct(r.rain)}%)`,
  });

  // 눈
  const sc = yesNoConfidence(r.snow);
  items.push({
    key: "snow", icon: "☃️", conf: sc,
    on: r.snow >= RULES.umbrellaMaybe,
    what: r.snow >= RULES.umbrellaNeed ? "눈 와요 · 미끄럽지 않은 신발"
      : r.snow >= RULES.umbrellaMaybe ? "눈 올 수도 있어요" : "눈 걱정 없어요",
    why: `${r.n}개 중 ${cnt(r.snow)}개에서 외출 중 눈 (${pct(r.snow)}%)`,
  });

  // 장갑·목도리 (해당될 때만)
  if (r.gloves >= 0.3) {
    items.push({
      key: "gloves", icon: "🧤", on: true, conf: yesNoConfidence(r.gloves),
      what: "장갑·목도리",
      why: `${r.n}개 중 ${cnt(r.gloves)}개에서 체감 ${RULES.glovesFeels}°C 이하`,
    });
  }

  // 강풍 (해당될 때만)
  if (r.windy >= 0.3) {
    items.push({
      key: "wind", icon: "💨", on: true, conf: yesNoConfidence(r.windy),
      what: "강풍 주의 · 자전거·우산 조심",
      why: `${r.n}개 중 ${cnt(r.windy)}개에서 풍속 ${RULES.windyMs}m/s 이상`,
    });
  }

  // 결빙 (해당될 때만)
  if (r.icy >= 0.2) {
    items.push({
      key: "icy", icon: "⚠️", on: true, conf: yesNoConfidence(r.icy),
      what: "길이 얼 수 있어요 · 천천히 걷기",
      why: `${r.n}개 중 ${cnt(r.icy)}개에서 영하 + 비·눈 뒤`,
    });
  }

  // 마스크 (예보 1개라 확신도 대신 "참고")
  if (air) {
    items.push({
      key: "mask", icon: "😷", on: air.grade >= 2,
      conf: { key: "ref", label: "참고" },
      what: air.grade >= 2 ? "마스크 챙기세요" : "마스크 필요 없어요",
      why: `미세먼지 ${AIR_NAMES[air.grade]} (PM10 최고 ${Math.round(air.pm10)}, PM2.5 최고 ${Math.round(air.pm25)}㎍/㎥)`,
    });
  }
  return items;
}

function buildHeadline(r, items) {
  const coat = items.find((x) => x.key === "coat");
  const parts = [];
  const gloves = items.some((x) => x.key === "gloves") ? "에 장갑까지" : "";
  parts.push(coat.conf.key === "unsure" ? `옷은 겹쳐 입기${gloves ? ", 장갑도" : ""}` : `${COAT_LEVELS[r.coat.level].name}${gloves} ${coat.conf.label}`);
  if (r.rain >= RULES.umbrellaNeed) parts.push("우산 챙기세요");
  else if (r.rain >= RULES.umbrellaMaybe) parts.push("접이식 우산 챙기면 안심");
  else parts.push("우산은 두고 가도 돼요");
  if (r.snow >= RULES.umbrellaNeed) parts.push("눈 와요");
  else if (r.snow >= RULES.umbrellaMaybe) parts.push("눈 올 수도 있어요");
  return parts.join(", ") + ".";
}

function buildTip(items) {
  const unsure = items.filter((x) => x.conf.key === "unsure");
  if (unsure.length === 0) return null;
  const names = unsure.map((x) => ({ coat: "기온", umbrella: "비", snow: "눈", gloves: "추위", wind: "바람", icy: "결빙" }[x.key])).filter(Boolean);
  return `🤔 ${names.join("·")} 예보는 시뮬레이션 의견이 갈려요. ` +
    (unsure.some((x) => x.key === "coat") ? "벗기 쉽게 겹쳐 입고, " : "") +
    (unsure.some((x) => x.key === "umbrella" || x.key === "snow") ? "접이식 우산을 챙기고, " : "") +
    "출발 1시간 전에 다시 확인해 보세요.";
}

/** 출발지·도착지 시나리오를 같은 번호끼리 이어 붙인다.
 *  외출 시간대의 처음(출발)과 끝(집 도착)은 출발지, 그 사이는 도착지 값을 쓴다. */
function routeMembers(orig, dest, idx) {
  if (!dest || dest === orig || idx.length <= 2) return orig;
  const destHours = new Set(idx.slice(1, -1));
  const byId = new Map(dest.map((m) => [m.id, m]));
  const keys = ["precip", "rain", "snow", "feels", "temp", "wind"];
  return orig.filter((m) => byId.has(m.id)).map((m) => {
    const d = byId.get(m.id);
    const out = { id: m.id, model: m.model };
    for (const k of keys) {
      const a = m[k] || [], b = d[k] || [];
      out[k] = a.map((v, i) => (destHours.has(i) ? (b[i] ?? null) : v));
    }
    return out;
  });
}

/** 구간 하나의 요약: 시나리오별 최저 체감온도의 가운데값, 비·눈 만난 시나리오 비율 */
function segmentSummary(members, idx) {
  const mins = [], n0 = members.length;
  let wet = 0;
  for (const m of members) {
    const f = idx.map((i) => val(m.feels, i)).filter(isNum);
    if (!f.length) continue;
    mins.push(Math.min(...f));
    if (idx.some((i) => (val(m.precip, i) ?? 0) >= RULES.rainMm)) wet++;
  }
  if (!mins.length) return null;
  mins.sort((a, b) => a - b);
  return { feels: mins[Math.floor(mins.length / 2)], wet: wet / (mins.length || n0) };
}

// Node에서 테스트할 수 있도록 내보내기
if (typeof module !== "undefined") {
  module.exports = { RULES, COAT_LEVELS, parseMembers, windowIndices, judge, buildItems, buildHeadline, buildTip, airGrade, confidenceOf, routeMembers, segmentSummary };
}

// ───────────────────────── 화면 ─────────────────────────
if (typeof document !== "undefined") {
  const $ = (id) => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem("chaenggilkka:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("chaenggilkka:" + k, JSON.stringify(v)); } catch { /* 저장 불가 환경은 무시 */ } },
  };

  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; })();
  const DAY = ["일", "월", "화", "수", "목", "금", "토"];

  function dateOptions() {
    const opts = [{ label: "오늘", date: today }, { label: "내일", date: addDays(today, 1) }];
    const dow = new Date(today + "T12:00:00").getDay();
    const toSat = (6 - dow + 7) % 7;
    for (const off of [toSat, toSat + 1]) {
      if (off < 2 || off > 6) continue;
      const d = addDays(today, off);
      const dd = new Date(d + "T12:00:00");
      opts.push({ label: `${DAY[dd.getDay()]} ${dd.getMonth() + 1}/${dd.getDate()}`, date: d });
    }
    return opts;
  }

  const cityNames = CITIES.map((c) => c[1]);
  const state = {
    from: store.get("from", store.get("city", "서울")),
    to: store.get("to", store.get("city", "서울")),
    dateIdx: 0,
    start: store.get("start", 8),
    end: store.get("end", 18),
    dotTab: "temp",
    page: 0,
  };
  if (!cityNames.includes(state.from)) state.from = "서울";
  if (!cityNames.includes(state.to)) state.to = state.from;
  if (new Date().getHours() > state.end && state.end > state.start) state.dateIdx = 1;

  const dates = dateOptions();
  const cache = {};
  let last = null; // 마지막 계산 결과 (탭 바꿀 때 다시 씀)

  // ── 입력 칸 채우기
  for (const sel of [$("from"), $("to")]) {
    let group = null, og = null;
    for (const [region, name] of CITIES) {
      if (region !== group) { og = document.createElement("optgroup"); og.label = region; sel.appendChild(og); group = region; }
      const o = document.createElement("option"); o.value = name; o.textContent = name; og.appendChild(o);
    }
  }
  $("from").value = state.from;
  $("to").value = state.to;
  for (const sel of [$("start"), $("end")]) {
    for (let h = 0; h < 24; h++) {
      const o = document.createElement("option"); o.value = h; o.textContent = `${pad(h)}:00`; sel.appendChild(o);
    }
  }
  $("start").value = state.start;
  $("end").value = state.end;

  const dateTabs = $("dateTabs");
  dates.forEach((d, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = d.label;
    b.onclick = () => { state.dateIdx = i; paintTabs(); };
    dateTabs.appendChild(b);
  });
  function paintTabs() {
    [...dateTabs.children].forEach((b, i) => b.classList.toggle("on", i === state.dateIdx));
  }
  paintTabs();

  $("from").onchange = (e) => { state.from = e.target.value; store.set("from", state.from); };
  $("to").onchange = (e) => { state.to = e.target.value; store.set("to", state.to); };
  $("swap").onclick = () => {
    [state.from, state.to] = [state.to, state.from];
    $("from").value = state.from; $("to").value = state.to;
    store.set("from", state.from); store.set("to", state.to);
  };
  $("start").onchange = (e) => { state.start = +e.target.value; store.set("start", state.start); };
  $("end").onchange = (e) => { state.end = +e.target.value; store.set("end", state.end); };

  // ── 데이터 불러오기
  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`서버 응답 ${res.status}`);
    return res.json();
  }
  async function load(cityName) {
    if (cache[cityName]) return cache[cityName];
    const [, , lat, lon] = CITIES.find((c) => c[1] === cityName);
    const q = new URLSearchParams({
      latitude: lat, longitude: lon,
      hourly: "temperature_2m,apparent_temperature,precipitation,rain,snowfall,wind_speed_10m",
      models: "ecmwf_ifs025,gfs025",
      timezone: "Asia/Seoul", forecast_days: 7, past_days: 1, wind_speed_unit: "ms",
    });
    const aq = new URLSearchParams({ latitude: lat, longitude: lon, hourly: "pm10,pm2_5", timezone: "Asia/Seoul", forecast_days: 5 });
    const [ens, air] = await Promise.all([
      getJSON(`${ENSEMBLE_URL}?${q}`),
      getJSON(`${AIR_URL}?${aq}`).catch(() => null),
    ]);
    const data = { ens, air, members: parseMembers(ens.hourly), at: new Date() };
    if (data.members.length === 0) throw new Error("예보 시나리오를 읽지 못했어요");
    cache[cityName] = data;
    return data;
  }

  function airWorst(list) {
    // list: [{data, times:Set}] → 구간마다 그 도시 미세먼지 중 가장 나쁜 값
    let pm10 = -1, pm25 = -1;
    for (const { data, times } of list) {
      if (!data.air || !data.air.hourly) continue;
      data.air.hourly.time.forEach((tt, i) => {
        if (!times.has(tt)) return;
        if (isNum(data.air.hourly.pm10[i])) pm10 = Math.max(pm10, data.air.hourly.pm10[i]);
        if (isNum(data.air.hourly.pm2_5[i])) pm25 = Math.max(pm25, data.air.hourly.pm2_5[i]);
      });
    }
    if (pm10 < 0 && pm25 < 0) return null;
    pm10 = Math.max(pm10, 0); pm25 = Math.max(pm25, 0);
    return { pm10, pm25, grade: airGrade(pm10, pm25) };
  }

  // ── 확인하기
  $("go").onclick = async () => {
    const btn = $("go");
    btn.disabled = true;
    $("status").textContent = "82개 시나리오를 불러오는 중…";
    try {
      const [o, d] = await Promise.all([load(state.from), load(state.to)]);
      const ok = compute(o, d);
      if (!ok) { $("status").textContent = "이 시간대는 예보 범위 밖이에요. 다른 날짜나 시간을 골라 주세요."; return; }
      $("status").textContent = "";
      showResult();
    } catch (e) {
      $("status").innerHTML = `<span class="err">예보를 불러오지 못했어요 (${e.message}). 잠시 뒤 다시 눌러 주세요.</span>`;
    } finally {
      btn.disabled = false;
    }
  };

  function compute(o, d) {
    const times = o.ens.hourly.time;
    const date = dates[state.dateIdx].date;
    const { idx, from, to } = windowIndices(times, date, state.start, state.end);
    if (!idx.length) return false;
    const sameCity = state.from === state.to;
    const members = routeMembers(o.members, sameCity ? null : d.members, idx);
    const r = judge(members, idx);
    if (!r) return false;

    // 구간 나누기: 출발(출발지) / 머무는 동안(도착지) / 집 도착(출발지)
    const mid = idx.slice(1, -1);
    const segs = [];
    segs.push({ t: from.slice(11), place: state.from, label: "출발", idx: [idx[0]] });
    if (mid.length) segs.push({ t: `${times[mid[0]].slice(11, 13)}~${times[mid[mid.length - 1]].slice(11, 13)}시`, place: state.to, label: sameCity ? "외출 중" : "도착지", idx: mid });
    if (idx.length > 1) segs.push({ t: to.slice(11), place: state.from, label: "집 도착", idx: [idx[idx.length - 1]] });
    segs.forEach((s) => { s.sum = segmentSummary(members, s.idx); });

    const air = airWorst([
      { data: o, times: new Set([idx[0], idx[idx.length - 1]].map((i) => times[i])) },
      { data: sameCity ? o : d, times: new Set((mid.length ? mid : idx).map((i) => times[i])) },
    ]);
    last = { r, segs, air, from, to, sameCity, at: o.at };
    return true;
  }

  // ── 결과 화면 그리기
  function showResult() {
    const { r, segs, air, from, to, sameCity, at } = last;
    const items = buildItems(r, air);
    const dl = dates[state.dateIdx].label;
    const nextDay = to.slice(0, 10) !== from.slice(0, 10) ? " (다음 날)" : "";
    $("summary").textContent = `${sameCity ? state.from : `${state.from} → ${state.to}`} · ${dl} ${from.slice(11)}~${to.slice(11)}${nextDay}`;
    $("headLabel").textContent = `${dl}의 결론`;
    $("headline").textContent = buildHeadline(r, items);

    $("route").innerHTML = segs.map((s) => `
      <li><span class="t">${s.t}</span>
        <span><b>${s.label}</b> <span class="p">${s.place}</span></span>
        <span class="w">${s.sum ? `체감 ${Math.round(s.sum.feels)}°C${s.sum.wet >= 0.1 ? ` · ☔ ${Math.round(s.sum.wet * 100)}%` : ""}` : "-"}</span></li>`).join("");

    $("items").innerHTML = items.map((it) => `
      <li class="${it.on ? "" : "off"}">
        <span class="ic">${it.icon}</span>
        <span><span class="what">${it.what}</span><br><span class="why">${it.why}</span></span>
        <span class="badge ${it.conf.key}">${it.conf.label}</span>
      </li>`).join("");

    const tip = buildTip(items);
    $("tip").hidden = !tip;
    $("tip").textContent = tip || "";

    const cmp = $("compare");
    if (r.wet >= 0.1) {
      cmp.className = "panel compare";
      cmp.innerHTML = `
        <div><span class="n">${Math.round(r.hourlyMax * 100)}%</span><p>시간대별로 본<br>가장 높은 비·눈 확률</p></div>
        <div class="hl"><span class="n">${Math.round(r.wet * 100)}%</span><p>외출하는 동안 한 번이라도<br>비·눈을 만날 확률</p></div>
        <p class="note">일반 예보는 시간마다 따로 확률을 보여줘요. 챙길까?는 외출 시간 전체를 한 번에 봐요.</p>`;
    } else {
      cmp.className = "panel";
      cmp.innerHTML = `<p class="sub">이번 외출은 82개 중 ${Math.round(r.wet * r.n)}개만 비·눈을 만나요. 비 오는 날엔 여기서 "시간대별 확률"과 "외출 전체 확률"이 얼마나 다른지 보여드려요.</p>`;
    }

    renderDots();
    $("updated").textContent = `예보 불러온 시각 ${at.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`;

    $("screenInput").hidden = true;
    $("screenResult").hidden = false;
    window.scrollTo(0, 0);
    goPage(0, false);
  }

  function renderDots() {
    if (!last) return;
    const r = last.r;
    document.querySelectorAll("#dotTabs button").forEach((b) => b.classList.toggle("on", b.dataset.k === state.dotTab));
    const box = $("dots"), cap = $("dotsCaption");
    if (state.dotTab === "rain" || state.dotTab === "snow") {
      const k = state.dotTab;
      const on = r.per.filter((p) => p[k]).length;
      box.innerHTML = `<div class="grid">${r.per.map((p) => `<span class="dot ${p[k] ? k : ""}" title="${p.m.model}"></span>`).join("")}</div>`;
      cap.textContent = `${r.n}번 중 ${on}번, 외출하는 동안 ${k === "rain" ? "비" : "눈"}가 왔어요.`;
      return;
    }
    const sorted = [...r.per].sort((a, b) => a.minFeels - b.minFeels);
    const lo = Math.round(sorted[0].minFeels), hi = Math.round(sorted[sorted.length - 1].minFeels);
    const used = [...new Set(sorted.map((p) => coatLevel(p.minFeels)))].sort((a, b) => a - b);
    box.innerHTML =
      `<div class="grid">${sorted.map((p) => `<span class="dot" title="${p.m.model} 체감 ${p.minFeels.toFixed(1)}°C" style="background:${tempColor(p.minFeels)}"></span>`).join("")}</div>` +
      `<div class="legend"><span>← 가장 추운 시나리오 ${lo}°C</span><span>가장 따뜻한 시나리오 ${hi}°C →</span></div>` +
      `<div class="legend">${used.map((i) => `<span><i style="background:${COAT_LEVELS[i].color}"></i>${COAT_LEVELS[i].name} ${sorted.filter((p) => coatLevel(p.minFeels) === i).length}개</span>`).join("")}</div>`;
    const spreadMsg = hi - lo <= 4
      ? `${lo}~${hi}°C 안에 모여 있어서 예보가 확실한 편이에요.`
      : used.length === 1
        ? `${lo}~${hi}°C로 퍼져 있지만, 모두 ${COAT_LEVELS[used[0]].name} 구간이라 옷 판단은 확실해요.`
        : `${lo}~${hi}°C로 넓게 퍼져 있어서 예보가 흔들리는 날이에요.`;
    cap.textContent = `점 하나가 시나리오 하나예요. 외출 중 가장 추울 때 체감온도가 ${spreadMsg}`;
  }
  document.querySelectorAll("#dotTabs button").forEach((b) => {
    b.onclick = () => { state.dotTab = b.dataset.k; renderDots(); };
  });

  // ── 페이지 넘기기 (손가락으로 밀거나 버튼으로)
  const pager = $("pager");
  const pages = [...pager.children];
  const pdots = $("pdots");
  pages.forEach((_, i) => {
    const s = document.createElement("span");
    s.onclick = () => goPage(i);
    pdots.appendChild(s);
  });
  function paintNav() {
    [...pdots.children].forEach((s, i) => s.classList.toggle("on", i === state.page));
    $("prev").disabled = state.page === 0;
    $("next").disabled = state.page === pages.length - 1;
    // 현재 페이지 높이에 맞추기 (긴 페이지 때문에 짧은 페이지 아래가 비지 않게)
    pager.style.height = pages[state.page].scrollHeight + "px";
  }
  function goPage(i, smooth = true) {
    state.page = Math.max(0, Math.min(pages.length - 1, i));
    pager.scrollTo({ left: pages[state.page].offsetLeft - pager.offsetLeft, behavior: smooth ? "smooth" : "auto" });
    paintNav();
    if (smooth) window.scrollTo({ top: 0, behavior: "smooth" });
  }
  let scrollTimer = null;
  pager.addEventListener("scroll", () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      const i = Math.round(pager.scrollLeft / (pager.clientWidth + 16));
      if (i !== state.page) { state.page = i; paintNav(); }
    }, 80);
  });
  $("prev").onclick = () => goPage(state.page - 1);
  $("next").onclick = () => goPage(state.page + 1);
  window.addEventListener("resize", () => { if (last) paintNav(); });

  $("back").onclick = () => {
    $("screenResult").hidden = true;
    $("screenInput").hidden = false;
    window.scrollTo(0, 0);
  };
}
