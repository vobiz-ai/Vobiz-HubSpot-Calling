/* eslint-disable no-use-before-define */
/* eslint-disable no-undef */
import { v4 as uuidv4 } from "uuid";
import JsSIP from "jssip";

const CallingExtensions = (typeof window !== "undefined" && window.default) || class {};
const Constants = (typeof window !== "undefined" && window.Constants) || {
  messageType: { ERROR: "ERROR", INFO: "INFO", WARNING: "WARNING", SUCCESS: "SUCCESS" },
  callEndStatus: {
    INTERNAL_COMPLETED: "INTERNAL_COMPLETED",
    COMPLETED: "COMPLETED",
    BUSY: "BUSY",
    NO_ANSWER: "NO_ANSWER",
    FAILED: "FAILED",
    CANCELED: "CANCELED",
    REJECTED: "REJECTED",
  },
};
const { messageType, callEndStatus } = Constants;

/** === Backend & Agent Configuration === */
function getQueryParam(param) {
  if (typeof window === "undefined") return "";
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(param) || "";
}

const BACKEND_URL = getQueryParam("backendUrl") || (typeof window !== "undefined" ? window.location.origin : "http://localhost:8092");
const AGENT_ID = getQueryParam("agentId") || "test-agent";
const VOBIZ_SIP_DOMAIN = "registrar.vobiz.ai";
const VOBIZ_SIP_WS_URI = "wss://registrar.vobiz.ai:5063/";

let vobizUA = null;
let currentRTCSession = null;
let pendingIncomingSession = null;
let sipRegistered = false;
let accountReady = false;
let micStream = null;

const AUTH_MODE_KEY = "vobiz.authMode";
const SIP_CREDS_KEY = "vobiz.sipDirect";
const ACCOUNT_CREDS_KEY = "vobiz.accountCreds";
let authMode = "account";

export const state = {
  externalCallId: "",
  engagementId: 0,
  fromNumber: "",
  incomingContactName: "",
  toNumber: "",
  userAvailable: false,
  userId: 0,
  portalId: 0,
  ownerId: 0,
  usesCallingWindow: getQueryParam("usesCallingWindow") !== "false",
  iframeLocation: getQueryParam("iframeLocation") || "widget",
  cdrLogs: [],
  lastCallDetails: null,
};

const sizeInfo = {
  width: 400,
  height: 650,
};

function isInsideHubSpotIframe() {
  try {
    return typeof window !== "undefined" && window.self !== window.top;
  } catch {
    return true;
  }
}

function notifyHubSpot(action) {
  if (!isInsideHubSpotIframe()) return;
  try {
    action();
  } catch (e) {
    // Harmless when running standalone outside HubSpot
  }
}

function readStore(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}

function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/**
 * Custom fetch that bypasses ngrok warnings if backend is hosted through a tunnel.
 */
async function backendFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { "ngrok-skip-browser-warning": "1", ...(options.headers || {}) },
  });
}

/** === Status Badge & Message (Matching Freshdesk) === */
function statusState(text) {
  if (/^ready/i.test(text)) return { label: "Ready", tone: "ok" };
  if (/^on a call/i.test(text)) return { label: "On a call", tone: "busy" };
  if (/^call ringing|ringing/i.test(text)) return { label: "Ringing", tone: "busy" };
  if (/^connecting/i.test(text)) return { label: "Connecting", tone: "pending" };
  if (/reconnecting/i.test(text)) return { label: "Reconnecting", tone: "pending" };
  if (/^not configured|must start with|cannot reach|could not load|registration failed|failed|offline/i.test(text)) {
    return { label: "Offline", tone: "error" };
  }
  return { label: "Offline", tone: "error" };
}

export function setStatus(text) {
  const el = document.getElementById("status");
  const msg = document.getElementById("status-message");
  const { label, tone } = statusState(text);

  if (el) {
    el.textContent = label;
    el.className = `status-badge is-${tone}`;
  }

  if (msg) {
    const redundant = label.toLowerCase() === (text || "").trim().toLowerCase();
    msg.textContent = redundant ? "" : text;
    msg.style.display = redundant ? "none" : "block";
    msg.className = `status-message is-${tone}`;
  }
}

export function setLoginStatus(text, isError = false) {
  const el = document.getElementById("vobiz-login-status");
  if (el) {
    el.textContent = text;
    el.className = isError ? "hint is-error" : "hint";
  }
}

/** === Live Call Duration & Status === */
let callTimerHandle = null;
let callTimerStartedAt = null;

function setCallStatus(text) {
  const container = document.getElementById("callnum");
  const textEl = document.getElementById("call-status-text");
  if (!container) return;
  if (text) {
    if (textEl) textEl.textContent = text;
    container.style.display = "flex";
  } else {
    container.style.display = "none";
  }
}

function startCallTimer() {
  stopCallTimer();
  callTimerStartedAt = Date.now();
  const tick = () => {
    const secs = Math.floor((Date.now() - callTimerStartedAt) / 1000);
    const mm = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss = String(secs % 60).padStart(2, "0");
    setCallStatus(`On call — ${mm}:${ss}`);
  };
  tick();
  callTimerHandle = window.setInterval(tick, 1000);
}

