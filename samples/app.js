// Minimal browser client for the server-sent-event search endpoint.
const $ = id => document.getElementById(id);
const pageParams = new URLSearchParams(location.search);
// Each collection is answered by its own service. config.js maps collection
// to service origin when the pages are hosted apart from the services (GitHub
// Pages); with no entry the page's own origin answers, as in local runs.
const API = window.NLWEB_API || {};

// Each collection has its own URL (/recipes, /homes, ...), and the page searches
// only that collection. Sent as `site`; the server's aggregate scopes
// (sources.KINDS) filter on the manifest section a collection sits in.
const COLLECTIONS = {
  recipes: { label: "Recipes", source: "NYT Cooking", placeholder: "Ask for a recipe\u2026" },
  movies: { label: "Movies", source: "IMDb", placeholder: "Ask about a movie\u2026" },
  reviews: { label: "Product reviews", source: "Wirecutter", placeholder: "Ask what to buy\u2026" },
  trails: { label: "Trails", source: "AllTrails", placeholder: "Ask for a hike\u2026" },
  homes: { label: "Bay Area homes", source: "Zillow", placeholder: "Ask about a home for sale\u2026" },
};
// The collection is the last path segment: /recipes locally, /samples/recipes/
// on GitHub Pages. Links are relative for the same reason.
const scope = location.pathname.split("/").filter(Boolean).pop();
if (!COLLECTIONS[scope]) location.replace("../");
const apiBase = API[scope] || "";
const askEndpoint = new URL(pageParams.get("ask") || `${apiBase}/ask`, location.href);
const collection = COLLECTIONS[scope] || {};

import { Threadstore } from "./threadstore.js?v=19";
import { renderCard } from "./cards.js?v=19";

// A conversation is the unit now, not a page load. `store` persists it,
// `thread` is the one being added to, and `turns` mirrors it in memory so a
// follow-up can be sent without inflating anything from disk.
let store = null;
let thread = null;
let turns = [];
let corpus = null;

const sampleQueries = {
  recipes: [
    "I'm hosting Thanksgiving for twelve. Three guests are vegan and one is gluten-free. I want one showstopper main that works for all of them, ideally something I can make the day before.",
    "A weeknight dinner on the table in under 30 minutes using chicken thighs, and not Italian \u2014 my family is sick of pasta.",
    "Something vegetarian and Indian for a cold winter night, highly rated, that doesn't need a long list of whole spices I'd have to go out and buy.",
    "I have a pile of summer tomatoes and corn from the farmers market. What can I make that shows them off without turning on the oven?",
    "A dairy-free, nut-free dessert for a kid's birthday party that still feels special.",
    "A make-ahead soup I can freeze in portions, under 400 calories a serving, that isn't just another lentil soup.",
  ],
  movies: [
    "Give me movies about AI, but ones that portray AI in a positive light.",
    "Hitchcock films from the 1950s that aren't the famous ones everybody has seen \u2014 no Vertigo, no Rear Window.",
    "A highly rated John Ford western with John Wayne that runs under two hours.",
    "Japanese monster movies from the 1960s, the Ishir\u00f4 Honda kind, that still hold up for a modern viewer.",
    "I've never seen an Ingmar Bergman film. Which one is the best place to start, and why?",
    "Animated movies from after 2000 that adults genuinely enjoy too, rated at least 7, nothing too scary for an eight-year-old.",
    "Gritty 1970s crime movies set in New York, the kind where the city feels like a character.",
  ],
  reviews: [
    "I have two cats, a long-haired dog and hardwood floors. Which robot vacuum handles pet hair without tangling, and is there a budget pick?",
    "We're setting up a nursery. Which baby monitor works without a Wi-Fi app or an account?",
    "I type all day and my wrists hurt. Which wireless keyboard is best for ergonomics, and does it work with a Mac?",
    "Our dishwasher died. I want something quiet that actually dries plastic, for under $1,000.",
    "Gifts under $50 for someone who loves to cook and already owns the basics.",
    "What do I really need for a first backpacking trip if I don't want to overspend on gear I may never use again?",
  ],
  trails: [
    "A moderate loop near Mill Valley through the redwoods, under 5 miles, where I can bring my dog.",
    "Hard day hikes in Yosemite Valley with a waterfall payoff \u2014 I'm fit and want something that takes most of the day.",
    "Easy, kid-friendly trails near San Diego that take under an hour and end at the coast.",
    "Lake hikes near South Lake Tahoe or Truckee for late summer that aren't mobbed with people.",
    "Something in Death Valley that's doable in winter and isn't just a flat walk across the salt.",
    "Dog-friendly out-and-back trails in the Oakland hills with views of the Bay.",
  ],
  homes: [
    "A 4-bedroom home in Fremont or Pleasanton under $2 million, ideally on a bigger-than-average lot.",
    "Anything in the Palo Alto Unified school district under $3 million \u2014 I'll trade square footage for the schools.",
    "Sunnyvale or Mountain View, at least 3 bedrooms, central air and a two-car garage, and no HOA.",
    "A big, private lot in Woodside or Portola Valley with room for a pool.",
    "A condo or townhouse in San Mateo or Redwood City under $1.2 million with low HOA fees.",
    "The newest construction in Cupertino with at least 2,500 sq ft.",
  ],
};

