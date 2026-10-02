// Result cards, one layout per schema.org type.
//
// Each card has the same frame -- picture, title, a line of facts, the ranker's
// reason it matched -- and a type-specific body: cast and director for a
// movie, ingredients for a recipe, the picks for a review, the numbers for a
// home. Everything here reads `item.schema_object`, which saved turns keep, so
// a reopened conversation renders exactly as it did live.

function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined && value !== null) node.textContent = value;
  return node;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function list(value) {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function names(value) {
  return list(value).map(v => decode(typeof v === "string" ? v : v?.name)).filter(Boolean);
}

// "PT1H15M" -> "1 hr 15 min"
function duration(value) {
  const match = /^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(String(value || ""));
  if (!match || (!match[1] && !match[2])) return null;
  const hours = Number(match[1] || 0), minutes = Number(match[2] || 0);
  return [hours && `${hours} hr`, minutes && `${minutes} min`].filter(Boolean).join(" ");
}

function money(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object") return money(value.price ?? value.value);
  const number = Number(String(value).replace(/[$,]/g, ""));
  if (!Number.isFinite(number) || !number) return String(value);
  return number.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function area(value) {
  const number = Number(typeof value === "object" ? value?.value : value);
  if (!Number.isFinite(number) || !number) return null;
  const unit = typeof value === "object" && /ACR/i.test(value.unitCode || "") ? "acres" : "sq ft";
  return `${number.toLocaleString()} ${unit}`;
}

function rating(aggregate, outOf) {
  const value = Number(aggregate?.ratingValue);
  if (!Number.isFinite(value) || !value) return null;
  const count = Number(aggregate.ratingCount ?? aggregate.reviewCount);
  const best = Number(aggregate.bestRating) || outOf;
  const shown = best === 10 ? `${value.toFixed(1)}/10` : `${value.toFixed(1)}`;
  return `★ ${shown}${count ? ` (${count.toLocaleString()})` : ""}`;
}

function year(value) {
  const match = /^(\d{4})/.exec(String(value || ""));
  return match ? match[1] : null;
}

function facts(values) {
  const row = el("div", "facts");
  for (const value of values.filter(Boolean)) row.append(el("span", "fact", value));
  return row.childElementCount ? row : null;
}

function chips(values, className = "chip-tag") {
  const row = el("div", "tags");
  for (const value of [...new Set(values.filter(Boolean))].slice(0, 8)) row.append(el("span", className, value));
  return row.childElementCount ? row : null;
}

function labelled(label, value) {
  if (!value) return null;
  const row = el("div", "labelled");
  row.append(el("span", "label", label), el("span", "", value));
  return row;
}

function expandable(label, items, open = false) {
  if (!items.length) return null;
  const details = el("details", "expand");
  details.open = open;
  details.append(el("summary", "", `${label} (${items.length})`));
  const ul = el("ul", "plain");
  for (const item of items) ul.append(el("li", "", item));
  details.append(ul);
  return details;
}

// Some sources double-encode: IMDb plots arrive as "it&apos;s". Decoding via a
// detached <textarea> never parses markup, so it is safe on untrusted text.
const decoder = document.createElement("textarea");
function decode(text) {
  const value = String(text || "");
  if (!value.includes("&")) return value;
  decoder.innerHTML = value;
  return decoder.value;
}

function clip(text, length) {
  const value = decode(text).trim();
  return value.length > length ? `${value.slice(0, length).replace(/\s+\S*$/, "")}…` : value;
}

// "4 servings" and "Serves 4" both read "Serves 4"; "1 loaf" stays as it is.
function servings(value) {
  const text = String(value).trim();
  if (/^serves\b/i.test(text)) return text;
  if (/servings?/i.test(text) || /^\d+(\s*(to|-)\s*\d+)?$/.test(text)) {
    return `Serves ${text.replace(/\s*servings?/i, "")}`;
  }
  return text;
}

// ---- per-type bodies -------------------------------------------------------

function recipe(s) {
  const times = [
    duration(s.totalTime) && `Total ${duration(s.totalTime)}`,
    duration(s.prepTime) && `Prep ${duration(s.prepTime)}`,
    duration(s.cookTime) && `Cook ${duration(s.cookTime)}`,
  ];
  const calories = s.nutrition?.calories;
  return {
    facts: [rating(s.aggregateRating, 5), ...times, s.recipeYield && servings(s.recipeYield),
            calories && `${String(calories).replace(/\s*calories?/i, "")} cal`],
    tags: [...names(s.recipeCuisine), ...names(s.recipeCategory),
           ...String(s.keywords || "").split(",").map(k => k.trim()).slice(0, 4)],
    byline: names(s.author).join(", "),
    body: [expandable("Ingredients", names(s.recipeIngredient))],
  };
}

function movie(s) {
  const directors = names(s.director);
  const cast = names(s.actor);
  return {
    facts: [year(s.datePublished), duration(s.duration), s.contentRating, rating(s.aggregateRating, 10)],
    tags: names(s.genre),
    body: [
      s.description && el("p", "plot", clip(s.description, 280)),
      labelled(directors.length > 1 ? "Directors" : "Director", directors.join(", ")),
      labelled("Starring", cast.slice(0, 5).join(", ")),
    ],
  };
}

function review(s) {
  const products = list(s.hasPart).filter(p => p && p.name);
  const picks = products.map(p => {
    const offer = list(p.offers)[0];
    const price = money(offer?.price);
    return price ? `${p.name} — ${price}` : p.name;
  });
  return {
    facts: [s.alternativeHeadline && s.alternativeHeadline !== s.name ? s.alternativeHeadline : null,
            s.dateModified && `Updated ${String(s.dateModified).slice(0, 10)}`],
    byline: names(s.author).join(", "),
    body: [
      s.description && el("p", "plot", clip(s.description, 280)),
      expandable(picks.length === 1 ? "The pick" : "Picks", [...new Set(picks)], picks.length <= 3),
    ],
  };
}

// AllTrails keeps length, route type, difficulty and time in its description
// prose: "Try this 1.6-km loop trail near X. Generally considered an easy
// route, it takes an average of 28 min to complete."
function trail(s) {
  const text = String(s.description || "");
  const length = /this ([\d.,]+-(?:km|mile|mi))/i.exec(text)?.[1]?.replace("-", " ");
  const shape = /(loop|out-and-back|point-to-point) trail/i.exec(text)?.[1];
  const difficulty = /considered an? (easy|moderate|moderately challenging|challenging|hard|difficult)/i.exec(text)?.[1];
  const time = /average of ([^.]+?) to complete/i.exec(text)?.[1];
  const dogs = /dogs (?:are )?(?:welcome|allowed)/i.test(text) && !/dogs aren't allowed|no dogs/i.test(text)
    ? "Dogs allowed" : /dogs aren't allowed|leave pups at home/i.test(text) ? "No dogs" : null;
  const lat = s.geo?.latitude, lon = s.geo?.longitude;
  const map = lat && lon ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}` : null;
  const place = s.address?.addressLocality;
  const body = [s.description && el("p", "plot", clip(text, 260))];
  if (map) {
    const link = el("a", "small-link", "Map ↗");
    link.href = map; link.target = "_blank"; link.rel = "noopener noreferrer";
    body.push(link);
  }
  return {
    facts: [rating(s.aggregateRating, 5), length, shape, time && `~${time}`],
    tags: [difficulty && difficulty[0].toUpperCase() + difficulty.slice(1), dogs],
    byline: place,
    body,
  };
}

function home(s) {
  const a = s.address || {};
  const street = [a.streetAddress, a.addressLocality, a.addressRegion].filter(Boolean).join(", ");
  const beds = s.numberOfBedrooms ?? null;
  const baths = s.numberOfBathroomsTotal ?? s.numberOfBathrooms ?? null;
  const features = [...names(s.features), ...names(s.amenities), ...names(s.appliances)];
  return {
    price: money(s.price ?? s.offers?.price ?? list(s.offers)[0]?.price),
    // Some listings give only a room count; show it rather than nothing.
    facts: [beds !== null ? `${beds} bd` : s.numberOfRooms && `${s.numberOfRooms} rooms`,
            baths !== null && `${baths} ba`, area(s.floorSize),
            s.lotSize && `Lot ${area(s.lotSize)}`, s.yearBuilt && `Built ${s.yearBuilt}`],
    tags: [s.propertyType || (s["@type"] === "SingleFamilyResidence" ? "Single family" : null),
           s.listingStatus, s.parking?.name || (s.parking?.numberOfSpaces && `${s.parking.numberOfSpaces}-car parking`)],
    byline: street,
    body: [
      labelled("Schools", [s.schoolDistrict, ...names(s.schools).slice(0, 3)].filter(Boolean).join(" · ")),
      labelled("Heating / cooling", [s.heating, s.cooling].filter(v => v && v !== "None").join(" · ")),
      labelled("HOA", money(s.hoaFee)),
      expandable("Features", features),
    ],
  };
}

const LAYOUTS = [
  [t => t.has("Recipe"), recipe],
  [t => t.has("Movie") || t.has("TVSeries") || t.has("TVEpisode"), movie],
  [t => t.has("Article") || t.has("NewsArticle"), review],
  [t => t.has("LocalBusiness"), trail],
  [t => t.has("SingleFamilyResidence") || t.has("House") || t.has("RealEstateListing"), home],
];

const SOURCES = {
  nytimes: "NYT Cooking", imdb: "IMDb", wirecutter: "Wirecutter", alltrails: "AllTrails", zillow: "Zillow",
};

export function renderCard(item) {
  const s = item.schema_object || {};
  const types = new Set(list(s["@type"]).map(String));
  const layout = LAYOUTS.find(([test]) => test(types))?.[1];
  const parts = layout ? layout(s) : {};

  const li = el("li", "result card");
  const image = safeUrl(s.image);
  if (image) {
    const img = el("img", "thumb");
    img.src = image; img.alt = ""; img.loading = "lazy"; img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => img.remove());
    li.append(img);
  } else {
    li.classList.add("no-thumb");
  }

  const main = el("div", "card-main");
  const head = el("div", "head");
  const url = safeUrl(item.url);
  const title = el(url ? "a" : "span", "title", decode(item.name) || "Untitled");
  if (url) { title.href = url; title.target = "_blank"; title.rel = "noopener noreferrer"; }
  head.append(title);
  if (parts.price) head.append(el("span", "price", parts.price));
  main.append(head);

  const byline = [parts.byline, SOURCES[item.site] || item.site].filter(Boolean).join(" · ");
  main.append(el("div", "meta", byline));
  for (const node of [facts(parts.facts || []), chips(parts.tags || [])]) if (node) main.append(node);
  if (item.description) main.append(el("p", "why", item.description));
  for (const node of parts.body || []) if (node) main.append(node);

  li.append(main);
  return li;
}