function stopCallTimer() {
  let elapsedSecs = 0;
  if (callTimerStartedAt) {
    elapsedSecs = Math.floor((Date.now() - callTimerStartedAt) / 1000);
    callTimerStartedAt = null;
  }
  if (callTimerHandle) {
    window.clearInterval(callTimerHandle);
    callTimerHandle = null;
  }
  return elapsedSecs;
}

/** === Microphone Pre-warm === */
function micStreamIsLive() {
  return Boolean(micStream) && micStream.getAudioTracks().some(t => t.readyState === "live");
}

export async function ensureMicPermission() {
  if (micStreamIsLive()) return micStream;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("navigator.mediaDevices is unavailable in this frame");
    }
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    console.log("[VoBiz SIP] Microphone ready — permission granted");
    return micStream;
  } catch (err) {
    micStream = null;
    console.error("[VoBiz SIP] Microphone unavailable:", err && err.name, err && err.message);
    setCallStatus("Microphone blocked — allow mic access in your browser.");
    return null;
  }
}

/** === Caller ID UI Selection === */
function renderNumberOptions(numbers, selected) {
  const select = document.getElementById("vobiz-number-select");
  const label = document.getElementById("vobiz-number-label");
  if (!select) return;
  select.innerHTML = "";
  const list = numbers || [];
  list.forEach(n => {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    if (n === selected) opt.selected = true;
    select.appendChild(opt);
  });
  const hasNumbers = list.length > 0;
  select.style.display = hasNumbers ? "block" : "none";
  if (label) label.style.display = hasNumbers ? "block" : "none";
}

function setHangupVisible(visible) {
  const btn = document.getElementById("hangupbtn");
  if (btn) btn.style.display = visible ? "inline-flex" : "none";
}

function setDialEnabled(enabled) {
  accountReady = Boolean(enabled);
  refreshDialState();
}

function setSipRegistered(isRegistered) {
  sipRegistered = Boolean(isRegistered);
  refreshDialState();
}

function refreshDialState() {
  const btn = document.getElementById("dialbtn");
  const hint = document.getElementById("dial-hint");
  const ready = accountReady && sipRegistered;

  if (btn) {
    if (ready) btn.removeAttribute("disabled");
    else btn.setAttribute("disabled", "true");
  }

  if (hint) {
    if (ready) hint.textContent = "";
    else if (!accountReady && !sipRegistered) hint.textContent = "Log in and wait for the panel to register before calling.";
    else if (!accountReady) hint.textContent = "Log in with your VoBiz credentials to enable calling.";
    else hint.textContent = "Connecting SIP registration…";
  }
}

/** === WebRTC Audio Attachment === */
function attachRemoteAudio(session) {
  const audioEl = document.getElementById("vobiz-remote-audio");
  if (!audioEl) return;
  const bindTrack = pc => {
    if (!pc) return;
    pc.addEventListener("track", event => {
      audioEl.srcObject = event.streams[0];
      audioEl.play().catch(err => console.warn("[VoBiz] audio autoplay blocked:", err));
    });
  };
  session.on("peerconnection", e => bindTrack(e.peerconnection));
  bindTrack(session.connection);
}

/** === Shared SIP Stack Initializer === */
export function startSipUA(sipUser, sipPassword, displayName, registrarUrl) {
  setStatus(`Connecting as ${displayName || sipUser}…`);

  if (vobizUA) {
    try { vobizUA.removeAllListeners(); } catch (e) {}
    try { vobizUA.stop(); } catch (e) {}
    vobizUA = null;
  }

  const cleanUri = sipUser.startsWith("sip:") ? sipUser : `sip:${sipUser}`;
  const wsUri = registrarUrl || VOBIZ_SIP_WS_URI;
  const vobizSocket = new JsSIP.WebSocketInterface(wsUri);
  vobizUA = new JsSIP.UA({
    sockets: [vobizSocket],
    uri: cleanUri,
    password: sipPassword,
    register: true,
    session_timers: false,
    user_agent: "VobizHubSpotCalling/2.0.0",
  });

  vobizUA.on("connected", () => console.log("[VoBiz SIP] WebSocket connected to registrar"));
  vobizUA.on("disconnected", () => {
    setSipRegistered(false);
    setStatus("Disconnected from registrar");
  });
  vobizUA.on("registered", () => {
    setSipRegistered(true);
    setStatus(`Ready — registered as ${(displayName || cleanUri).split("@")[0]}`);
  });
  vobizUA.on("registrationFailed", e => {
    setSipRegistered(false);
    setStatus(`Registration failed: ${(e && e.cause) || "unknown"}`);
  });
  vobizUA.on("unregistered", () => {
    setSipRegistered(false);
    setStatus("Not registered — reconnecting…");
  });

  /**
   * INBOUND CALL HANDLING
   */
  vobizUA.on("newRTCSession", data => {
    if (data.originator !== "remote") return;

    const remote = data.session.remote_identity;
    const callerNumber = (remote && remote.uri && remote.uri.user) || "Unknown";
    const fromNumber = callerNumber.startsWith("+") ? callerNumber : `+${callerNumber}`;

    const numberSelect = document.getElementById("vobiz-number-select");
    const ownNumber = (numberSelect && numberSelect.value) || state.fromNumber || "VoBiz Line";

    state.externalCallId = uuidv4();
    state.fromNumber = fromNumber;
    pendingIncomingSession = data.session;

    console.log("[VoBiz SIP] Real inbound call received from", fromNumber, "to", ownNumber);

    // 1. Notify HubSpot CTI
    notifyHubSpot(() => {
      cti.incomingCall({
        createEngagement: true,
        externalCallId: state.externalCallId,
        fromNumber,
        toNumber: ownNumber,
        callStartTime: Date.now(),
      });
    });

    // 2. Show on-screen popup modal
    showIncomingCallPopup(fromNumber, ownNumber);

    // 3. Desktop Notification if granted
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification("Incoming VoBiz Call", {
          body: `Call from ${fromNumber} to ${ownNumber}`,
          icon: "styles/images/icon.svg",
        });
      } catch (e) {
        console.warn("Desktop notification error:", e);
      }
    }

    pendingIncomingSession.on("ended", () => {
      hideIncomingCallPopup();
      setStatus("Call ended");
      notifyHubSpot(() => {
        cti.callEnded({ callEndStatus: callEndStatus.INTERNAL_COMPLETED, externalCallId: state.externalCallId });
      });
      pendingIncomingSession = null;
    });

    pendingIncomingSession.on("failed", e => {
      hideIncomingCallPopup();
      setStatus(`Call failed: ${(e && e.cause) || "caller hung up"}`);
      notifyHubSpot(() => {
        cti.callEnded({ callEndStatus: callEndStatus.FAILED, externalCallId: state.externalCallId });
      });
      pendingIncomingSession = null;
    });
  });

  vobizUA.start();
}

