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

import { Threadstore } from "./threadstore.js?v=20";
import { renderCard } from "./cards.js?v=20";

// A conversation is the unit now, not a page load. `store` persists it,
// `thread` is the one being added to, and `turns` mirrors it in memory so a
// follow-up can be sent without inflating anything from disk.
let store = null;
let thread = null;
let turns = [];
let corpus = null;

// Ranking models offered in the picker; ids must be in ranking_models.py.
// Order and notes from the 2026-10-04 edge-case comparison (12 hard queries).
// "Auto" sends no model: the server ranks with its default and, where a
// collection is configured for it (recipes), moves requests that state a
// dietary restriction to a stronger model.
const RANKING_MODELS = [
  ["", "Auto"],
  ["openai/gpt-oss-20b", "GPT-OSS 20B"],
  ["openai/gpt-oss-120b", "GPT-OSS 120B"],
  ["google/gemma-4-26b-a4b-it", "Gemma 4 26B"],
  ["google/gemma-4-31b-it", "Gemma 4 31B"],
  ["google/gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite"],
  ["google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"],
  ["google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"],
  ["google/gemini-3.8-flash", "Gemini 3.8 Flash"],
];
const MODEL_KEY = "ask-samples:model";

// Shown above a collection's samples when they are ordered.
const sampleOrder = { recipes: "These go roughly from easy to hard. Run one and open Cost to see what it tests." };