async function streamAsk(args, onEvent) {
  const response = await fetch(askEndpoint, {
    method: "POST",
    headers: { accept: "text/event-stream", "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) {
    let message = `Search HTTP ${response.status}`;
    try { message = (await response.json()).error || message; } catch { /* use status */ }
    throw new Error(message);
  }
  if (!response.body) throw new Error("Search response cannot be streamed");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function consume(final = false) {
    buffer = buffer.replaceAll("\r\n", "\n");
    const frames = buffer.split("\n\n");
    buffer = final ? "" : frames.pop();
    for (const frame of frames) {
      const data = frame.split("\n").filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trim()).join("\n");
      if (!data) continue;
      const message = JSON.parse(data);
      onEvent(message.message_type, message.content);
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    consume(done);
    if (done) break;
  }
}

function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function render(item) {
  return renderCard(item);
}

// One turn of the conversation: the question as asked, how the server
// understood it, and the results for it. Turns accumulate, because a follow-up
// only makes sense next to what it follows.
function startTurn(question, options = {}) {
  queueMicrotask(updateComposerMode);
  const turn = text("section", "", "turn");
  const head = text("div", "", "turn-head");
  const asked = text("div", question, "asked");
  const drop = text("button", "\u00d7", "turn-delete");
  drop.type = "button";
  drop.title = "Remove this turn";
  drop.setAttribute("aria-label", `Remove the turn "${question.slice(0, 60)}"`);
  let seq = options.seq;
  drop.addEventListener("click", () => forgetTurn(turn, seq));
  head.append(asked, drop);
  const status = text("div", "Searching\u2026", "turn-status");
  const results = document.createElement("ul");
  results.className = "results";
  turn.append(head, status, results);
  $("thread").append(turn);
  // "start", not "nearest": the turn is empty at this point, so a minimal
  // scroll is a no-op and the results then push the question below the fold.
  // Putting the question at the top of the viewport is also what a thread
  // wants -- you read down from what you just asked.
  turn.scrollIntoView({ behavior: "smooth", block: "start" });
  return {
    node: turn,
    results,
    setSeq: value => { seq = value; },
    setStatus: value => { status.textContent = value; },
    // The rewrite is what makes a follow-up work or fail, so it stays on screen
    // rather than flashing past in a status line.
    setInterpreted: value => {
      if (!value || value === question) return;
      const note = text("div", `interpreted as: ${value}`, "interpreted");
      asked.after(note);
    },
    addNotice: value => {
      let notice = turn.querySelector(".notice");
      if (!notice) {
        notice = text("div", "", "notice");
        status.after(notice);
      }
      notice.textContent += `${notice.textContent ? " " : ""}${value}`;
    },
    setAnswer: value => {
      const answer = text("div", value, "answer");
      status.after(answer);
    },
  };
}

$("form").addEventListener("submit", async event => {
  event.preventDefault();
  const query = $("query").value.trim();
  if (!query) return;

  $("submit").disabled = true;
  $("query").value = "";              // ready for the follow-up
  $("samples").open = false;
  $("intro").hidden = true;
  hideUsage();

  const turn = startTurn(query);
  // Built up as the stream arrives; stored whole when the turn completes.
  const record = { question: query, askedAt: Date.now(), interpretedAs: null,
                   mode: $("mode").value, results: [], answer: null,
                   notices: [], usage: null };
  // What came before, captured before this turn joins the list -- a question is
  // not its own antecedent.
  const previous = turns.slice(-5).map(t => t.question);
  // Joined now rather than on completion. A follow-up asked while the previous
  // answer is still streaming would otherwise be sent with no context, and the
  // server would decontextualize it against nothing -- silently, because a
  // query with no antecedent is a legitimate query.
  turns.push(record);

  try {
    const args = { query, site: scope, mode: $("mode").value, previous_queries: previous };
    const provisional = new Set();
    let finalStarted = false;
    let finalCount = 0;
    let done = false;

    await streamAsk(args, (type, content) => {
      if (type === "candidate" && !finalStarted) {
        for (const item of content || []) {
          const key = item.url || `${item.site}:${item.name}`;
          if (provisional.has(key)) continue;
          provisional.add(key);
          const node = render(item);
          node.classList.add("provisional");
          turn.results.append(node);
        }
        turn.setStatus(`Searching\u2026 ${provisional.size} possible result${provisional.size === 1 ? "" : "s"}`);
      } else if (type === "result") {
        if (!finalStarted) {
          finalStarted = true;
          turn.results.replaceChildren();
        }
        for (const item of content || []) {
          turn.results.append(render(item));
          record.results.push(item);
          finalCount += 1;
        }
      } else if (type === "nlws" && content?.answer) {
        turn.setAnswer(content.answer);
        record.answer = content.answer;
      } else if ((type === "intermediate_message" || type === "error") && content) {
        turn.addNotice(content);
        record.notices.push(content);
      } else if (type === "usage" && content) {
        record.usage = content;
        renderUsage(content);
        if (done) turn.setStatus(turnSummary(finalCount, record.usage));
      } else if (type === "decontextualized_query") {
        turn.setInterpreted(content);
        record.interpretedAs = content;
      } else if (type === "end-nlweb-response") {
        done = true;
        turn.setStatus(turnSummary(finalCount, record.usage));
      }
    });
    // The store allocates the sequence, so the delete control is wired up once
    // the turn is actually stored rather than guessing where it will land.
    await remember(record, turn);
  } catch (error) {
    turn.addNotice(error.message);
    turn.setStatus("Search failed");
  } finally {
    $("submit").disabled = false;
    $("query").focus();
  }
});

// Persist the completed turn, starting a thread on the first one so an
// abandoned empty conversation never appears in the list.
async function remember(record, node) {
  if (!store) return;
  if (!thread) thread = await store.startThread({ scope, corpus });
  const stored = await store.appendTurn(thread, record);
  record.seq = stored.lastSeq;
  node?.setSeq(record.seq);
  $("chat-title").textContent = thread.title;
  $("delete-chat").hidden = false;
  await refreshConversations();
}

// Removing one turn from a conversation, from the thread it is shown in.
async function forgetTurn(node, seq) {
  node.remove();
  turns = turns.filter(t => t.seq !== seq);
  updateComposerMode();
  if (!store?.available || !thread || seq === undefined) return;
  const updated = await store.removeTurn(thread.id, seq);
  if (!updated) {           // that was the last turn; the thread went with it
    newChat();
  } else {
    thread = updated;
    $("chat-title").textContent = thread.title;
  }
  await refreshConversations();
}

// Removing the conversation being read, rather than hunting for its row.
async function forgetThread() {
  if (!thread) { newChat(); return; }
  if (!confirm(`Delete "${thread.title}" and all ${thread.turnCount} of its turns?`)) return;
  if (store?.available) await store.remove(thread.id);
  newChat();
  await refreshConversations();
}

$("delete-chat").addEventListener("click", forgetThread);

function newChat() {
  thread = null;
  turns = [];
  $("thread").replaceChildren();
  $("chat-title").textContent = "New chat";
  $("delete-chat").hidden = true;
  $("intro").hidden = false;
  $("samples").open = true;
  hideUsage();
  markActive(null);
  updateComposerMode();
  $("query").focus();
}

$("new-chat").addEventListener("click", newChat);
$("new-chat-top").addEventListener("click", newChat);
$("new-question").addEventListener("click", newChat);

// Which kind of question the box will ask, said where the typing happens: once
// a conversation has turns, the next question is a follow-up that is read in
// their context; "New question" starts clean.
function updateComposerMode() {
  const followUp = turns.length > 0;
  $("followup").hidden = !followUp;
  $("followup-title").textContent = followUp ? turns[0].question : "";
  $("new-chat-top").hidden = !followUp;
  $("query").placeholder = followUp
    ? "Ask a follow-up about these results\u2026"
    : collection.placeholder;
}

function dollars(value) {
  const cost = Number(value || 0);
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

// Each turn says what it cost: results, tokens, dollars.
function turnSummary(count, usage) {
  const parts = [`${count} result${count === 1 ? "" : "s"}`];
  if (usage) {
    parts.push(`${Number(usage.total_tokens || 0).toLocaleString()} tokens`, dollars(usage.cost));
  }
  return parts.join(" \u00b7 ");
}

function conversationCost() {
  return turns.reduce((sum, t) => sum + Number(t.usage?.cost || 0), 0);
}

function renderUsage(usage) {
  const rows = $("usage-rows");
  rows.replaceChildren();
  const tokens = Number(usage.total_tokens || 0);
  const cost = Number(usage.cost || 0);
  const missing = Number(usage.unpriced_calls || 0);
  const summary = `${tokens.toLocaleString()} tokens \u00b7 $${cost.toFixed(6)} USD` +
    (missing ? ` \u00b7 ${missing} unpriced calls` : "");
  $("usage-total").textContent = summary;
  // The top bar carries the last query's cost and the conversation's total;
  // the dialog it opens breaks the last query down by model.
  $("usage-open-total").textContent =
    `\u00b7 last query ${dollars(usage.cost)} \u00b7 conversation ${dollars(conversationCost())}`;
  for (const item of usage.models || []) {
    const tr = document.createElement("tr");
    const phase = Object.entries(item.phases || {}).map(([name, count]) => `${name} ${count}`).join(" \u00b7 ");
    const model = text("td", "");
    model.append(text("div", item.model || "unknown"), text("small", phase));
    tr.append(model);
    for (const value of [item.calls, item.prompt_tokens, item.completion_tokens, item.total_tokens]) {
      tr.append(text("td", Number(value || 0).toLocaleString()));
    }
    tr.append(text("td", `$${Number(item.cost || 0).toFixed(6)}${item.unpriced_calls ? "*" : ""}`));
    rows.append(tr);
  }
  $("usage-open").hidden = false;
}

function hideUsage() {
  $("usage-open").hidden = true;
  if ($("usage-dialog").open) $("usage-dialog").close();
}

function showSamples() {
  const container = $("sample-queries");
  container.replaceChildren();
  for (const query of sampleQueries[scope] || []) {
    const button = text("button", query, "sample-query");
    button.type = "button";
    button.addEventListener("click", () => {
      $("query").value = query;
      $("form").requestSubmit();
    });
    container.append(button);
  }
}

document.title = `Ask ${collection.label} \u00b7 NLWeb Samples`;
$("scope-chip").textContent = `${collection.label} \u00b7 ${collection.source}`;
updateComposerMode();
showSamples();

const usageDialog = $("usage-dialog");
$("usage-open").addEventListener("click", () => usageDialog.showModal());
$("usage-close").addEventListener("click", () => usageDialog.close());
usageDialog.addEventListener("click", event => {
  if (event.target === usageDialog) usageDialog.close();
});


// ---------------------------------------------------------------- sidebar

function when(ms) {
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days === 0) return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

function markActive(id) {
  for (const node of document.querySelectorAll(".conversation")) {
    node.classList.toggle("active", node.dataset.id === id);
  }
}

async function refreshConversations() {
  if (!store?.available) return;
  // Every collection's conversations are listed together. Each still belongs
  // to the collection it was asked in, so opening one from another collection
  // goes to that collection's page, where a follow-up searches the right corpus.
  const all = await store.threads();
  // Matches anything asked, rewritten, or returned in the thread -- not just
  // its title, which is only the first question.
  const needle = $("search").value.trim();
  const shown = needle ? all.filter(t => Threadstore.matches(t, needle)) : all;
  const list = $("conversations");
  list.replaceChildren();

  if (!shown.length) {
    list.append(text("p", needle ? "No conversations match." : "No conversations yet.", "empty"));
  }
  for (const item of shown) {
    const row = text("div", "", "conversation");
    row.dataset.id = item.id;
    row.setAttribute("role", "listitem");
    const open = text("button", item.title || "Untitled", "conversation-open");
    open.type = "button";
    open.addEventListener("click", () => {
      if (item.scope !== scope && COLLECTIONS[item.scope]) {
        location.href = `../${item.scope}/#thread=${encodeURIComponent(item.id)}`;
      } else {
        openThread(item.id);
      }
    });
    const label = COLLECTIONS[item.scope]?.label;
    const meta = text("div", `${label ? `${label} · ` : ""}${item.turnCount} turn${item.turnCount === 1 ? "" : "s"} · ${when(item.updatedAt)}`, "conversation-meta");
    const remove = text("button", "×", "conversation-delete");
    remove.type = "button";
    remove.title = "Delete conversation";
    remove.addEventListener("click", async event => {
      event.stopPropagation();
      await store.remove(item.id);
      if (thread?.id === item.id) newChat();
      await refreshConversations();
    });
    row.append(open, meta, remove);
    list.append(row);
  }
  markActive(thread?.id ?? null);

  const usage = await store.usage();
  $("storage-usage").textContent = usage.turns
    ? `${usage.turns} turns · ${(usage.bytes / 1024).toFixed(0)} KB`
    : "";
}

// Reopening shows exactly what was shown, from the stored turn -- nothing is
// re-fetched, so nothing can come back different.
async function openThread(id) {
  const all = await store.threads();
  const found = all.find(t => t.id === id);
  if (!found) return;
  thread = found;
  turns = await store.turns(id);
  $("thread").replaceChildren();
  $("chat-title").textContent = found.title;
  $("delete-chat").hidden = false;
  $("intro").hidden = true;
  hideUsage();
  for (const record of turns) {
    const turn = startTurn(record.question, { seq: record.seq });
    turn.setInterpreted(record.interpretedAs);
    for (const item of record.results || []) turn.results.append(render(item));
    if (record.answer) turn.setAnswer(record.answer);
    for (const notice of record.notices || []) turn.addNotice(notice);
    turn.setStatus(turnSummary((record.results || []).length, record.usage));
  }
  const last = turns[turns.length - 1];
  if (last?.usage) renderUsage(last.usage);
  markActive(id);
  $("query").focus();
}

$("search").addEventListener("input", refreshConversations);

$("clear-all").addEventListener("click", async () => {
  if (!store?.available) return;
  if (!confirm("Delete every saved conversation? This cannot be undone.")) return;
  await store.clear();
  newChat();
  await refreshConversations();
});

// Whether the conversation list is showing. Remembered, because a panel that
// reopens itself on every reload is not a preference, it is a suggestion -- and
// the label says which way the button goes rather than leaving a bare icon to
// be guessed at.
const SIDEBAR_KEY = "ask-samples:sidebar";

function setSidebar(open) {
  document.body.classList.toggle("sidebar-collapsed", !open);
  const button = $("toggle-sidebar");
  button.setAttribute("aria-expanded", String(open));
  button.title = open ? "Hide conversations" : "Show conversations";
  button.setAttribute("aria-label", button.title);
  try {
    localStorage.setItem(SIDEBAR_KEY, open ? "open" : "closed");
  } catch {
    // Private windows and blocked site data both land here; the toggle still
    // works for this page, it just will not be remembered.
  }
}

$("toggle-sidebar").addEventListener("click", () => {
  setSidebar(document.body.classList.contains("sidebar-collapsed"));
});

// Closed until someone opens it: the first thing a visitor sees should be the
// question box, not an empty history.
let sidebarWasOpen = false;
try {
  sidebarWasOpen = localStorage.getItem(SIDEBAR_KEY) === "open";
} catch { /* default to closed */ }
setSidebar(sidebarWasOpen);

// Enter sends, Shift+Enter makes a newline -- the composer is a textarea so a
// long prompt can be written and read before it is sent.
$("query").addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("form").requestSubmit();
  }
});