/** === SIP Stack Initialization (Account Mode) === */
export async function initVobizSip() {
  let agent;
  try {
    const res = await backendFetch(`${BACKEND_URL}/agent/${encodeURIComponent(AGENT_ID)}`);
    if (!res.ok) {
      setStatus(`Could not load SIP identity for ${AGENT_ID}`);
      setSipRegistered(false);
      return;
    }
    agent = await res.json();
  } catch (err) {
    console.error("[VoBiz] Could not reach calling backend:", err);
    setStatus("Cannot reach the calling backend");
    setSipRegistered(false);
    return;
  }

  startSipUA(agent.sipUser, agent.sipPassword, agent.displayName, agent.registrarUrl);
}

let incomingPending = false;
let ringCtx = null;
let ringTimer = null;

function startRingtone() {
  stopRingtone();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ringCtx = new Ctx();
    const beep = () => {
      if (!ringCtx) return;
      const osc = ringCtx.createOscillator();
      const gain = ringCtx.createGain();
      osc.frequency.value = 440;
      gain.gain.setValueAtTime(0.0001, ringCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, ringCtx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ringCtx.currentTime + 0.9);
      osc.connect(gain).connect(ringCtx.destination);
      osc.start();
      osc.stop(ringCtx.currentTime + 0.95);
    };
    beep();
    ringTimer = setInterval(beep, 2000);
  } catch (err) {
    console.warn("[VoBiz] Ringtone error:", err);
  }
}

function stopRingtone() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  if (ringCtx) {
    try { ringCtx.close(); } catch (e) {}
    ringCtx = null;
  }
}

/** === Screen Pop-up Modal UI Controls === */
export function showIncomingCallPopup(callerNumber, destNumber) {
  incomingPending = true;
  startRingtone();
  const popup = document.getElementById("vobiz-incoming-popup");
  const callerEl = document.getElementById("incoming-caller-number");
  const destEl = document.getElementById("incoming-caller-dest");

  if (callerEl) callerEl.textContent = callerNumber;
  if (destEl) destEl.textContent = `Calling ${destNumber}…`;
  if (popup) {
    popup.style.display = "flex";
    popup.removeAttribute("hidden");
  }

  setStatus(`Call ringing in from ${callerNumber}…`);
}

export function hideIncomingCallPopup() {
  incomingPending = false;
  stopRingtone();
  const popup = document.getElementById("vobiz-incoming-popup");
  if (popup) {
    popup.style.display = "none";
    popup.setAttribute("hidden", "true");
  }
}

/** Agent clicks "Answer" on screen popup */
export async function answerIncomingCall() {
  hideIncomingCallPopup();
  if (!pendingIncomingSession) {
    console.warn("No pending inbound session to answer.");
    return;
  }

  currentRTCSession = pendingIncomingSession;
  pendingIncomingSession = null;
  attachRemoteAudio(currentRTCSession);

  const stream = await ensureMicPermission();
  try {
    currentRTCSession.answer({
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
      sessionTimersExpires: 300,
      ...(stream ? { mediaStream: stream } : {}),
    });

    setHangupVisible(true);
    setStatus("On a call");
    startCallTimer();
    notifyHubSpot(() => cti.callAnswered({ externalCallId: state.externalCallId }));

    currentRTCSession.on("confirmed", () => {
      setStatus("On a call");
    });

    currentRTCSession.on("ended", () => {
      const duration = stopCallTimer();
      setCallStatus("Call ended");
      setHangupVisible(false);
      setStatus("Ready");
      currentRTCSession = null;
      notifyHubSpot(() => {
        cti.callEnded({ callEndStatus: callEndStatus.INTERNAL_COMPLETED, externalCallId: state.externalCallId });
      });
      setTimeout(loadRecordings, 4000);
    });

    currentRTCSession.on("failed", e => {
      stopCallTimer();
      setCallStatus("Call failed");
      setHangupVisible(false);
      setStatus("Ready");
      currentRTCSession = null;
      notifyHubSpot(() => {
        cti.callEnded({ callEndStatus: callEndStatus.FAILED, externalCallId: state.externalCallId });
      });
    });
  } catch (err) {
    console.error("[VoBiz] Error answering call:", err);
    setStatus(`Could not answer call: ${err.message}`);
  }
}