const sampleQueries = {
  recipes: [
    ["Chocolate chip cookies",
     "A one-phrase lookup: the baseline any search box handles."],
    ["A classic lasagna",
     "Still a lookup, but 'classic' has to beat the many lasagna variations."],
    ["Quick weeknight salmon",
     "Adds a time limit, read from each recipe's total time."],
    ["Vegetarian chili",
     "A diet in two words: the answer must stay vegetarian, not just mention it."],
    ["A cake that uses up overripe bananas",
     "Ingredient-first: the banana is in the recipe, not the title."],
    ["Something I can make with leftover rice",
     "Cooked rice as an ingredient, not rice as the dish."],
    ["A make-ahead breakfast casserole for a crowd",
     "Three constraints: meal, make-ahead and serving size."],
    ["I have a pile of summer tomatoes and corn from the farmers market. What can I make that shows them off without turning on the oven?",
     "Ingredient-first, plus an equipment rule for a hot day."],
    ["Tight budget this week: a vegetarian dinner for four from pantry staples like canned beans, rice and frozen vegetables.",
     "Cooks from what's on hand rather than from a recipe name."],
    ["Something vegetarian and Indian for a cold winter night, highly rated, that doesn't need a long list of whole spices I'd have to go out and buy.",
     "Cuisine, season, ratings and a limit on shopping, all in one."],
    ["I'm recovering from surgery and can only cook once a week. High-protein meals that reheat well all week and don't rely on red meat.",
     "Planning, not one dish: protein, reheating and an exclusion together."],
    ["Low-sodium dinners for my dad after his heart attack that don't taste like hospital food.",
     "A medical diet where the useful answer is how to cut the salt, not just which recipe has none."],
    ["Iftar for eight during Ramadan, halal, and it needs to wait in a low oven until sunset without drying out.",
     "A religious rule plus timing: dishes that can hold in a low oven for an hour."],
    ["I'm hosting Thanksgiving for twelve. Three guests are vegan and one is gluten-free. I want one showstopper main that works for all of them, ideally something I can make the day before.",
     "Most vegan mains hide wheat in pastry, breadcrumbs or soy sauce; each answer names the substitution."],
    ["My in-laws are visiting. My father-in-law has celiac disease, my sister-in-law is vegetarian and the kids won't eat anything spicy. One dinner everyone can eat, ideally made in one pot.",
     "Three people, three rules. A pasta dish qualifies only with a gluten-free swap, and the answer says which."],
    ["I'm organizing an outdoor summer party. A number of my guests are pre-diabetic or diabetic. I want a fruit-forward dessert that can sit outside for a few hours without melting or spoiling.",
     "Common sense: anything frozen melts outside. The answers suggest sugar swaps for the diabetic guests."],
  ],
  movies: [
    ["Give me movies about AI, but ones that portray AI in a positive light.",
     "Judges tone, not topic: keyword search returns every killer robot."],
    ["Hitchcock films from the 1950s that aren't the famous ones everybody has seen \u2014 no Vertigo, no Rear Window.",
     "Exclusions and 'not famous': things keyword search can't express."],
    ["A highly rated John Ford western with John Wayne that runs under two hours.",
     "Director, star, genre, rating and runtime from the page's own markup."],
    ["Japanese monster movies from the 1960s, the Ishir\u00f4 Honda kind, that still hold up for a modern viewer.",
     "'The Honda kind' asks for a style, not a credit."],
    ["I've never seen an Ingmar Bergman film. Which one is the best place to start, and why?",
     "Asks for advice, so the summary has to explain its pick."],
    ["Animated movies from after 2000 that adults genuinely enjoy too, rated at least 7, nothing too scary for an eight-year-old.",
     "Two audiences with opposite needs, plus hard numeric filters."],
    ["Gritty 1970s crime movies set in New York, the kind where the city feels like a character.",
     "Mood and setting, which no field in the data states outright."],
  ],
  reviews: [
    ["I'm moving into a 400-square-foot studio with no dishwasher and almost no counter space. Which kitchen appliances are actually worth the room, and which can I skip?",
     "Asks what to skip as well as what to buy."],
    ["My mother is in her eighties, lives alone and is hard of hearing. What gadgets would help her stay safe at home without her needing a smartphone?",
     "Pulls from medical alerts, smoke alarms and phones: no single category answers it."],
    ["My home office gets hot in summer and my windows can't take a window air conditioner. What will keep me cool and stay quiet enough for video calls?",
     "A constraint that rules out the obvious answer, plus a noise limit."],
    ["I have two cats, a long-haired dog and hardwood floors. Which robot vacuum handles pet hair without tangling, and is there a budget pick?",
     "Specific household, plus the top and budget picks from one guide."],
    ["We're setting up a nursery. Which baby monitor works without a Wi-Fi app or an account?",
     "A privacy requirement most product listings bury."],
    ["I type all day and my wrists hurt. Which wireless keyboard is best for ergonomics, and does it work with a Mac?",
     "A health need plus compatibility."],
    ["Our dishwasher died. I want something quiet that actually dries plastic, for under $1,000.",
     "Three test results (noise, drying, price) from the review itself."],
    ["Gifts under $50 for someone who loves to cook and already owns the basics.",
     "Gift guides, a price cap and 'not the basics'."],
    ["What do I really need for a first backpacking trip if I don't want to overspend on gear I may never use again?",
     "Asks for a minimal kit, not the best of each item."],
  ],
  trails: [
    ["My 70-year-old dad is visiting San Francisco and has bad knees. A scenic walk with ocean views, mostly flat, under 2 miles.",
     "Turns 'bad knees' into flat and short."],
    ["Hard day hikes in Yosemite Valley with a waterfall payoff \u2014 I'm fit and want something that takes most of the day.",
     "Difficulty and length as the point, not the obstacle."],
    ["Easy, kid-friendly trails near San Diego that take under an hour and end at the coast.",
     "Time, audience and a destination."],
    ["Lake hikes near South Lake Tahoe or Truckee for late summer that aren't mobbed with people.",
     "'Not crowded' is judged from reviews and popularity."],
    ["Something in Death Valley that's doable in winter and isn't just a flat walk across the salt.",
     "Season and a vague 'more interesting than flat'."],
    ["Dog-friendly out-and-back trails in the Oakland hills with views of the Bay.",
     "Dog rules, trail shape and views from the trail page."],
  ],
  homes: [
    ["Family of five, and my mother is moving in with us. We need at least 4 bedrooms with one she can reach without stairs, good schools, under $2.5 million.",
     "Turns a life situation into rooms, stairs, schools and price."],
    ["A 4-bedroom home in Fremont or Pleasanton under $2 million, ideally on a bigger-than-average lot.",
     "Hard filters plus a soft preference."],
    ["Anything in the Palo Alto Unified school district under $3 million \u2014 I'll trade square footage for the schools.",
     "States a trade-off rather than a filter."],
    ["Sunnyvale or Mountain View, at least 3 bedrooms, central air and a two-car garage, and no HOA.",
     "Feature checklist from the listing's own markup."],
    ["A big, private lot in Woodside or Portola Valley with room for a pool.",
     "'Room for a pool' has to be inferred from lot size."],
    ["A condo or townhouse in San Mateo or Redwood City under $1.2 million with low HOA fees.",
     "Property type, price and HOA fees together."],
    ["The newest construction in Cupertino with at least 2,500 sq ft.",
     "Sorting by year built, not just filtering."],
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
    setRestrictions: value => {
      if (!value?.restrictions?.length) return;
      const label = RANKING_MODELS.find(([id]) => id === value.ranking_model)?.[1] || value.ranking_model;
      const note = text("div", `diet: ${value.restrictions.join(", ")} \u00b7 ranked by ${label}`, "interpreted");
      (head.querySelector(".interpreted") || asked).after(note);
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
                   mode: $("mode").value, model: $("model").value, results: [], answer: null,
                   notices: [], usage: null };
  // What came before, captured before this turn joins the list -- a question is
  // not its own antecedent.
  // Earlier turns as the server understood them: a rewrite carries the context
  // its own turn inherited, so the chain does not depend on raw fragments like
  // "what about coconut?". The last turn's result names let a follow-up point
  // at one ("the granita will melt").
  const previous = turns.slice(-5).map(t => t.interpretedAs || t.question);
  const previousResults = (turns.at(-1)?.results || []).slice(0, 10).map(item => item.name).filter(Boolean);
  // Joined now rather than on completion. A follow-up asked while the previous
  // answer is still streaming would otherwise be sent with no context, and the
  // server would decontextualize it against nothing -- silently, because a
  // query with no antecedent is a legitimate query.
  turns.push(record);

  try {
    const args = { query, site: scope, mode: $("mode").value,
                   previous_queries: previous, previous_results: previousResults };
    if ($("model").value) args.ranking_model = $("model").value;
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
        renderUsage(content, sampleNote(query));
        if (done) turn.setStatus(turnSummary(finalCount, record.usage));
      } else if (type === "restrictions" && content?.restrictions?.length) {
        record.restrictions = content;
        turn.setRestrictions(content);
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

function newChat() {
  thread = null;
  turns = [];
  $("thread").replaceChildren();
  $("chat-title").textContent = "New chat";
  $("intro").hidden = false;
  $("samples").open = true;
  hideUsage();
  markActive(null);
  updateComposerMode();
  $("query").focus();
}

$("new-chat").addEventListener("click", newChat);
$("new-chat-top").addEventListener("click", newChat);

// Which kind of question the box will ask, said where the typing happens: once
// a conversation has turns, the next question is a follow-up read in their
// context; the new-chat icon in the top bar starts clean.
function updateComposerMode() {
  const followUp = turns.length > 0;
  $("followup").hidden = !followUp;
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

function renderUsage(usage, note = "") {
  $("usage-note").hidden = !note;
  $("usage-note-text").textContent = note;
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

// What a sample question tests, shown in the Cost box for its turn.
function sampleNote(query) {
  return (sampleQueries[scope] || []).find(([q]) => q === query)?.[1] || "";
}

function showSamples() {
  const container = $("sample-queries");
  container.replaceChildren();
  if (sampleOrder[scope]) container.append(text("p", sampleOrder[scope], "sample-order"));
  for (const [query] of sampleQueries[scope] || []) {
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
for (const [id, label] of RANKING_MODELS) $("model").append(new Option(label, id));
try {
  const saved = localStorage.getItem(MODEL_KEY);
  if (RANKING_MODELS.some(([id]) => id === saved)) $("model").value = saved;
} catch {}
$("model").addEventListener("change", () => {
  try { localStorage.setItem(MODEL_KEY, $("model").value); } catch {}
});

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
    const meta = text("div", `${label ? `${label} · ` : ""}${when(item.updatedAt)}`, "conversation-meta");
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
  $("intro").hidden = true;
  hideUsage();
  for (const record of turns) {
    const turn = startTurn(record.question, { seq: record.seq });
    turn.setInterpreted(record.interpretedAs);
    turn.setRestrictions(record.restrictions);
    for (const item of record.results || []) turn.results.append(render(item));
    if (record.answer) turn.setAnswer(record.answer);
    for (const notice of record.notices || []) turn.addNotice(notice);
    turn.setStatus(turnSummary((record.results || []).length, record.usage));
  }
  const last = turns[turns.length - 1];
  if (last?.usage) renderUsage(last.usage, sampleNote(last.question));
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
