const socket = io();
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));

function render(state){
  const online = state.connected;
  $("#topStatus").textContent = online ? "Bot Online" : state.connecting ? "Connecting…" : "Offline";
  $("#systemStatus").textContent = online ? "All systems operational" : "Waiting for connection";
  $("#connectionStat").textContent = online ? "Connected" : state.connecting ? "Connecting" : "Offline";
  $("#groupsStat").textContent = state.groups;
  $("#contactsStat").textContent = state.contacts;
  $("#messagesStat").textContent = state.messages.length;
  $("#phone").textContent = state.phone || "—";
  $("#session").textContent = online ? "Active" : "Not connected";
  $("#connectionPill").innerHTML = `<i></i>${online ? "Connected" : state.connecting ? "Connecting" : "Disconnected"}`;
  $("#botToggle").checked = state.autoReply;

  const qr = $("#qr"), empty = $("#qrEmpty"), pairingBox = $("#pairingBox");
  if(state.qr){ qr.src = state.qr; qr.style.display = "block"; empty.style.display = "none"; pairingBox.style.display = "none"; }
  else if(state.pairingCode){ qr.removeAttribute("src"); qr.style.display = "none"; pairingBox.style.display = "flex"; empty.style.display = "none"; $("#pairingCode").textContent = state.pairingCode; }
  else { qr.removeAttribute("src"); qr.style.display = "none"; pairingBox.style.display = "none"; empty.style.display = "block"; }

  $("#messages").innerHTML = state.messages.slice().reverse().map(m =>
    `<div class="message"><b>${esc(m.from)}</b><small>${new Date(m.timestamp).toLocaleTimeString()}</small><div>${esc(m.text || "[media]")}</div></div>`
  ).join("");

  const logs = state.logs.map(l =>
    `<div class="log"><b>${esc(l.type.toUpperCase())}</b> — ${esc(l.message)}<small>${new Date(l.at).toLocaleString()}</small></div>`
  ).join("");
  $("#logs").innerHTML = logs;
  $("#allLogs").innerHTML = logs;

  $("#allMessages").innerHTML = state.messages.slice().reverse().map(m =>
    `<div class="table-row"><span>${new Date(m.timestamp).toLocaleString()}</span><b>${esc(m.from)}</b><span>${esc(m.text || "[media]")}</span></div>`
  ).join("");
}

async function api(url, options={}){
  const r = await fetch(url,{headers:{"Content-Type":"application/json"},...options});
  const data = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(data.error || "Request failed");
  return data;
}

socket.on("state", render);
socket.on("message", () => api("/api/state").then(render));
socket.on("log", () => api("/api/state").then(render));

$("#connectBtn").onclick = () => api("/api/connect",{method:"POST"});
$("#pairingBtn").onclick = async () => {
  const phone = $("#pairingPhone").value.trim().replace(/\D/g, "");
  if(!phone) return alert("Enter your WhatsApp number with country code, e.g. 923001234567");
  try {
    const data = await api("/api/pairing-code",{method:"POST",body:JSON.stringify({phone})});
    if(data.pairingCode) $("#pairingCode").textContent = data.pairingCode;
  } catch(err){ alert(err.message); }
};
$("#refreshBtn").onclick = () => api("/api/connect",{method:"POST"});
$("#disconnectBtn").onclick = () => api("/api/disconnect",{method:"POST"});
$("#restartBtn").onclick = async () => { await api("/api/disconnect",{method:"POST"}); setTimeout(()=>api("/api/connect",{method:"POST"}),500); };

$("#sendForm").onsubmit = async e => {
  e.preventDefault();
  try {
    await api("/api/message",{method:"POST",body:JSON.stringify({to:$("#to").value,text:$("#text").value})});
    $("#text").value = "";
  } catch(err){ alert(err.message); }
};

$("#saveSettings").onclick = async () => {
  await api("/api/settings",{method:"PATCH",body:JSON.stringify({
    botName:$("#botName").value,
    prefix:$("#prefix").value,
    autoReply:$("#autoReply").checked
  })});
};

document.querySelectorAll("[data-command]").forEach(btn => btn.onclick = () => {
  $("#text").value = btn.dataset.command;
  $("#text").focus();
});

document.querySelectorAll(".nav").forEach(btn => btn.onclick = () => showSection(btn.dataset.section));
document.querySelectorAll("[data-section-target]").forEach(btn => btn.onclick = () => showSection(btn.dataset.sectionTarget));

function showSection(id){
  document.querySelectorAll(".section").forEach(s => s.classList.toggle("active", s.id === id));
  document.querySelectorAll(".nav").forEach(n => n.classList.toggle("active", n.dataset.section === id));
  $("#pageTitle").textContent = id[0].toUpperCase()+id.slice(1);
}

$("#botToggle").onchange = e => api("/api/settings",{method:"PATCH",body:JSON.stringify({autoReply:e.target.checked})});
$("#autoReply").onchange = e => $("#botToggle").checked = e.target.checked;

api("/api/state").then(render);