/** Agent clicks "Decline" on screen popup */
export function declineIncomingCall() {
  hideIncomingCallPopup();
  if (pendingIncomingSession) {
    try {
      pendingIncomingSession.terminate();
    } catch (e) {
      console.warn("Error declining session:", e);
    }
    pendingIncomingSession = null;
  }

  notifyHubSpot(() => {
    cti.callEnded({
      callEndStatus: callEndStatus.REJECTED,
      externalCallId: state.externalCallId,
    });
  });

  setStatus("Call declined");
  setTimeout(() => setStatus("Ready"), 3000);
}

/** === Dual Mode Switching (VoBiz Account vs SIP Direct) === */
export function setAuthMode(mode) {
  authMode = mode === "sip" ? "sip" : "account";
  writeStore(AUTH_MODE_KEY, authMode);

  const isSip = authMode === "sip";
  const modeAccount = document.getElementById("mode-account");
  const modeSip = document.getElementById("mode-sip");
  const stepCallerId = document.getElementById("step-caller-id");
  const tabAccount = document.getElementById("mode-account-tab");
  const tabSip = document.getElementById("mode-sip-tab");

  if (modeAccount) modeAccount.style.display = isSip ? "none" : "block";
  if (modeSip) modeSip.style.display = isSip ? "block" : "none";
  if (stepCallerId) stepCallerId.style.display = isSip ? "none" : "block";

  if (tabAccount) {
    tabAccount.classList.toggle("is-active", !isSip);
    tabAccount.setAttribute("aria-selected", String(!isSip));
  }
  if (tabSip) {
    tabSip.classList.toggle("is-active", isSip);
    tabSip.setAttribute("aria-selected", String(isSip));
  }
}

export function restoreAuthMode() {
  const savedMode = readStore(AUTH_MODE_KEY) || "account";
  setAuthMode(savedMode);

  if (savedMode === "sip") {
    const saved = readStore(SIP_CREDS_KEY);
    if (!saved || !saved.username) return;
    const usernameInput = document.getElementById("sip-username");
    const passwordInput = document.getElementById("sip-password");
    const callerIdInput = document.getElementById("sip-caller-id");
    const rememberInput = document.getElementById("sip-remember");

    if (usernameInput) usernameInput.value = saved.username || "";
    if (passwordInput) passwordInput.value = saved.password || "";
    if (callerIdInput) callerIdInput.value = saved.callerId || "";
    if (rememberInput) rememberInput.checked = true;

    if (saved.password && saved.callerId) {
      sipDirectConnect();
    }
  } else {
    const saved = readStore(ACCOUNT_CREDS_KEY);
    if (!saved || !saved.authId) return;
    const authIdInput = document.getElementById("vobiz-auth-id");
    const authTokenInput = document.getElementById("vobiz-auth-token");
    const rememberInput = document.getElementById("vobiz-remember");

    if (authIdInput) authIdInput.value = saved.authId || "";
    if (authTokenInput) authTokenInput.value = saved.authToken || "";
    if (rememberInput) rememberInput.checked = true;

    if (saved.authId && saved.authToken) {
      vobizLogin();
    }
  }
}