// Grow with the prompt, up to a point, so a paragraph-long question is visible
// as it is written rather than scrolling inside one line.
$("query").addEventListener("input", () => {
  const box = $("query");
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, 200)}px`;
});

async function boot() {
  try {
    // Also wakes this collection's service while the visitor is still typing.
    const health = await fetch(`${apiBase}/health`).then(r => r.json());
    corpus = health.corpus || null;
    const count = health.collections?.[scope];
    if (count) {
      $("scope-chip").textContent = `${count.toLocaleString()} ${collection.label.toLowerCase()} \u00b7 ${collection.source}`;
      $("scope-chip").title = corpus?.snapshot_id
        ? `Corpus ${corpus.snapshot_id}, built ${corpus.built_at}`
        : "";
    }
  } catch { /* the chip is decoration; a failed probe must not stop the app */ }

  store = await Threadstore.open();
  if (store.available) await store.backfill();
  if (!store.available) {
    $("conversations").append(
      text("p", "This browser is not storing conversations, so they will not survive a reload.", "empty"));
    return;
  }
  await refreshConversations();
  // Arriving from another collection's sidebar: open the conversation asked.
  const wanted = new URLSearchParams(location.hash.slice(1)).get("thread");
  if (wanted) {
    history.replaceState(null, "", location.pathname);
    await openThread(wanted);
  }
}

boot();