/** === SIP Direct Connect === */
export async function sipDirectConnect() {
  const usernameInput = document.getElementById("sip-username");
  const passwordInput = document.getElementById("sip-password");
  const callerIdInput = document.getElementById("sip-caller-id");
  const rememberInput = document.getElementById("sip-remember");

  const username = (usernameInput && usernameInput.value.trim()) || "";
  const password = (passwordInput && passwordInput.value) || "";
  const callerId = (callerIdInput && callerIdInput.value.trim()) || "";
  const remember = Boolean(rememberInput && rememberInput.checked);

  if (!username || !password) {
    setLoginStatus("Enter the endpoint's SIP username and password.", true);
    return;
  }
  if (!callerId) {
    setLoginStatus("Enter the number to call from — carriers reject a call without one.", true);
    return;
  }

  writeStore(SIP_CREDS_KEY, remember ? { username, password, callerId } : null);

  const cleanUsername = username.includes("@") ? username.split("@")[0] : username;
  const sipUser = `${cleanUsername}@${VOBIZ_SIP_DOMAIN}`;
  setLoginStatus(`Signing in as ${cleanUsername}…`);

  try {
    await backendFetch(`${BACKEND_URL}/login-sip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID, sipUser: cleanUsername, sipPassword: password, callerId }),
    });
  } catch (err) {
    console.warn("[VoBiz] Backend /login-sip registration note:", err);
  }

  state.fromNumber = callerId;
  showLoggedInState(cleanUsername, callerId, [callerId]);
  setDialEnabled(true);
  notifyHubSpot(() => cti.userLoggedIn());
  startSipUA(sipUser, password, cleanUsername);
  ensureMicPermission();
  setLoginStatus("Connected via SIP direct.");
}

/** === VoBiz Account Authentication (Auth ID / Auth Token) === */
export async function vobizLogin() {
  const authIdInput = document.getElementById("vobiz-auth-id");
  const authTokenInput = document.getElementById("vobiz-auth-token");
  const authId = (authIdInput && authIdInput.value.trim()) || "";
  const authToken = (authTokenInput && authTokenInput.value.trim()) || "";

  if (!authId || !authToken) {
    setLoginStatus("Enter both an Auth ID and an Auth Token.", true);
    return;
  }

  setLoginStatus("Signing in…");
  try {
    const res = await backendFetch(`${BACKEND_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID, authId, authToken }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Login failed (${res.status})`);

    const rememberInput = document.getElementById("vobiz-remember");
    const remember = !rememberInput || Boolean(rememberInput.checked);
    writeStore(ACCOUNT_CREDS_KEY, remember ? { authId, authToken } : null);

    // Update UI
    showLoggedInState(data.authId || authId, data.selected, data.numbers);
    setLoginStatus("Signed in successfully.");

    setDialEnabled(Boolean(data.selected || (data.numbers && data.numbers.length)));
    notifyHubSpot(() => cti.userLoggedIn());
    initVobizSip();
    ensureMicPermission();

    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }

    loadRecordings();
  } catch (err) {
    console.error("[VoBiz] Login failed:", err);
    setLoginStatus(`Login failed: ${err.message}`, true);
    setDialEnabled(false);
  }
}

export async function vobizLogout() {
  try {
    await backendFetch(`${BACKEND_URL}/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID }),
    });
  } catch (e) {
    console.warn("Logout error:", e);
  }

  writeStore(ACCOUNT_CREDS_KEY, null);
  writeStore(SIP_CREDS_KEY, null);

  showLoggedOutState();
  setDialEnabled(false);
  setSipRegistered(false);
  if (vobizUA) {
    try { vobizUA.stop(); } catch (e) {}
    vobizUA = null;
  }
  notifyHubSpot(() => cti.userLoggedOut());
  setStatus("Offline");
  setLoginStatus("Signed out.");
}

function showLoggedInState(authId, selectedNumber, numbers) {
  const modeAccount = document.getElementById("mode-account");
  const modeSip = document.getElementById("mode-sip");
  const userCard = document.getElementById("vobiz-user-card");
  const userAuthId = document.getElementById("vobiz-user-auth-id");
  const userFrom = document.getElementById("vobiz-user-from");
  const logoutBtn = document.getElementById("vobiz-logout-btn");
  const tabs = document.querySelector(".tabs");

  if (tabs) tabs.style.display = "none";
  if (modeAccount) modeAccount.style.display = "none";
  if (modeSip) modeSip.style.display = "none";
  if (userCard) userCard.style.display = "flex";
  if (userAuthId) userAuthId.textContent = authId;
  if (userFrom) userFrom.textContent = selectedNumber ? `Caller ID: ${selectedNumber}` : "No caller ID assigned";
  if (logoutBtn) logoutBtn.style.display = "inline-flex";

  if (authMode !== "sip") {
    renderNumberOptions(numbers, selectedNumber);
  }
}

function showLoggedOutState() {
  const userCard = document.getElementById("vobiz-user-card");
  const logoutBtn = document.getElementById("vobiz-logout-btn");
  const select = document.getElementById("vobiz-number-select");
  const label = document.getElementById("vobiz-number-label");
  const tabs = document.querySelector(".tabs");

  if (tabs) tabs.style.display = "flex";
  if (userCard) userCard.style.display = "none";
  if (logoutBtn) logoutBtn.style.display = "none";
  if (select) select.style.display = "none";
  if (label) label.style.display = "none";

  setAuthMode(authMode);
}

export async function restoreVobizSession() {
  try {
    const res = await backendFetch(`${BACKEND_URL}/session/${encodeURIComponent(AGENT_ID)}`);
    const session = await res.json();
    if (session.loggedIn) {
      showLoggedInState(session.authId, session.from, session.numbers);
      setLoginStatus(`Signed in as ${session.authId}`);
      setDialEnabled(true);
      notifyHubSpot(() => cti.userLoggedIn());
      initVobizSip();
      loadRecordings();
    } else {
      showLoggedOutState();
      restoreAuthMode();
    }
  } catch (err) {
    console.warn("[VoBiz] Could not restore session:", err);
    showLoggedOutState();
    restoreAuthMode();
  }
}

export async function vobizSelectNumber() {
  const number = document.getElementById("vobiz-number-select").value;
  try {
    const res = await backendFetch(`${BACKEND_URL}/select-number`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID, number }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Failed to switch number (${res.status})`);
    const userFrom = document.getElementById("vobiz-user-from");
    if (userFrom) userFrom.textContent = `Caller ID: ${data.selected}`;
    setLoginStatus(`Caller ID set to ${data.selected}`);
  } catch (err) {
    console.error("[VoBiz] Switch number failed:", err);
    setLoginStatus(`Could not switch number: ${err.message}`, true);
  }
}

/** === Outbound Dialing === */
export async function placeCall(number) {
  if (!number) return;
  state.toNumber = number;

  const numEl = document.getElementById("callnum");
  const statusText = document.getElementById("call-status-text");
  if (numEl && statusText) {
    statusText.textContent = `Calling ${number}…`;
    numEl.style.display = "flex";
  }

  if (!vobizUA || !sipRegistered) {
    const msg = "Not registered yet — wait for the status badge to show Ready.";
    if (statusText) statusText.textContent = msg;
    setLoginStatus(msg, true);
    return;
  }

  await ensureMicPermission();
  state.externalCallId = uuidv4();

  const numberSelect = document.getElementById("vobiz-number-select");
  const ownNumber = (numberSelect && numberSelect.value) || state.fromNumber || "";

  notifyHubSpot(() => {
    cti.outgoingCall({
      createEngagement: true,
      toNumber: state.toNumber,
      fromNumber: ownNumber,
      externalCallId: state.externalCallId,
    });
  });

  const target = `sip:${String(number).replace(/[^\d+]/g, "")}@${VOBIZ_SIP_DOMAIN}`;
  console.log("[VoBiz] Sending INVITE to", target);

  try {
    const session = vobizUA.call(target, {
      mediaConstraints: { audio: true, video: false },
      pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
      sessionTimersExpires: 300,
      ...(micStream ? { mediaStream: micStream } : {}),
    });

    currentRTCSession = session;
    attachRemoteAudio(session);
    setHangupVisible(true);
    startCallTimer();

    session.on("progress", () => {
      if (statusText) statusText.textContent = `Ringing ${number}…`;
      setStatus(`Ringing ${number}…`);
    });

    session.on("confirmed", () => {
      if (statusText) statusText.textContent = `On a call with ${number}`;
      setStatus("On a call");
      notifyHubSpot(() => cti.callAnswered({ externalCallId: state.externalCallId }));
    });

    session.on("failed", e => {
      const cause = (e && e.cause) || "unknown";
      stopCallTimer();
      setCallStatus(`Call failed — ${cause}`);
      setStatus("Ready");
      currentRTCSession = null;
      setHangupVisible(false);
      notifyHubSpot(() => {
        cti.callEnded({ callEndStatus: callEndStatus.FAILED, externalCallId: state.externalCallId });
      });
    });

    session.on("ended", () => {
      stopCallTimer();
      setCallStatus("Call ended");
      setStatus("Ready");
      currentRTCSession = null;
      setHangupVisible(false);
      notifyHubSpot(() => {
        cti.callEnded({ externalCallId: state.externalCallId });
      });
      setTimeout(loadRecordings, 5000);
      setTimeout(() => setCallStatus(""), 4000);
    });
  } catch (err) {
    console.error("[VoBiz] Could not place call:", err);
    stopCallTimer();
    setCallStatus(`Could not place call: ${err.message}`);
    setHangupVisible(false);
    currentRTCSession = null;
    notifyHubSpot(() => {
      cti.callEnded({ callEndStatus: callEndStatus.FAILED, externalCallId: state.externalCallId });
    });
  }
}

export function hangUp() {
  if (currentRTCSession) {
    try {
      currentRTCSession.terminate();
    } catch (err) {
      console.warn("[VoBiz] Hangup failed:", err);
    }
  }
}

/** === Inbound Setup === */
export async function setupInboundCalling() {
  const statusEl = document.getElementById("inbound-setup-status");
  const btn = document.getElementById("setup-inbound-btn");
  if (statusEl) {
    statusEl.textContent = "Setting up inbound routing…";
    statusEl.className = "hint";
  }
  if (btn) btn.setAttribute("disabled", "true");

  try {
    const res = await backendFetch(`${BACKEND_URL}/setup-inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Setup failed (${res.status})`);
    if (statusEl) {
      statusEl.textContent = `Inbound calls to ${data.number} now ring this panel.`;
      statusEl.className = "hint is-ok";
    }
  } catch (err) {
    console.error("[VoBiz] Inbound setup failed:", err);
    if (statusEl) {
      statusEl.textContent = `Setup failed: ${err.message}`;
      statusEl.className = "hint is-error";
    }
  } finally {
    if (btn) btn.removeAttribute("disabled");
  }
}

/** === Provision Dedicated HubSpot App, Endpoint & Number === */
export async function provisionDedicatedHubSpotApp() {
  const statusEl = document.getElementById("inbound-setup-status");
  const btn = document.getElementById("provision-dedicated-btn");
  const tunnelInput = document.getElementById("hubspot-tunnel-url");
  const numberInput = document.getElementById("hubspot-link-number");

  const tunnelUrl = (tunnelInput && tunnelInput.value.trim()) || "";
  const number = (numberInput && numberInput.value.trim()) || "+91XXXXXXXXXX";

  if (!tunnelUrl || !tunnelUrl.startsWith("https://")) {
    if (statusEl) {
      statusEl.textContent = "Enter a valid public HTTPS tunnel URL (e.g. https://xxxx.trycloudflare.com or ngrok).";
      statusEl.className = "hint is-error";
      statusEl.style.display = "block";
    }
    return;
  }

  if (statusEl) {
    statusEl.textContent = "Creating VoBiz Application, Endpoint, and linking number…";
    statusEl.className = "hint";
    statusEl.style.display = "block";
  }
  if (btn) btn.setAttribute("disabled", "true");

  try {
    const res = await backendFetch(`${BACKEND_URL}/provision-hubspot-dedicated`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID, tunnelUrl, number }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Provisioning failed (${res.status})`);

    if (statusEl) {
      statusEl.textContent = `Success! App "${data.appName}" created. Endpoint ${data.sipUser.split('@')[0]} bound to ${data.number}. Reconnecting softphone…`;
      statusEl.className = "hint is-ok";
      statusEl.style.display = "block";
    }

    state.fromNumber = data.number;
    showLoggedInState(data.sipUser.split('@')[0], data.number, [data.number]);
    setDialEnabled(true);
    startSipUA(data.sipUser, data.sipPassword, data.sipUser.split('@')[0]);
  } catch (err) {
    console.error("[VoBiz] Provisioning failed:", err);
    if (statusEl) {
      statusEl.textContent = `Provisioning error: ${err.message}`;
      statusEl.className = "hint is-error";
      statusEl.style.display = "block";
    }
  } finally {
    if (btn) btn.removeAttribute("disabled");
  }
}

/** === Call Recordings === */
export async function loadRecordings() {
  const listEl = document.getElementById("call-history-list");
  if (!listEl) return;
  listEl.innerHTML = "<li>Loading recordings…</li>";

  try {
    const res = await backendFetch(`${BACKEND_URL}/recordings/${encodeURIComponent(AGENT_ID)}?limit=15`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "Could not load recordings");
    renderRecordings(json.objects || []);
  } catch (err) {
    listEl.innerHTML = "<li style='color:var(--text-3);'>No recordings found or sign in required.</li>";
  }
}

let currentPlayingId = null;

function renderRecordings(recordings) {
  const listEl = document.getElementById("call-history-list");
  if (!listEl) return;

  if (!recordings.length) {
    listEl.innerHTML = "<li style='color:var(--text-3);'>No recordings yet.</li>";
    return;
  }

  listEl.innerHTML = "";
  recordings.forEach(rec => {
    const seconds = Number(rec.rounded_recording_duration) || 0;
    const durationText = seconds > 0 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : "0s";
    const when = rec.add_time && new Date(rec.add_time);
    const whenText = when && !isNaN(when) ? when.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : "";

    const li = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = [durationText, whenText].filter(Boolean).join(" · ") || "Call recording";

    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.textContent = (currentPlayingId === rec.recording_id) ? "❚❚ Pause" : "▶ Play";
    playBtn.addEventListener("click", () => playRecording(rec.recording_id, rec.playUrl, playBtn));

    li.append(label, playBtn);
    listEl.appendChild(li);
  });
}

function playRecording(recordingId, playUrl, buttonEl) {
  const audioEl = document.getElementById("vobiz-playback-audio");
  if (!audioEl) return;

  // If clicking on already playing recording, toggle pause
  if (currentPlayingId === recordingId && !audioEl.paused) {
    audioEl.pause();
    if (buttonEl) buttonEl.textContent = "▶ Play";
    return;
  }

  // Resolve target URL
  let targetSrc = playUrl || `${BACKEND_URL}/recording-audio/${encodeURIComponent(recordingId)}`;
  try {
    const parsed = new URL(targetSrc, window.location.origin);
    if ((window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") && BACKEND_URL.includes("localhost")) {
      targetSrc = `${BACKEND_URL}${parsed.pathname}${parsed.search}`;
    }
  } catch { /* use targetSrc */ }

  // Reset any other play button text
  document.querySelectorAll("#call-history-list button").forEach(btn => {
    btn.textContent = "▶ Play";
  });

  if (buttonEl) buttonEl.textContent = "⏳ Loading…";

  audioEl.src = targetSrc;
  audioEl.style.display = "block";

  audioEl.onplaying = () => {
    if (buttonEl) buttonEl.textContent = "❚❚ Pause";
    currentPlayingId = recordingId;
  };

  audioEl.onpause = () => {
    if (buttonEl) buttonEl.textContent = "▶ Play";
  };

  audioEl.onended = () => {
    if (buttonEl) buttonEl.textContent = "▶ Play";
    currentPlayingId = null;
  };

  audioEl.onerror = () => {
    console.error("[VoBiz] audio playback error for:", targetSrc, audioEl.error);
    if (buttonEl) buttonEl.textContent = "⚠ Failed";
    setTimeout(() => {
      if (buttonEl && buttonEl.textContent === "⚠ Failed") buttonEl.textContent = "▶ Play";
    }, 4000);
  };

  audioEl.play().catch(err => {
    console.warn("[VoBiz] playback blocked:", err);
    if (buttonEl) buttonEl.textContent = "▶ Play";
  });
}

/** === HubSpot Calling Extensions SDK === */
const cti = new CallingExtensions({
  debugMode: isInsideHubSpotIframe(),
  eventHandlers: {
    onReady: ({ portalId, userId, ownerId } = {}) => {
      notifyHubSpot(() => {
        cti.initialized({
          isLoggedIn: false,
          isAvailable: false,
          sizeInfo,
        });
      });
      if (portalId) state.portalId = portalId;
      if (userId) state.userId = userId;
      if (ownerId) state.ownerId = ownerId;
    },
    onDialNumber: (data) => {
      const { phoneNumber } = data || {};
      if (phoneNumber) {
        state.toNumber = phoneNumber;
        const input = document.getElementById("dialnumber");
        if (input) input.value = phoneNumber;
        placeCall(phoneNumber);
      }
    },
    onEngagementCreated: (data) => {
      state.engagementId = data && data.engagementId;
    },
    onEndCall: () => {
      hangUp();
    },
  },
});

/** === Dom Ready & Event Wiring === */
function setupEventListeners() {
  const dialBtn = document.getElementById("dialbtn");
  const dialInput = document.getElementById("dialnumber");
  const hangupBtn = document.getElementById("hangupbtn");
  const loginBtn = document.getElementById("vobiz-login-btn");
  const logoutBtn = document.getElementById("vobiz-logout-btn");
  const numberSelect = document.getElementById("vobiz-number-select");
  const setupInboundBtn = document.getElementById("setup-inbound-btn");
  const refreshHistoryBtn = document.getElementById("refresh-history-btn");

  // Mode tabs & SIP direct connect
  const modeAccountTab = document.getElementById("mode-account-tab");
  const modeSipTab = document.getElementById("mode-sip-tab");
  const sipConnectBtn = document.getElementById("sip-connect-btn");

  if (modeAccountTab) modeAccountTab.addEventListener("click", () => setAuthMode("account"));
  if (modeSipTab) modeSipTab.addEventListener("click", () => setAuthMode("sip"));
  if (sipConnectBtn) sipConnectBtn.addEventListener("click", sipDirectConnect);

  // Incoming call modal buttons
  const answerBtn = document.getElementById("incoming-answer-btn");
  const declineBtn = document.getElementById("incoming-decline-btn");
  const testIncomingBtn = document.getElementById("test-incoming-btn");

  if (dialBtn) {
    dialBtn.addEventListener("click", () => {
      const number = dialInput && dialInput.value.trim();
      placeCall(number);
    });
  }

  if (dialInput) {
    dialInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const number = dialInput.value.trim();
        placeCall(number);
      }
    });
  }

  if (hangupBtn) hangupBtn.addEventListener("click", hangUp);
  if (loginBtn) loginBtn.addEventListener("click", vobizLogin);
  if (logoutBtn) logoutBtn.addEventListener("click", vobizLogout);
  const provisionBtn = document.getElementById("provision-dedicated-btn");
  if (provisionBtn) provisionBtn.addEventListener("click", provisionDedicatedHubSpotApp);

  if (numberSelect) numberSelect.addEventListener("change", vobizSelectNumber);
  if (setupInboundBtn) setupInboundBtn.addEventListener("click", setupInboundCalling);
  if (refreshHistoryBtn) refreshHistoryBtn.addEventListener("click", loadRecordings);

  if (answerBtn) answerBtn.addEventListener("click", answerIncomingCall);
  if (declineBtn) declineBtn.addEventListener("click", declineIncomingCall);

  // Keyboard shortcuts when incoming call is ringing
  window.addEventListener("keydown", (e) => {
    if (!incomingPending) return;
    if (e.key === "Enter") {
      e.preventDefault();
      answerIncomingCall();
    } else if (e.key === "Escape") {
      e.preventDefault();
      declineIncomingCall();
    }
  });

  // Test simulation for inbound call popup
  if (testIncomingBtn) {
    testIncomingBtn.addEventListener("click", () => {
      showIncomingCallPopup("+1 (415) 555-0199", "Your VoBiz Line");
    });
  }

  // Developer panel CTI controls
  const initBtn = document.getElementById("initialize");
  const hsLoginBtn = document.getElementById("login");
  const hsLogoutBtn = document.getElementById("logout");
  const availBtn = document.getElementById("useravailable");
  const unavailBtn = document.getElementById("userunavailable");
  const resizeBtn = document.getElementById("resizewidget");
  const completeBtn = document.getElementById("completecall");

  if (initBtn) initBtn.addEventListener("click", () => cti.initialized({ isLoggedIn: true }));
  if (hsLoginBtn) hsLoginBtn.addEventListener("click", () => cti.userLoggedIn());
  if (hsLogoutBtn) hsLogoutBtn.addEventListener("click", () => cti.userLoggedOut());
  if (availBtn) availBtn.addEventListener("click", () => cti.userAvailable());
  if (unavailBtn) unavailBtn.addEventListener("click", () => cti.userUnavailable());
  if (resizeBtn) resizeBtn.addEventListener("click", () => cti.resizeWidget({ width: 420, height: 700 }));
  if (completeBtn) completeBtn.addEventListener("click", () => {
    cti.callCompleted({
      engagementId: state.engagementId,
      externalCallId: state.externalCallId,
      hideWidget: false,
    });
  });

  window.addEventListener("beforeunload", () => {
    try { if (vobizUA) vobizUA.stop(); } catch (e) {}
  });

  restoreVobizSession();
}

if (typeof window !== "undefined") {
  window.vobizLogin = vobizLogin;
  window.vobizLogout = vobizLogout;
  window.vobizSelectNumber = vobizSelectNumber;
  window.setAuthMode = setAuthMode;
  window.sipDirectConnect = sipDirectConnect;
  window.placeCall = placeCall;
  window.hangUp = hangUp;
  window.setupInboundCalling = setupInboundCalling;
  window.loadRecordings = loadRecordings;
  window.answerIncomingCall = answerIncomingCall;
  window.declineIncomingCall = declineIncomingCall;
  window.showIncomingCallPopup = showIncomingCallPopup;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupEventListeners);
  } else {
    setupEventListeners();
  }

  window.addEventListener("load", () => {
    if (isInsideHubSpotIframe()) {
      try {
        cti.initialized({ isLoggedIn: false });
      } catch (err) {
        console.warn("[VoBiz] Auto-initialize note:", err);
      }
    }
  });
}
