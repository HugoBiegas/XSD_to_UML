/* ============================================================================
 * XSD → UML · Visualiseur de schémas (100% local, sans dépendance)
 *
 * Pipeline :
 *   1. Sélection d'un dossier (récursif)  -> fs
 *   2. Parsing XSD (DOMParser)            -> model
 *   3. Fusion globale des types par nom   -> model
 *   4. Layout hiérarchique (héritage)     -> layout
 *   5. Rendu canvas infini (DOM + SVG)    -> render
 *   6. Recherche / liste / focus / Excel  -> ui / export
 * ==========================================================================*/
(function () {
  "use strict";

  /* ----------------------------- Constantes ------------------------------ */
  const XSD_BUILTINS = new Set([
    "string","boolean","decimal","float","double","duration","dateTime","time","date",
    "gYearMonth","gYear","gMonthDay","gDay","gMonth","hexBinary","base64Binary","anyURI",
    "QName","NOTATION","normalizedString","token","language","NMTOKEN","NMTOKENS","Name",
    "NCName","ID","IDREF","IDREFS","ENTITY","ENTITIES","integer","nonPositiveInteger",
    "negativeInteger","long","int","short","byte","nonNegativeInteger","unsignedLong",
    "unsignedInt","unsignedShort","unsignedByte","positiveInteger","anyType","anySimpleType"
  ]);

  const FONT_TITLE = '700 13px "Segoe UI", sans-serif';
  const FONT_BODY  = '12px "Segoe UI", sans-serif';
  const HEADER_H = 30, LINE_H = 18, BODY_TOP = 4, BODY_BOT = 6;
  const GAPX = 72, GAPY = 66, BLOCK_GAP = 96, MARGIN = 90;
  const NODE_MIN_W = 150, NODE_MAX_W = 560;
  // En dessous de ce nombre d'entités, on coche tout par défaut (assoc comprises) ;
  // au-dessus, on coche seulement Propriétés + Enums (les assoc, lourdes, restent activables).
  const SMALL_CORPUS = 120;
  const PALETTE = [
    "#3b82f6","#10b981","#f59e0b","#ef4444","#a78bfa","#ec4899","#14b8a6",
    "#f97316","#6366f1","#84cc16","#06b6d4","#e11d48","#8b5cf6","#22c55e",
    "#eab308","#0ea5e9","#d946ef","#f43f5e","#65a30d","#0891b2"
  ];

  /* ------------------------------- État ---------------------------------- */
  const state = {
    classes: new Map(),        // name -> {name, abstract, base, simpleBase, props[], files:Set}
    enums: new Map(),          // name -> {name, values[], files:Set}
    elementToType: new Map(),  // elementName -> typeName
    childrenMap: new Map(),    // parentName -> [childName]
    rootColor: new Map(),      // name -> color (par famille)
    files: [],

    mode: "global",            // "global" | "focus" | "liaison"
    focusRoot: null,
    selected: null,            // classe sélectionnée (primaire, pour le panneau détails)
    selectedEnum: null,        // enum sélectionné (clé "enum::Nom")
    multiSel: new Set(),       // sélection multiple (rubber-band / Maj+clic) -> clés de classes

    adjacency: new Map(),      // name -> Set(voisins) (héritage + assoc, non orienté) — pour la liaison
    liaisonSel: [],            // entités d'origine d'une liaison
    liaisonUnion: null,        // Set des entités du sous-graphe de liaison courant
    liaisonPathEdges: new Set(),// arêtes "a|b" appartenant aux chemins de liaison (surbrillance)

    layout: new Map(),         // name|enum::name -> {x,y,w,h}
    nodeSet: new Set(),        // clés présentes dans la vue courante
    edges: [],
    worldW: 0, worldH: 0,
    globalLayoutCache: null,   // {layout, worldW, worldH, expanded}

    view: { tx: 0, ty: 0, scale: 1 },
    showAssoc: false,
    showEnums: false,
    showProps: false,          // case "Propriétés" : compartiments de propriétés (global ET focus)
    depthLimit: 10,            // 0..20 niveaux de sous-classes ; 20 = sans limite (∞)

    // --- rendu incrémental (LOD + culling) ---
    _region: null,             // zone monde actuellement montée dans le DOM
    _lod: null,                // niveau de détail rendu : "mini" | "compact" | "full"
    _paintReq: 0,
  };

  /* --------------------------- Références DOM ---------------------------- */
  const $ = (id) => document.getElementById(id);
  const canvas = $("canvas"), world = $("world"), edgesSvg = $("edges"), nodesLayer = $("nodes");
  const emptyEl = $("empty"), progressEl = $("progress"), progressBar = $("progressBar"), progressText = $("progressText");
  const sidebar = $("sidebar"), statsEl = $("stats"), searchEl = $("search"), listEl = $("entityList"), listCountEl = $("listCount"), sortSel = $("sortSel"), filterSel = $("filterSel");
  const detailsPanel = $("detailsPanel"), detName = $("detName"), detStereo = $("detStereo"), detBody = $("detBody");
  const dirInput = $("dirInput");
  const zoomLabel = $("zoomLabel");
  const depthRange = $("depthRange"), depthVal = $("depthVal");
  const modePill = $("modePill"), modeLabel = $("modeLabel");
  const btnExportFull = $("btnExportFull");
  const selBox = $("selBox"), selBar = $("selBar"), selCount = $("selCount"), btnLiaison = $("btnLiaison");
  const liaisonBasket = $("liaisonBasket"), basketChips = $("basketChips"), btnBasketLink = $("btnBasketLink"), btnBasketExcel = $("btnBasketExcel");

  const mctx = document.createElement("canvas").getContext("2d");
  function measure(text, font) { mctx.font = font; return mctx.measureText(text).width; }

  /* =======================================================================
   *  1-3.  PARSING + FUSION
   * =====================================================================*/
  function localName(t) {
    if (t == null) return null;
    const i = t.indexOf(":");
    return i >= 0 ? t.slice(i + 1) : t;
  }
  function kidsByLocal(el, local) {
    const out = [];
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === local) out.push(c);
    return out;
  }
  function firstKid(el, local) {
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === local) return c;
    return null;
  }
  function deepFind(el, local) {
    const all = el.getElementsByTagName("*");
    for (let i = 0; i < all.length; i++) if (all[i].localName === local) return all[i];
    return null;
  }

  function cardOf(p) {
    const mn = (p.min == null || p.min === "") ? "1" : p.min;
    let mx = (p.max == null || p.max === "") ? "1" : p.max;
    if (mx === "unbounded") mx = "*";
    return mn + ".." + mx;
  }

  // type "résolu" d'une propriété -> nom d'entité/enum (localName) ou type primitif
  function refTypeOf(p) {
    let raw = p.rawType;
    if (raw == null) return null;
    let ln = localName(raw);
    if (p.isRef && state.elementToType.has(ln)) ln = localName(state.elementToType.get(ln));
    else if (state.elementToType.has(ln) && !state.classes.has(ln) && !state.enums.has(ln)) {
      // l'élément référencé pointe vers un type nommé
      ln = localName(state.elementToType.get(ln));
    }
    return ln;
  }
  function typeKind(name) {
    if (state.classes.has(name)) return "entity";
    if (state.enums.has(name)) return "enum";
    return "prim";
  }

  // Construit une propriété depuis un <xs:element> ou <xs:attribute>
  function makeProp(el, isAttr) {
    const ref = el.getAttribute("ref");
    const name = el.getAttribute("name");
    const type = el.getAttribute("type");
    const min = el.getAttribute("minOccurs");
    const max = el.getAttribute("maxOccurs");
    const nillable = el.getAttribute("nillable") === "true";
    if (ref && !name) {
      const rn = localName(ref);
      return { name: rn, isRef: true, rawType: ref, min, max, nillable, attr: false };
    }
    if (type) {
      return { name: name || "(?)", isRef: false, rawType: type, min, max, nillable, attr: !!isAttr };
    }
    // <xs:element name="x"> ... type anonyme imbriqué : on cherche le type/ref interne
    let inner = null;
    const innerEl = (function () {
      const all = el.getElementsByTagName("*");
      for (let i = 0; i < all.length; i++) {
        const c = all[i];
        if (c.localName === "element" && c !== el) {
          const t = c.getAttribute("type") || c.getAttribute("ref");
          if (t) return t;
        }
      }
      return null;
    })();
    inner = innerEl;
    return { name: name || "(anonyme)", isRef: false, rawType: inner || "anyType", min, max, nillable, inline: true, attr: false };
  }

  // Récupère récursivement les propriétés d'un conteneur (sequence/choice/all/group)
  function collectProps(container) {
    const props = [];
    (function walk(node) {
      for (let c = node.firstElementChild; c; c = c.nextElementSibling) {
        const ln = c.localName;
        if (ln === "sequence" || ln === "choice" || ln === "all" || ln === "group") walk(c);
        else if (ln === "element") props.push(makeProp(c, false));
        else if (ln === "attribute") props.push(makeProp(c, true));
      }
    })(container);
    return props;
  }

  // Détermine base + conteneur de contenu d'un complexType
  function contentOf(ct) {
    const cc = firstKid(ct, "complexContent");
    if (cc) {
      const ext = firstKid(cc, "extension") || firstKid(cc, "restriction");
      if (ext) return { base: ext.getAttribute("base"), container: ext, simpleBase: false };
    }
    const sc = firstKid(ct, "simpleContent");
    if (sc) {
      const ext = firstKid(sc, "extension") || firstKid(sc, "restriction");
      if (ext) return { base: ext.getAttribute("base"), container: ext, simpleBase: true };
    }
    return { base: null, container: ct, simpleBase: false };
  }

  function parseXsd(text, fileName) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) {
      console.warn("Erreur XML dans", fileName);
      return;
    }
    let schema = doc.documentElement;
    if (!schema || schema.localName !== "schema") {
      schema = deepFind(doc, "schema");
      if (!schema) return;
    }

    // éléments de premier niveau
    for (const el of kidsByLocal(schema, "element")) {
      const nm = el.getAttribute("name");
      const tp = el.getAttribute("type");
      if (nm && tp && !state.elementToType.has(nm)) state.elementToType.set(nm, tp);
    }
    // simpleTypes (enums)
    for (const st of kidsByLocal(schema, "simpleType")) {
      const nm = st.getAttribute("name");
      if (!nm) continue;
      const restr = firstKid(st, "restriction");
      const values = [];
      if (restr) for (const en of kidsByLocal(restr, "enumeration")) values.push(en.getAttribute("value"));
      addEnum({ name: nm, values }, fileName);
    }
    // complexTypes
    for (const ct of kidsByLocal(schema, "complexType")) {
      const nm = ct.getAttribute("name");
      if (!nm) continue;
      const { base, container, simpleBase } = contentOf(ct);
      const props = collectProps(container);
      addClass({
        name: nm,
        abstract: ct.getAttribute("abstract") === "true",
        base: base ? localName(base) : null,
        simpleBase: simpleBase,
        props,
      }, fileName);
    }
  }

  function classScore(c) { return (c.props ? c.props.length : 0) * 10 + (c.base ? 5 : 0) + (c.abstract ? 1 : 0); }

  function addClass(c, file) {
    const ex = state.classes.get(c.name);
    if (!ex) { c.files = new Set([file]); state.classes.set(c.name, c); return; }
    ex.files.add(file);
    if (!ex.base && c.base) ex.base = c.base;
    if (classScore(c) > classScore(ex)) { c.files = ex.files; c.files.add(file); state.classes.set(c.name, c); }
  }
  function addEnum(e, file) {
    const ex = state.enums.get(e.name);
    if (!ex) { e.values = [...new Set(e.values)]; e.files = new Set([file]); state.enums.set(e.name, e); return; }
    ex.files.add(file);
    const set = new Set(ex.values); e.values.forEach(v => set.add(v)); ex.values = [...set];
  }

  function finalizeModel() {
    // carte des enfants (héritage)
    state.childrenMap = new Map();
    for (const c of state.classes.values()) {
      const b = c.base ? localName(c.base) : null;
      if (b && b !== c.name && state.classes.has(b)) {
        if (!state.childrenMap.has(b)) state.childrenMap.set(b, []);
        state.childrenMap.get(b).push(c.name);
      }
    }
    for (const arr of state.childrenMap.values()) arr.sort((a, b) => a.localeCompare(b));
    // couleur par famille (racine)
    state.rootColor = new Map();
    let pi = 0;
    const rootCache = new Map();
    for (const name of state.classes.keys()) {
      const r = rootOf(name);
      if (!rootCache.has(r)) rootCache.set(r, PALETTE[pi++ % PALETTE.length]);
      state.rootColor.set(name, rootCache.get(r));
    }
    buildAdjacency();
    state.globalLayoutCache = null;
  }

  // Graphe non orienté (héritage + associations entre classes) pour le calcul des liaisons.
  // Tous les types sont inclus (conteneurs compris) : un conteneur peut être une EXTRÉMITÉ
  // valide (ex. alignement ↔ alignements). En revanche le BFS n'autorise pas à TRAVERSER un
  // conteneur non sélectionné (sinon presque tout serait relié trivialement) — voir bfsPred().
  function buildAdjacency() {
    const adj = new Map();
    const link = (a, b) => {
      if (a === b) return;
      if (!adj.has(a)) adj.set(a, new Set());
      adj.get(a).add(b);
    };
    for (const [name, c] of state.classes) {
      const b = baseOf(name);
      if (b) { link(name, b); link(b, name); }
      for (const p of c.props) {
        const rt = refTypeOf(p);
        if (rt && state.classes.has(rt)) { link(name, rt); link(rt, name); }
      }
    }
    state.adjacency = adj;
  }

  /* ----------------------------- Helpers modèle -------------------------- */
  function childrenOf(name) { return state.childrenMap.get(name) || []; }
  // type "conteneur" (wrapper de document : que des <xs:element ref=...>), à exclure des focus
  function isContainer(name) {
    const c = state.classes.get(name);
    return !!c && c.props.length > 1 && c.props.every(p => p.isRef);
  }
  function baseOf(name) {
    const c = state.classes.get(name);
    if (!c || !c.base) return null;
    const b = localName(c.base);
    return state.classes.has(b) ? b : null;
  }
  function ancestors(name) {
    const out = []; const seen = new Set([name]);
    let cur = baseOf(name);
    while (cur && !seen.has(cur)) { out.push(cur); seen.add(cur); cur = baseOf(cur); }
    return out; // [parent, grandparent, ..., root]
  }
  function rootOf(name) {
    const a = ancestors(name);
    return a.length ? a[a.length - 1] : name;
  }
  function descendants(name) {
    const out = []; const seen = new Set();
    const stack = [...childrenOf(name)];
    while (stack.length) {
      const n = stack.pop();
      if (seen.has(n)) continue; seen.add(n); out.push(n);
      for (const k of childrenOf(n)) if (!seen.has(k)) stack.push(k);
    }
    return out;
  }
  function collectTree(root, set) {
    set.add(root);
    for (const k of childrenOf(root)) if (!set.has(k)) collectTree(k, set);
  }
  // profondeur effective : 20 sur le curseur => infini
  function effDepth() { return state.depthLimit >= 20 ? Infinity : state.depthLimit; }
  // descendants jusqu'à `max` niveaux (1 = sous-classes directes). max=0 => aucun.
  function descendantsLimited(name, max) {
    if (max === Infinity) return descendants(name);
    const out = []; if (max <= 0) return out;
    const seen = new Set(); let frontier = [...childrenOf(name)], d = 1;
    while (frontier.length && d <= max) {
      const next = [];
      for (const n of frontier) { if (seen.has(n)) continue; seen.add(n); out.push(n); for (const k of childrenOf(n)) if (!seen.has(k)) next.push(k); }
      frontier = next; d++;
    }
    return out;
  }
  // sous-arbre d'un racine borné à `max` niveaux de profondeur
  function collectTreeLimited(root, set, max) {
    set.add(root);
    if (max === Infinity) { for (const k of childrenOf(root)) if (!set.has(k)) collectTreeLimited(k, set, Infinity); return; }
    let frontier = [root], d = 0;
    while (frontier.length && d < max) {
      const next = [];
      for (const n of frontier) for (const k of childrenOf(n)) if (!set.has(k)) { set.add(k); next.push(k); }
      frontier = next; d++;
    }
  }
  // propriétés propres + héritées, avec origine
  function allPropsWithOrigin(name) {
    const order = [...ancestors(name)].reverse(); order.push(name); // root..self
    const rows = [];
    for (const cn of order) {
      const c = state.classes.get(cn); if (!c) continue;
      for (const p of c.props) rows.push({ owner: cn, p, inherited: cn !== name });
    }
    return rows;
  }
  function assocOf(name) {
    const c = state.classes.get(name); if (!c) return [];
    const out = []; const seen = new Set();
    for (const p of c.props) {
      const rt = refTypeOf(p);
      if (rt && (state.classes.has(rt) || state.enums.has(rt))) {
        const key = p.name + ">" + rt; if (seen.has(key)) continue; seen.add(key);
        out.push({ prop: p.name, target: rt, kind: typeKind(rt), card: cardOf(p) });
      }
    }
    return out;
  }

  /* =======================================================================
   *  4.  LAYOUT
   * =====================================================================*/
  function sizeOf(key, expanded) {
    if (key.startsWith("enum::")) return sizeEnum(key.slice(6));
    const c = state.classes.get(key);
    let w = measure(key, FONT_TITLE) + 54; // padding + badge + bouton focus
    let lines = 0;
    if (expanded && c) {
      for (const p of c.props) {
        const label = p.name + " : " + typeShort(p);
        w = Math.max(w, measure(label, FONT_BODY) + 22);
      }
      lines = c.props.length;
    }
    w = Math.max(NODE_MIN_W, Math.min(NODE_MAX_W, Math.ceil(w)));
    const h = HEADER_H + (lines ? BODY_TOP + lines * LINE_H + BODY_BOT : 0);
    return { w, h };
  }
  function sizeEnum(name) {
    const e = state.enums.get(name); const vals = e ? e.values : [];
    let w = measure(name, FONT_TITLE) + 44;
    for (let i = 0; i < vals.length; i++) w = Math.max(w, measure(String(vals[i]), FONT_BODY) + 22);
    w = Math.max(120, Math.min(NODE_MAX_W, Math.ceil(w)));
    const h = HEADER_H + BODY_TOP + Math.max(1, vals.length) * LINE_H + BODY_BOT; // toutes les valeurs
    return { w, h };
  }
  function typeShort(p) {
    const rt = refTypeOf(p);
    const base = rt || localName(p.rawType);
    const card = cardOf(p);
    return base + (card === "1..1" ? "" : " [" + card + "]");
  }

  // Tidy-tree : positionne un arbre (centres x, y par profondeur). Largeurs variables gérées aux feuilles.
  function layoutTree(root, inSet, expanded) {
    const size = new Map();
    for (const n of inSet) size.set(n, sizeOf(n, expanded));
    const pos = new Map(); // n -> {cx, d}
    const maxHByDepth = [];
    let cursor = 0;
    const seen = new Set();
    (function dfs(n, d) {
      if (seen.has(n)) return; seen.add(n);
      maxHByDepth[d] = Math.max(maxHByDepth[d] || 0, size.get(n).h);
      const kids = childrenOf(n).filter(k => inSet.has(k)).sort((a, b) => a.localeCompare(b));
      if (kids.length === 0) {
        const w = size.get(n).w;
        pos.set(n, { cx: cursor + w / 2, d });
        cursor += w + GAPX;
      } else {
        for (const k of kids) dfs(k, d + 1);
        const placed = kids.filter(k => pos.has(k));
        const first = pos.get(placed[0]).cx, last = pos.get(placed[placed.length - 1]).cx;
        pos.set(n, { cx: (first + last) / 2, d });
      }
    })(root, 0);
    const rowY = []; let acc = 0;
    for (let d = 0; d < maxHByDepth.length; d++) { rowY[d] = acc; acc += (maxHByDepth[d] || 40) + GAPY; }
    const out = new Map();
    for (const [n, p] of pos) {
      const s = size.get(n);
      out.set(n, { x: p.cx - s.w / 2, y: rowY[p.d], w: s.w, h: s.h });
    }
    return out;
  }

  function bboxOf(layout) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of layout.values()) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.w); maxY = Math.max(maxY, p.y + p.h);
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX, minY, maxX, maxY };
  }

  function layoutGlobal() {
    const expanded = state.showProps;
    const placed = new Set();
    const blocks = [];
    // un bloc par racine d'héritage
    const roots = [];
    for (const name of state.classes.keys()) if (!baseOf(name)) roots.push(name);
    roots.sort((a, b) => a.localeCompare(b));
    const maxD = effDepth();
    for (const r of roots) {
      const set = new Set(); collectTreeLimited(r, set, maxD);
      const tl = layoutTree(r, set, expanded);
      const bb = bboxOf(tl);
      // recaler le bloc à (0,0)
      for (const p of tl.values()) { p.x -= bb.minX; p.y -= bb.minY; }
      blocks.push({ tl, w: bb.maxX - bb.minX, h: bb.maxY - bb.minY });
      for (const k of set) placed.add(k);
    }
    // classes orphelines (cycles éventuels) — hors nœuds exclus par la profondeur
    for (const name of state.classes.keys()) {
      if (placed.has(name)) continue;
      if (ancestors(name).length > maxD) continue;
      const s = sizeOf(name, expanded); const tl = new Map([[name, { x: 0, y: 0, w: s.w, h: s.h }]]);
      blocks.push({ tl, w: s.w, h: s.h }); placed.add(name);
    }
    // packing en étagères
    blocks.sort((a, b) => b.h - a.h || b.w - a.w);
    const limit = Math.max(2600, Math.ceil(Math.sqrt(blocks.length)) * 560);
    const layout = new Map();
    let x = 0, y = 0, rowH = 0;
    for (const b of blocks) {
      if (x > 0 && x + b.w > limit) { x = 0; y += rowH + BLOCK_GAP; rowH = 0; }
      for (const [n, p] of b.tl) layout.set(n, { x: p.x + x, y: p.y + y, w: p.w, h: p.h });
      x += b.w + BLOCK_GAP; rowH = Math.max(rowH, b.h);
    }
    // enums (optionnel) : bande en bas
    if (state.showEnums && state.enums.size) {
      const bb = bboxOf(layout);
      let ex = 0, ey = (isFinite(bb.maxY) ? bb.maxY : 0) + BLOCK_GAP * 1.5, erowH = 0;
      const enames = [...state.enums.keys()].sort((a, b) => a.localeCompare(b));
      for (const en of enames) {
        const s = sizeEnum(en);
        if (ex > 0 && ex + s.w > limit) { ex = 0; ey += erowH + 40; erowH = 0; }
        layout.set("enum::" + en, { x: ex, y: ey, w: s.w, h: s.h });
        ex += s.w + 30; erowH = Math.max(erowH, s.h);
      }
    }
    return normalize(layout);
  }

  function layoutFocus(rootName) {
    const expanded = state.showProps;
    const maxD = effDepth();
    const focusDesc = descendantsLimited(rootName, maxD);
    const inhSet = new Set([rootName]);
    ancestors(rootName).forEach(a => inhSet.add(a));
    focusDesc.forEach(d => inhSet.add(d));
    const top = ancestors(rootName).slice(-1)[0] || rootName;
    const tl = layoutTree(top, inhSet, expanded);
    // Voisins (enums + associations) ajoutés UNIQUEMENT selon les cases à cocher.
    // C'est le levier anti-lag : sur un gros focus, Associations décochée = juste l'héritage.
    const layout = new Map(tl);
    const neighbors = [];
    const seen = new Set(inhSet);
    if (state.showEnums) {
      // ÉNUMS : chaque propriété de type énum (de toute entité du focus) fait apparaître son énum.
      for (const n of inhSet) {
        const c = state.classes.get(n); if (!c) continue;
        for (const p of c.props) {
          const rt = refTypeOf(p);
          if (rt && state.enums.has(rt) && !seen.has("enum::" + rt)) { seen.add("enum::" + rt); neighbors.push("enum::" + rt); }
        }
      }
    }
    if (state.showAssoc) {
      // SORTANTES : entité focalisée + descendants (les ancêtres restent une colonne d'héritage).
      const assocScope = [rootName, ...focusDesc];
      for (const n of assocScope) {
        const c = state.classes.get(n); if (!c) continue;
        for (const p of c.props) {
          const rt = refTypeOf(p);
          if (rt && state.classes.has(rt) && !seen.has(rt) && !isContainer(rt)) { seen.add(rt); neighbors.push(rt); }
        }
      }
      // ENTRANTES : classes (non conteneurs) référençant l'entité ou ses descendants (bornés).
      const inboundTargets = new Set([rootName, ...focusDesc]);
      for (const [cn, c] of state.classes) {
        if (seen.has(cn) || isContainer(cn)) continue;
        for (const p of c.props) {
          const rt = refTypeOf(p);
          if (rt && inboundTargets.has(rt)) { seen.add(cn); neighbors.push(cn); break; }
        }
      }
    }
    if (neighbors.length) {
      const bb = bboxOf(tl);
      neighbors.sort();
      let ny = bb.minY, nx = bb.maxX + 160, colMax = 0;
      const limitY = bb.maxY + 600;
      for (const key of neighbors) {
        const s = sizeOf(key, expanded);
        if (ny > limitY && ny !== bb.minY) { ny = bb.minY; nx += colMax + 60; colMax = 0; }
        layout.set(key, { x: nx, y: ny, w: s.w, h: s.h });
        ny += s.h + 24; colMax = Math.max(colMax, s.w);
      }
    }
    return normalize(layout);
  }

  function normalize(layout) {
    const bb = bboxOf(layout);
    const dx = MARGIN - bb.minX, dy = MARGIN - bb.minY;
    for (const p of layout.values()) { p.x += dx; p.y += dy; }
    const nb = bboxOf(layout);
    return { layout, worldW: nb.maxX + MARGIN, worldH: nb.maxY + MARGIN };
  }

  /* =======================================================================
   *  5.  RENDU
   * =====================================================================*/
  function buildEdges() {
    const set = state.nodeSet, E = [];
    for (const key of set) {
      if (key.startsWith("enum::")) continue;
      const b = baseOf(key);
      if (b && set.has(b)) E.push({ from: key, to: b, kind: "inh" });
    }
    // Arêtes d'association (classe→classe) si la case est cochée (toujours en mode liaison).
    // Arêtes vers énums dès que le nœud énum est présent (donc piloté par la case Enums).
    const drawAssoc = state.showAssoc || state.mode === "liaison";
    for (const key of set) {
      if (key.startsWith("enum::")) continue;
      const c = state.classes.get(key); if (!c) continue;
      const seen = new Set();
      for (const p of c.props) {
        const rt = refTypeOf(p); if (!rt) continue;
        let tgt = null;
        if (drawAssoc && state.classes.has(rt) && set.has(rt)) tgt = rt;
        else if (state.enums.has(rt) && set.has("enum::" + rt)) tgt = "enum::" + rt;
        if (!tgt || tgt === key) continue;
        const k = key + ">" + tgt; if (seen.has(k)) continue; seen.add(k);
        E.push({ from: key, to: tgt, kind: tgt.startsWith("enum::") ? "enum" : "assoc", label: p.name });
      }
    }
    state.edges = E;
  }

  function borderPoint(box, tx, ty) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const dx = tx - cx, dy = ty - cy;
    if (dx === 0 && dy === 0) return { x: cx, y: cy };
    const hw = box.w / 2, hh = box.h / 2;
    const sx = dx === 0 ? Infinity : hw / Math.abs(dx);
    const sy = dy === 0 ? Infinity : hh / Math.abs(dy);
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  function r0(n) { return Math.round(n); }
  function edgeKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }

  // Pointe de flèche dessinée DANS la géométrie (pas de <marker>) -> permet le batching.
  function arrowTri(tip, dx, dy, size) {
    const px = -dy, py = dx, w = size * 0.62;
    const bx = tip.x - dx * size, by = tip.y - dy * size;
    return `M${r0(tip.x)},${r0(tip.y)} L${r0(bx + px * w)},${r0(by + py * w)} L${r0(bx - px * w)},${r0(by - py * w)}Z`;
  }
  function arrowChevron(tip, dx, dy, size) {
    const px = -dy, py = dx, w = size * 0.55;
    const bx = tip.x - dx * size, by = tip.y - dy * size;
    return `M${r0(bx + px * w)},${r0(by + py * w)} L${r0(tip.x)},${r0(tip.y)} L${r0(bx - px * w)},${r0(by - py * w)}`;
  }
  function edgeNearRegion(a, b, region) {
    const minX = Math.min(a.x, b.x), minY = Math.min(a.y, b.y);
    const maxX = Math.max(a.x + a.w, b.x + b.w), maxY = Math.max(a.y + a.h, b.y + b.h);
    return !(minX > region.maxX || maxX < region.minX || minY > region.maxY || maxY < region.minY);
  }

  // Toutes les arêtes d'un même type sont fusionnées en un seul <path> (flèches incluses)
  // et seules celles proches de la zone rendue sont tracées. Énorme gain de DOM/SVG.
  function paintEdges(region) {
    const L = state.layout;
    // LOD des arêtes : au zoom éloigné (mini) -> traits pleins fins, SANS flèches ni pointillés
    // ni libellés (illisibles à cette échelle), ce qui supprime le gros coût de rastérisation.
    const mini = state._lod === "mini";
    const showLabels = !mini && (state.mode === "focus" || state.mode === "liaison") && state._lod === "full";
    let dInh = "", dAssoc = "", dEnum = "", aInh = "", aAssoc = "", aEnum = "", dLia = "", labels = "";
    let nLabels = 0;
    const liaison = state.mode === "liaison" && state.liaisonPathEdges.size;
    for (const e of state.edges) {
      const a = L.get(e.from), b = L.get(e.to);
      if (!a || !b) continue;
      if (region && !edgeNearRegion(a, b, region)) continue;
      const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
      const pa = borderPoint(a, bcx, bcy), pb = borderPoint(b, acx, acy);
      let d;
      if (e.kind === "inh") {
        const my = (pa.y + pb.y) / 2;
        d = `M${r0(pa.x)},${r0(pa.y)} C${r0(pa.x)},${r0(my)} ${r0(pb.x)},${r0(my)} ${r0(pb.x)},${r0(pb.y)}`;
        dInh += d;
      } else {
        const mx = (pa.x + pb.x) / 2;
        d = `M${r0(pa.x)},${r0(pa.y)} C${r0(mx)},${r0(pa.y)} ${r0(mx)},${r0(pb.y)} ${r0(pb.x)},${r0(pb.y)}`;
        if (e.kind === "enum") dEnum += d; else dAssoc += d;
        if (showLabels && e.label && nLabels < 140) {
          labels += `<text class="e-label" x="${r0((pa.x + pb.x) / 2)}" y="${r0((pa.y + pb.y) / 2 - 3)}">${escapeHtml(e.label)}</text>`;
          nLabels++;
        }
      }
      if (!mini) {                                 // flèches seulement quand c'est lisible
        const len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
        const ux = (pb.x - pa.x) / len, uy = (pb.y - pa.y) / len;
        if (e.kind === "inh") aInh += arrowTri(pb, ux, uy, 12);
        else if (e.kind === "enum") aEnum += arrowChevron(pb, ux, uy, 10);
        else aAssoc += arrowChevron(pb, ux, uy, 10);
      }
      if (liaison && state.liaisonPathEdges.has(edgeKey(e.from, e.to))) dLia += d;
    }
    edgesSvg.classList.toggle("lod-mini", mini);
    let svg = "";
    if (dLia) svg += `<path class="e-lia" d="${dLia}"/>`;       // surbrillance sous les arêtes
    if (dInh) svg += `<path class="e-inh" d="${dInh}"/>`;
    if (dAssoc) svg += `<path class="e-assoc" d="${dAssoc}"/>`;
    if (dEnum) svg += `<path class="e-enum" d="${dEnum}"/>`;
    if (aInh) svg += `<path class="e-inh-arrow" d="${aInh}"/>`;
    if (aAssoc) svg += `<path class="e-assoc-arrow" d="${aAssoc}"/>`;
    if (aEnum) svg += `<path class="e-enum-arrow" d="${aEnum}"/>`;
    edgesSvg.innerHTML = svg + labels;
  }

  function nodeHtml(key, lod) {
    const box = state.layout.get(key);
    const isEnum = key.startsWith("enum::");
    const style = `left:${box.x}px;top:${box.y}px;width:${box.w}px`;
    // Niveau "mini" (très dézoomé) : un simple bloc coloré, illisible de toute façon -> léger.
    if (lod === "mini") {
      const color = isEnum ? "#6d5bb5" : (state.rootColor.get(key) || "#3b82f6");
      return `<div class="node mini${isEnum ? " enum-node" : ""}" data-name="${escapeAttr(key)}" style="${style};height:${box.h}px;background:${color}"></div>`;
    }
    if (isEnum) {
      const name = key.slice(6); const e = state.enums.get(name); const vals = e ? e.values : [];
      let body = "";
      if (lod === "full") {
        for (const v of vals) body += `<div class="prop"><span class="pn">${escapeHtml(String(v))}</span></div>`;
        body = `<div class="node-body">${body}</div>`;
      }
      return `<div class="node enum-node" data-name="${escapeAttr(key)}" style="${style}">
        <div class="node-hd" style="background:#6d5bb5">
          <span class="nm">${escapeHtml(name)}<span class="stereo">«enum»</span></span>
        </div>${body}
      </div>`;
    }
    const c = state.classes.get(key);
    const color = state.rootColor.get(key) || "#3b82f6";
    const expanded = lod === "full" && state.showProps;
    const abs = c.abstract ? `<span class="abs">{abstrait}</span>` : "";
    let body = "";
    if (expanded) {
      if (c.props.length) {
        for (const p of c.props) {
          const rt = refTypeOf(p); const kind = rt ? typeKind(rt) : "prim";
          const cls = kind === "entity" ? "prop assoc" : kind === "enum" ? "prop enum" : "prop";
          body += `<div class="${cls}"><span class="pn">${escapeHtml(p.name)}</span><span class="pt">${escapeHtml(typeShort(p))}</span></div>`;
        }
      } else {
        body = `<div class="prop"><span class="pn" style="opacity:.5">(aucune propriété propre)</span></div>`;
      }
      body = `<div class="node-body">${body}</div>`;
    }
    return `<div class="node" data-name="${escapeAttr(key)}" style="${style}">
      <div class="node-hd" style="background:${color}">
        <span class="nm">${escapeHtml(key)} ${abs}</span>
        <span class="badge">${c.props.length}</span>
        <button class="node-foc" data-foc="${escapeAttr(key)}" title="Focus héritage">⤢</button>
      </div>${body}
    </div>`;
  }

  // Re-construit entièrement la vue (arêtes + taille du monde) puis peint la zone visible.
  function render() {
    buildEdges();
    world.style.width = state.worldW + "px";
    world.style.height = state.worldH + "px";
    edgesSvg.setAttribute("width", state.worldW);
    edgesSvg.setAttribute("height", state.worldH);
    edgesSvg.style.width = state.worldW + "px";
    edgesSvg.style.height = state.worldH + "px";
    state._region = null;
    paint();
    applyTransform();
  }

  // Niveau de détail selon le zoom : props lisibles -> "full", sinon en-tête seul, sinon bloc.
  function lodLevel() {
    const s = state.view.scale;
    if (s < 0.16) return "mini";
    if (s < 0.42) return "compact";
    return "full";
  }
  // Fenêtre visible en coordonnées "monde", élargie d'une marge (fraction de la fenêtre).
  function viewportWorldRect(marginFrac) {
    const r = canvas.getBoundingClientRect();
    const visW = Math.max(160, r.width - rightInset());
    const v = state.view, s = v.scale;
    const x0 = -v.tx / s, y0 = -v.ty / s;
    const x1 = (visW - v.tx) / s, y1 = (r.height - v.ty) / s;
    const mx = (x1 - x0) * marginFrac, my = (y1 - y0) * marginFrac;
    return { minX: x0 - mx, minY: y0 - my, maxX: x1 + mx, maxY: y1 + my };
  }

  // Monte UNIQUEMENT les nœuds visibles, au LOD courant. Le reste n'existe pas dans le DOM.
  function paint() {
    const lod = lodLevel();
    const region = viewportWorldRect(0.6);
    state._lod = lod; state._region = region;
    let html = "";
    for (const key of state.nodeSet) {
      const b = state.layout.get(key); if (!b) continue;
      if (b.x > region.maxX || b.x + b.w < region.minX || b.y > region.maxY || b.y + b.h < region.minY) continue;
      html += nodeHtml(key, lod);
    }
    nodesLayer.innerHTML = html;
    paintEdges(region);
    applySelectionClasses();
  }

  function schedulePaint() {
    if (state._paintReq) return;
    state._paintReq = requestAnimationFrame(() => { state._paintReq = 0; maybePaint(); });
  }
  // Ne repeint que si le LOD change ou si la fenêtre sort de la zone déjà rendue (pan fluide).
  function maybePaint() {
    if (!state._region || lodLevel() !== state._lod) { paint(); return; }
    const vp = viewportWorldRect(0), reg = state._region;
    if (vp.minX < reg.minX || vp.minY < reg.minY || vp.maxX > reg.maxX || vp.maxY > reg.maxY) paint();
  }

  function nodeEl(key) { return nodesLayer.querySelector(`.node[data-name="${cssEsc(key)}"]`); }
  function applySelectionClasses() {
    if (state.selected) { const el = nodeEl(state.selected); if (el) el.classList.add("selected"); }
    if (state.selectedEnum) { const el = nodeEl(state.selectedEnum); if (el) el.classList.add("selected"); }
    for (const k of state.multiSel) { const el = nodeEl(k); if (el) el.classList.add("multi"); }
    if (state.mode === "liaison") for (const k of state.liaisonSel) { const el = nodeEl(k); if (el) el.classList.add("lia-end"); }
  }

  function setView(modeLayout) {
    // Clone des boîtes : déplacer un nœud ne corrompt pas le cache de layout (reset au re-focus).
    state.layout = new Map();
    for (const [k, v] of modeLayout.layout) state.layout.set(k, { x: v.x, y: v.y, w: v.w, h: v.h });
    state.worldW = modeLayout.worldW;
    state.worldH = modeLayout.worldH;
    state.nodeSet = new Set(state.layout.keys());
  }

  // keepView=true : on ne recadre pas (utilisé quand une case change -> l'écran ne bouge pas).
  function showGlobal(keepView) {
    state.mode = "global";
    state.focusRoot = null;
    state.liaisonSel = []; state.liaisonUnion = null; state.liaisonPathEdges = new Set();
    modePill.hidden = true;
    hideToast();
    if (!state.globalLayoutCache || state.globalLayoutCache.expanded !== state.showProps || state.globalLayoutCache.enums !== state.showEnums || state.globalLayoutCache.depth !== state.depthLimit) {
      const gl = layoutGlobal();
      state.globalLayoutCache = { ...gl, expanded: state.showProps, enums: state.showEnums, depth: state.depthLimit };
    }
    setView(state.globalLayoutCache);
    render();
    if (!keepView) frameGlobal();
  }

  // Retour à la vue globale "utilisateur" : décoche toutes les cases (juste les entités) puis cadre.
  function goGlobal() {
    applyModeToggles("global");
    showGlobal();
  }

  function enterFocus(name) {
    if (!state.classes.has(name)) return;
    state.mode = "focus";
    state.focusRoot = name;
    state.selected = name;
    state.liaisonSel = []; state.liaisonUnion = null; state.liaisonPathEdges = new Set();
    hideToast();
    applyModeToggles("focus");   // recoche selon la taille du corpus
    modePill.hidden = false;
    modeLabel.textContent = "Focus : " + name;
    setView(layoutFocus(name));
    render();
    selectNode(name, false); // ouvre le panneau détails (à droite)…
    fitView();               // … puis ajuste dans la zone réellement visible
  }

  /* ----------------------------- LIAISON --------------------------------- */
  // BFS sur le graphe non orienté. On peut ATTEINDRE n'importe quel nœud, mais on n'EXPAND
  // (ne traverse) pas un conteneur non sélectionné : il peut être une extrémité, jamais un relais.
  function bfsPred(start, allowSet) {
    const pred = new Map(); pred.set(start, null);
    const q = [start]; let h = 0;
    while (h < q.length) {
      const n = q[h++];
      if (n !== start && isContainer(n) && !allowSet.has(n)) continue; // pas de traversée d'un conteneur
      const nbrs = state.adjacency.get(n); if (!nbrs) continue;
      for (const nb of nbrs) if (!pred.has(nb)) { pred.set(nb, n); q.push(nb); }
    }
    return pred;
  }
  function pathBetween(pred, target) {
    if (!pred.has(target)) return null;
    const path = []; let cur = target;
    while (cur != null) { path.push(cur); cur = pred.get(cur); }
    return path.reverse();
  }

  // Calcule le sous-graphe de connexion entre 2+ entités (réutilisé par l'affichage ET l'export).
  function computeLiaison(keys) {
    keys = [...new Set(keys.filter(k => state.classes.has(k)))];
    const allow = new Set(keys);
    const union = new Set(keys);
    const pathEdges = new Set();
    const pairs = [];
    const preds = new Map();
    for (const k of keys) preds.set(k, bfsPred(k, allow));
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const path = pathBetween(preds.get(keys[i]), keys[j]);
        pairs.push({ a: keys[i], b: keys[j], path });
        if (!path) continue;
        for (let t = 0; t < path.length; t++) {
          union.add(path[t]);
          if (t) pathEdges.add(edgeKey(path[t - 1], path[t]));
        }
      }
    }
    return { keys, union, pathEdges, pairs };
  }

  // Étiquette de relation entre deux entités adjacentes (héritage ou association).
  function relationLabel(a, b) {
    if (baseOf(a) === b) return a + " hérite de " + b;
    if (baseOf(b) === a) return b + " hérite de " + a;
    const ca = state.classes.get(a);
    if (ca) for (const p of ca.props) if (refTypeOf(p) === b) return a + "." + p.name + " → " + b + " (association)";
    const cb = state.classes.get(b);
    if (cb) for (const p of cb.props) if (refTypeOf(p) === a) return b + "." + p.name + " → " + a + " (association)";
    return a + " — " + b;
  }

  // Affiche le sous-graphe reliant 2+ entités (chemins les plus courts entre toutes les paires).
  function enterLiaison(keys) {
    const { keys: ks, union, pathEdges, pairs } = computeLiaison(keys);
    if (ks.length < 2) return;
    state.mode = "liaison";
    state.focusRoot = null;
    state.liaisonSel = ks;
    state.liaisonUnion = union;
    state.liaisonPathEdges = pathEdges;
    state.selected = ks[0];
    modePill.hidden = false;
    modeLabel.textContent = "Liaison : " + ks.join(" ↔ ") + " (" + union.size + " entités)";
    setView(layoutLiaison(union, ks));
    render();
    fitView();
    openDetails(ks[0]);
    const disconnected = pairs.filter(p => !p.path);
    if (disconnected.length) {
      const txt = disconnected.map(p => p.a + " ⇿ " + p.b).join(", ");
      flash("Aucun lien trouvé entre : " + txt + " — entités affichées isolément.", true);
    } else hideToast();
  }

  // Bandeau non bloquant. persist=true -> reste affiché jusqu'à hideToast() (changement de mode).
  let toastTimer = 0;
  function flash(msg, persist) {
    let t = document.getElementById("toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "toast"; canvas.appendChild(t); }
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    if (!persist) toastTimer = setTimeout(() => { t.hidden = true; }, 4800);
  }
  function hideToast() { const t = document.getElementById("toast"); if (t) t.hidden = true; clearTimeout(toastTimer); }

  // Disposition en colonnes par distance depuis l'entité d'ancrage (keys[0]).
  function layoutLiaison(union, keys) {
    const anchor = keys[0];
    const dist = new Map([[anchor, 0]]);
    let frontier = [anchor];
    while (frontier.length) {
      const next = [];
      for (const n of frontier) {
        const nbrs = state.adjacency.get(n); if (!nbrs) continue;
        for (const nb of nbrs) if (union.has(nb) && !dist.has(nb)) { dist.set(nb, dist.get(n) + 1); next.push(nb); }
      }
      frontier = next;
    }
    let maxD = 0; for (const v of dist.values()) maxD = Math.max(maxD, v);
    const cols = new Map();
    for (const n of union) { const d = dist.has(n) ? dist.get(n) : maxD + 1; if (!cols.has(d)) cols.set(d, []); cols.get(d).push(n); }
    const layout = new Map();
    let x = 0;
    for (const d of [...cols.keys()].sort((a, b) => a - b)) {
      const arr = cols.get(d).sort((a, b) => a.localeCompare(b));
      let y = 0, colW = 0;
      for (const n of arr) { const s = sizeOf(n, state.showProps); layout.set(n, { x, y, w: s.w, h: s.h }); y += s.h + 30; colW = Math.max(colW, s.w); }
      x += colW + 120;
    }
    return normalize(layout);
  }

  /* ----------------------------- Transform ------------------------------ */
  function applyTransform() {
    const v = state.view;
    world.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;
    zoomLabel.textContent = Math.round(v.scale * 100) + "%";
    schedulePaint();
  }
  function clampScale(s) { return Math.max(0.04, Math.min(3, s)); }

  // zone visible du canvas (le panneau détails recouvre la droite)
  function rightInset() { return detailsPanel.hidden ? 0 : detailsPanel.offsetWidth; }

  function centerOn(name, opts) {
    const box = state.layout.get(name); if (!box) return;
    const r = canvas.getBoundingClientRect();
    const visW = Math.max(160, r.width - rightInset());
    let s = state.view.scale;
    if (opts && opts.zoom) s = clampScale(Math.max(s, 0.9));
    state.view.scale = s;
    state.view.tx = visW / 2 - s * (box.x + box.w / 2);
    state.view.ty = r.height / 2 - s * (box.y + box.h / 2);
    applyTransform();
  }
  // Cadrage initial de la vue globale : si le graphe est trop grand pour être lisible
  // une fois "ajusté", on se place plutôt sur la racine de la plus grande famille.
  function frameGlobal() {
    fitView();
    if (state.view.scale >= 0.2) return;
    let best = null, bestN = -1;
    for (const name of state.classes.keys()) {
      if (baseOf(name)) continue;
      const n = descendants(name).length;
      if (n > bestN) { bestN = n; best = name; }
    }
    const box = best && state.layout.get(best);
    if (!box) return;
    const r = canvas.getBoundingClientRect();
    const visW = Math.max(160, r.width - rightInset());
    state.view.scale = 0.55;
    state.view.tx = visW / 2 - state.view.scale * (box.x + box.w / 2);
    state.view.ty = 90 - state.view.scale * box.y;
    applyTransform();
  }
  function fitView() {
    const r = canvas.getBoundingClientRect();
    const visW = Math.max(160, r.width - rightInset());
    const bb = bboxOf(state.layout);
    const w = bb.maxX - bb.minX, h = bb.maxY - bb.minY;
    if (w <= 0 || h <= 0) { state.view = { tx: 40, ty: 40, scale: 1 }; applyTransform(); return; }
    const s = clampScale(Math.min(visW / (w + 120), r.height / (h + 120)));
    state.view.scale = s;
    state.view.tx = (visW - s * w) / 2 - s * bb.minX;
    state.view.ty = (r.height - s * h) / 2 - s * bb.minY;
    applyTransform();
  }

  /* ----------------------------- Sélection ------------------------------ */
  function selectNode(name, doCenter) {
    state.selected = name; state.selectedEnum = null;
    nodesLayer.querySelectorAll(".node.selected").forEach(n => n.classList.remove("selected"));
    const el = nodesLayer.querySelector(`.node[data-name="${cssEsc(name)}"]`);
    if (el) el.classList.add("selected");
    // surligner dans la liste
    listEl.querySelectorAll(".entity-row.active").forEach(n => n.classList.remove("active"));
    const row = listEl.querySelector(`.entity-row[data-name="${cssEsc(name)}"]`);
    if (row) { row.classList.add("active"); row.scrollIntoView({ block: "nearest" }); }
    if (doCenter) centerOn(name, { zoom: true });
    openDetails(name);
  }

  /* =======================================================================
   *  6a.  LISTE + RECHERCHE
   * =====================================================================*/
  function buildList() {
    const q = searchEl.value.trim().toLowerCase();
    const sortBy = sortSel.value;
    const filter = filterSel.value; // entities | enums | all
    const byName = (a, b) => a.name.localeCompare(b.name);

    let classes = filter === "enums" ? [] : [...state.classes.values()];
    let enums = filter === "entities" ? [] : [...state.enums.values()];
    if (q) { classes = classes.filter(c => c.name.toLowerCase().includes(q)); enums = enums.filter(e => e.name.toLowerCase().includes(q)); }
    classes.sort((a, b) => {
      if (sortBy === "props") return b.props.length - a.props.length || byName(a, b);
      if (sortBy === "children") return childrenOf(b.name).length - childrenOf(a.name).length || byName(a, b);
      if (sortBy === "root") { return rootOf(a.name).localeCompare(rootOf(b.name)) || byName(a, b); }
      return byName(a, b);
    });
    enums.sort((a, b) => (sortBy === "props" ? b.values.length - a.values.length || byName(a, b) : byName(a, b)));

    const total = classes.length + enums.length;
    const lbl = filter === "enums" ? "énum" : "entité";
    listCountEl.textContent = `${total} ${lbl}${total > 1 ? "s" : ""}`;

    let html = "";
    for (const c of classes) {
      const color = state.rootColor.get(c.name) || "#3b82f6";
      const nch = childrenOf(c.name).length;
      const inBasket = state.multiSel.has(c.name);
      html += `<div class="entity-row${inBasket ? " in-basket" : ""}" data-name="${escapeAttr(c.name)}">
        <span class="entity-dot" style="background:${color}"></span>
        <span class="entity-name">${escapeHtml(c.name)}${c.abstract ? ' <span class="abs-tag">{a}</span>' : ""}</span>
        <span class="entity-meta">${c.props.length}p${nch ? " · " + nch + "↳" : ""}</span>
        <button class="entity-link${inBasket ? " active" : ""}" data-link="${escapeAttr(c.name)}" title="Ajouter à la liaison">🔗</button>
        <button class="entity-focus" data-foc="${escapeAttr(c.name)}" title="Focus héritage">🔍</button>
      </div>`;
    }
    for (const e of enums) {
      html += `<div class="entity-row enum-row" data-name="enum::${escapeAttr(e.name)}">
        <span class="entity-dot" style="background:var(--enum)"></span>
        <span class="entity-name">${escapeHtml(e.name)} <span class="abs-tag">«enum»</span></span>
        <span class="entity-meta">${e.values.length} val.</span>
      </div>`;
    }
    listEl.innerHTML = html || `<div class="muted" style="padding:10px">Aucun résultat.</div>`;
    const sel = state.selected || state.selectedEnum;
    if (sel) { const row = listEl.querySelector(`.entity-row[data-name="${cssEsc(sel)}"]`); if (row) row.classList.add("active"); }
  }

  /* =======================================================================
   *  6b.  PANNEAU DÉTAILS
   * =====================================================================*/
  function openDetails(name) {
    const c = state.classes.get(name); if (!c) return;
    detailsPanel.hidden = false;
    detName.textContent = name;
    detStereo.textContent = (c.abstract ? "classe abstraite" : "classe")
      + " · " + [...c.files].length + " fichier(s)";

    const anc = [...ancestors(name)].reverse(); // root..parent
    const chain = [...anc, name];
    let chainHtml = "";
    chain.forEach((n, i) => {
      if (i) chainHtml += `<span class="arrow">▸</span>`;
      chainHtml += `<span class="c-node ${n === name ? "cur" : ""}" data-go="${escapeAttr(n)}">${escapeHtml(n)}</span>`;
    });

    const kids = childrenOf(name);
    const desc = descendants(name);
    let kidsHtml = kids.length
      ? `<div class="chips">${kids.map(k => `<span class="chip" data-go="${escapeAttr(k)}">${escapeHtml(k)}</span>`).join("")}</div>`
      : `<div class="muted">Aucune sous-classe directe.</div>`;

    const rows = allPropsWithOrigin(name);
    let propsHtml = `<table class="det-table"><thead><tr><th>Propriété</th><th>Type</th><th>Card.</th></tr></thead><tbody>`;
    for (const r of rows) {
      const p = r.p; const rt = refTypeOf(p); const kind = rt ? typeKind(rt) : "prim";
      const tCls = kind === "entity" ? "t-link" : kind === "enum" ? "t-enum" : "t-prim";
      const tHtml = (kind === "entity" || kind === "enum")
        ? `<span class="${tCls}" data-go="${escapeAttr(rt)}" data-enum="${kind === "enum"}">${escapeHtml(rt)}</span>`
        : `<span class="t-prim">${escapeHtml(localName(p.rawType))}</span>`;
      const fromTag = r.inherited ? `<span class="tag from">↑ ${escapeHtml(r.owner)}</span>` : "";
      propsHtml += `<tr class="${r.inherited ? "inh" : ""}">
        <td>${escapeHtml(p.name)}${p.attr ? '<span class="tag">@attr</span>' : ""}${fromTag}</td>
        <td>${tHtml}</td><td>${escapeHtml(cardOf(p))}</td></tr>`;
    }
    propsHtml += `</tbody></table>`;

    const assoc = assocOf(name);
    let assocHtml = assoc.length
      ? `<table class="det-table"><tbody>${assoc.map(a =>
          `<tr><td>${escapeHtml(a.prop)}</td><td><span class="${a.kind === "enum" ? "t-enum" : "t-link"}" data-go="${escapeAttr(a.target)}" data-enum="${a.kind === "enum"}">${escapeHtml(a.target)}</span></td><td>${escapeHtml(a.card)}</td></tr>`
        ).join("")}</tbody></table>`
      : `<div class="muted">Aucune association sortante.</div>`;

    detBody.innerHTML = `
      <div class="det-section"><h4>Héritage</h4><div class="chain">${chainHtml}</div></div>
      <div class="det-section"><h4>Sous-classes directes (${kids.length}) · total descendants : ${desc.length}</h4>${kidsHtml}</div>
      <div class="det-section"><h4>Propriétés (${rows.length} dont ${rows.filter(r => r.inherited).length} héritées)</h4>${propsHtml}</div>
      <div class="det-section"><h4>Associations sortantes</h4>${assocHtml}</div>
      <div class="det-section"><h4>Fichier(s) source</h4><div class="muted">${[...c.files].map(escapeHtml).join("<br>")}</div></div>
    `;
  }

  function selectEnum(key) {
    const name = key.slice(6);
    if (!state.enums.has(name)) return;
    if (state.mode === "focus") showGlobal();
    // s'assurer que les enums sont visibles sur le canvas
    if (!state.showEnums) {
      state.showEnums = true;
      $("tglEnums").checked = true;
      $("legend").querySelector(".lg-enum").parentElement.style.display = "";
      state.globalLayoutCache = null;
      showGlobal();
    }
    state.selected = null; state.selectedEnum = key;
    listEl.querySelectorAll(".entity-row.active").forEach(n => n.classList.remove("active"));
    const row = listEl.querySelector(`.entity-row[data-name="${cssEsc(key)}"]`);
    if (row) row.classList.add("active");
    nodesLayer.querySelectorAll(".node.selected").forEach(n => n.classList.remove("selected"));
    if (state.layout.has(key)) {
      centerOn(key, { zoom: true });
      const el = nodesLayer.querySelector(`.node[data-name="${cssEsc(key)}"]`);
      if (el) el.classList.add("selected");
    }
    openEnumDetails(name);
  }

  function openEnumDetails(name) {
    const e = state.enums.get(name); if (!e) return;
    detailsPanel.hidden = false;
    detName.textContent = name;
    detStereo.textContent = `énumération · ${e.values.length} valeur(s) · ${[...e.files].length} fichier(s)`;
    const users = [];
    for (const [cn, c] of state.classes) for (const p of c.props) if (refTypeOf(p) === name) users.push({ cls: cn, prop: p.name });
    const valuesHtml = e.values.length
      ? `<div class="chips">${e.values.map(v => `<span class="chip">${escapeHtml(String(v))}</span>`).join("")}</div>`
      : `<div class="muted">Aucune valeur.</div>`;
    const usersHtml = users.length
      ? `<table class="det-table"><thead><tr><th>Classe</th><th>Propriété</th></tr></thead><tbody>${users.map(u =>
          `<tr><td><span class="t-link" data-go="${escapeAttr(u.cls)}">${escapeHtml(u.cls)}</span></td><td>${escapeHtml(u.prop)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="muted">Utilisée par aucune classe.</div>`;
    detBody.innerHTML = `
      <div class="det-section"><h4>Valeurs (${e.values.length})</h4>${valuesHtml}</div>
      <div class="det-section"><h4>Utilisée par (${users.length})</h4>${usersHtml}</div>
      <div class="det-section"><h4>Fichier(s) source</h4><div class="muted">${[...e.files].map(escapeHtml).join("<br>")}</div></div>`;
  }

  /* =======================================================================
   *  7.  EXPORT EXCEL  (SpreadsheetML 2003, multi-feuilles, sans librairie)
   * =====================================================================*/
  function sanitizeSheet(n) { return n.replace(/[:\\\/?*\[\]]/g, " ").slice(0, 31); }
  function cellXml(v) {
    if (v == null) v = "";
    const num = typeof v === "number" || (/^-?\d+(\.\d+)?$/.test(String(v)) && String(v).length < 15);
    const t = num ? "Number" : "String";
    return `<Cell${num ? "" : ' ss:StyleID="wrap"'}><Data ss:Type="${t}">${escapeXml(String(v))}</Data></Cell>`;
  }
  function sheetXml(sheet) {
    const cols = (sheet.cols || []).map(w => `<Column ss:Width="${w}"/>`).join("");
    const head = `<Row>${sheet.header.map(h => `<Cell ss:StyleID="hdr"><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`).join("")}</Row>`;
    const rows = sheet.rows.map(r => `<Row>${r.map(cellXml).join("")}</Row>`).join("");
    return `<Worksheet ss:Name="${escapeXml(sanitizeSheet(sheet.name))}"><Table>${cols}${head}${rows}</Table>
      <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ActivePane>2</ActivePane></WorksheetOptions></Worksheet>`;
  }
  function downloadWorkbook(filename, sheets) {
    const xml = `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Styles>
  <Style ss:ID="Default"><Alignment ss:Vertical="Top"/><Font ss:FontName="Segoe UI" ss:Size="10"/></Style>
  <Style ss:ID="hdr"><Font ss:FontName="Segoe UI" ss:Size="10" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#2563EB" ss:Pattern="Solid"/><Alignment ss:Vertical="Center"/></Style>
  <Style ss:ID="wrap"><Alignment ss:Vertical="Top" ss:WrapText="1"/></Style>
</Styles>
${sheets.map(sheetXml).join("\n")}
</Workbook>`;
    const blob = new Blob(["﻿", xml], { type: "application/vnd.ms-excel" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function exportFull() {
    // Feuille Entités
    const ent = { name: "Entités", cols: [180, 70, 180, 70, 70, 320, 360], header:
      ["Entité", "Abstrait", "Parent", "Nb props propres", "Nb props total", "Sous-classes directes", "Chaîne d'héritage"], rows: [] };
    // Feuille Propriétés
    const props = { name: "Propriétés", cols: [180, 200, 150, 90, 70, 60, 160], header:
      ["Entité", "Propriété", "Type", "Type résolu", "Cardinalité", "Nillable", "Héritée de"], rows: [] };
    const inh = { name: "Héritage", cols: [200, 200, 80, 200], header: ["Entité", "Parent", "Profondeur", "Racine (famille)"], rows: [] };
    const asso = { name: "Associations", cols: [200, 180, 200, 90, 80], header: ["Source", "Propriété", "Cible", "Cardinalité", "Type cible"], rows: [] };
    const enr = { name: "Énumérations", cols: [200, 500], header: ["Énumération", "Valeurs"], rows: [] };

    const names = [...state.classes.keys()].sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const c = state.classes.get(name);
      const anc = [...ancestors(name)].reverse();
      const chain = [...anc, name].join("  ▸  ");
      const total = allPropsWithOrigin(name).length;
      ent.rows.push([name, c.abstract ? "oui" : "", c.base || "", c.props.length, total, childrenOf(name).join(", "), chain]);
      inh.rows.push([name, baseOf(name) || c.base || "", ancestors(name).length, rootOf(name)]);
      for (const r of allPropsWithOrigin(name)) {
        const p = r.p; const rt = refTypeOf(p); const kind = rt ? typeKind(rt) : "prim";
        props.rows.push([name, p.name + (p.attr ? " (@attr)" : ""), localName(p.rawType), kind === "prim" ? "" : rt + " (" + kind + ")", cardOf(p), p.nillable ? "oui" : "", r.inherited ? r.owner : ""]);
      }
      for (const a of assocOf(name)) asso.rows.push([name, a.prop, a.target, a.card, a.kind]);
    }
    for (const e of [...state.enums.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      enr.rows.push([e.name, e.values.join(", ")]);
    }
    downloadWorkbook("XSD_UML_complet.xls", [ent, props, inh, asso, enr]);
  }

  function exportFocus(name) {
    const c = state.classes.get(name); if (!c) return;
    const anc = [...ancestors(name)].reverse();
    const info = { name: "Résumé", cols: [200, 400], header: ["Champ", "Valeur"], rows: [
      ["Entité", name], ["Abstrait", c.abstract ? "oui" : "non"], ["Parent", c.base || "(aucun)"],
      ["Racine (famille)", rootOf(name)], ["Profondeur héritage", anc.length],
      ["Chaîne d'héritage", [...anc, name].join("  ▸  ")],
      ["Sous-classes directes", childrenOf(name).join(", ")],
      ["Total descendants", descendants(name).length],
      ["Fichier(s)", [...c.files].join(", ")],
    ] };
    const props = { name: "Propriétés", cols: [200, 150, 90, 70, 160], header: ["Propriété", "Type", "Cardinalité", "Nillable", "Héritée de"], rows: [] };
    for (const r of allPropsWithOrigin(name)) {
      const p = r.p; const rt = refTypeOf(p); const kind = rt ? typeKind(rt) : "prim";
      props.rows.push([p.name + (p.attr ? " (@attr)" : ""), (kind === "prim" ? localName(p.rawType) : rt), cardOf(p), p.nillable ? "oui" : "", r.inherited ? r.owner : "(propre)"]);
    }
    const tree = { name: "Héritage", cols: [60, 240, 120], header: ["Niveau", "Entité", "Relation"], rows: [] };
    anc.forEach((a, i) => tree.rows.push([i, a, i === 0 ? "racine" : "hérite de " + anc[i - 1]]));
    tree.rows.push([anc.length, name + "  ◀ (cible)", anc.length ? "hérite de " + anc[anc.length - 1] : "racine"]);
    const desc = descendants(name);
    for (const d of desc) tree.rows.push([ancestors(d).length, "↳ " + d, "hérite de " + (baseOf(d) || "")]);
    const asso = { name: "Associations", cols: [200, 200, 90, 80], header: ["Propriété", "Cible", "Cardinalité", "Type"], rows: [] };
    for (const a of assocOf(name)) asso.rows.push([a.prop, a.target, a.card, a.kind]);
    downloadWorkbook("XSD_UML_focus_" + name + ".xls", [info, props, tree, asso]);
  }

  // Export Excel d'une LIAISON : entités sélectionnées + chemins de connexion + sous-graphe.
  function exportLiaison(keys) {
    const { keys: ks, union, pairs } = computeLiaison(keys);
    if (ks.length < 2) return;
    const summary = { name: "Liaison", cols: [220, 220, 90, 70, 520], header:
      ["Entité A", "Entité B", "Reliées", "Sauts", "Chemin"], rows: [] };
    for (const pr of pairs) {
      if (!pr.path) { summary.rows.push([pr.a, pr.b, "non", "", "(aucun lien trouvé)"]); continue; }
      summary.rows.push([pr.a, pr.b, "oui", pr.path.length - 1, pr.path.join("  →  ")]);
    }
    const steps = { name: "Chemins (détail)", cols: [240, 60, 220, 220, 320], header:
      ["Paire", "Étape", "De", "Vers", "Relation"], rows: [] };
    for (const pr of pairs) {
      if (!pr.path) { steps.rows.push([pr.a + " ↔ " + pr.b, "", "", "", "aucun lien"]); continue; }
      for (let i = 1; i < pr.path.length; i++) steps.rows.push([pr.a + " ↔ " + pr.b, i, pr.path[i - 1], pr.path[i], relationLabel(pr.path[i - 1], pr.path[i])]);
    }
    const ent = { name: "Entités du graphe", cols: [240, 70, 220, 220, 80, 90], header:
      ["Entité", "Sélectionnée", "Abstrait", "Parent", "Racine (famille)", "Nb props"], rows: [] };
    const selSet = new Set(ks);
    for (const n of [...union].sort((a, b) => a.localeCompare(b))) {
      const c = state.classes.get(n); if (!c) continue;
      ent.rows.push([n, selSet.has(n) ? "oui" : "", c.abstract ? "oui" : "", baseOf(n) || "", rootOf(n), c.props.length]);
    }
    const asso = { name: "Associations", cols: [240, 200, 240, 90], header: ["Source", "Propriété", "Cible", "Cardinalité"], rows: [] };
    for (const n of [...union].sort((a, b) => a.localeCompare(b))) for (const a of assocOf(n)) if (union.has(a.target)) asso.rows.push([n, a.prop, a.target, a.card]);
    const fname = "XSD_UML_liaison_" + ks.join("-").replace(/[^\w-]/g, "").slice(0, 50) + ".xls";
    downloadWorkbook(fname, [summary, steps, ent, asso]);
  }

  /* =======================================================================
   *  8.  CHARGEMENT DES FICHIERS
   * =====================================================================*/
  async function gatherFromInput(fileList) {
    const out = [];
    for (const f of fileList) {
      const path = f.webkitRelativePath || f.name;
      if (path.toLowerCase().endsWith(".xsd")) out.push({ name: path, read: () => f.text() });
    }
    return out;
  }
  async function gatherFromDirHandle(handle, path, out) {
    for await (const entry of handle.values()) {
      const p = (path ? path + "/" : "") + entry.name;
      if (entry.kind === "file") {
        if (entry.name.toLowerCase().endsWith(".xsd")) {
          out.push({ name: p, read: async () => (await entry.getFile()).text() });
        }
      } else if (entry.kind === "directory") {
        await gatherFromDirHandle(entry, p, out);
      }
    }
    return out;
  }

  async function loadReaders(readers) {
    if (!readers.length) { alert("Aucun fichier .xsd trouvé dans ce dossier (ni dans ses sous-dossiers)."); return; }
    // reset
    state.classes.clear(); state.enums.clear(); state.elementToType.clear();
    state.selected = null; detailsPanel.hidden = true;
    emptyEl.style.display = "none";
    progressEl.hidden = false;

    const total = readers.length; let done = 0;
    const BATCH = 14;
    for (let i = 0; i < readers.length; i += BATCH) {
      const slice = readers.slice(i, i + BATCH);
      await Promise.all(slice.map(async (r) => {
        try { const text = await r.read(); parseXsd(text, r.name); }
        catch (e) { console.warn("Échec lecture/parsing", r.name, e); }
      }));
      done += slice.length;
      setProgress(done, total, `Analyse des schémas… ${done}/${total}`);
      await new Promise(res => setTimeout(res, 0));
    }
    setProgress(total, total, "Construction du diagramme…");
    await new Promise(res => setTimeout(res, 30));

    state.files = readers.map(r => r.name);
    finalizeModel();
    applyModeToggles("global"); // vue globale = cases décochées (juste les entités)
    buildStats();
    buildList();
    searchEl.disabled = false; btnExportFull.disabled = false;
    showGlobal();
    progressEl.hidden = true;
    if (!state.classes.size) alert("Aucun complexType trouvé. Les fichiers sont-ils bien des schémas XSD ?");
  }

  function setProgress(done, total, txt) {
    progressText.textContent = txt;
    progressBar.style.width = Math.round((done / total) * 100) + "%";
  }
  function buildStats() {
    let maxDepth = 0, deepest = "";
    for (const n of state.classes.keys()) { const d = ancestors(n).length; if (d > maxDepth) { maxDepth = d; deepest = n; } }
    statsEl.hidden = false;
    statsEl.innerHTML = `
      <div>Fichiers&nbsp;: <b>${state.files.length}</b></div>
      <div>Entités&nbsp;: <b>${state.classes.size}</b></div>
      <div>Énums&nbsp;: <b>${state.enums.size}</b></div>
      <div>Profondeur max&nbsp;: <b>20</b></div>`;
  }

  async function pickDirectory() {
    if (window.showDirectoryPicker) {
      try {
        const handle = await window.showDirectoryPicker();
        const readers = await gatherFromDirHandle(handle, "", []);
        await loadReaders(readers);
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
        console.warn("showDirectoryPicker indisponible, repli sur input", e);
      }
    }
    dirInput.value = "";
    dirInput.click();
  }

  /* =======================================================================
   *  9.  ÉVÉNEMENTS / INTERACTIONS
   * =====================================================================*/
  /* --- Modèle souris : GAUCHE = déplacer (vue / entité) ; DROIT = zone de sélection --- */
  let drag = null;            // opération en cours
  let suppressClick = false;  // ignore le "click" généré juste après un déplacement d'entité
  let edgePaintReq = 0;
  function scheduleEdgePaint() {
    if (edgePaintReq) return;
    edgePaintReq = requestAnimationFrame(() => { edgePaintReq = 0; paintEdges(state._region || viewportWorldRect(0.6)); });
  }
  function clearMultiSel() {
    if (state.multiSel.size) state.multiSel.clear();
    nodesLayer.querySelectorAll(".node.multi").forEach(n => n.classList.remove("multi"));
    updateSelBar();
  }
  function updateSelBar() {
    const n = state.multiSel.size;
    // barre flottante sur le canvas
    if (!n) { selBar.hidden = true; }
    else {
      selBar.hidden = false;
      selCount.textContent = n + " entité" + (n > 1 ? "s" : "") + " sélectionnée" + (n > 1 ? "s" : "");
      btnLiaison.disabled = n < 2;
    }
    renderBasket();
    syncListLinkButtons();
  }

  // Panier de liaison dans le panneau de gauche (au-dessus de la recherche).
  function renderBasket() {
    const names = [...state.multiSel];
    if (!names.length) { liaisonBasket.hidden = true; basketChips.innerHTML = ""; return; }
    liaisonBasket.hidden = false;
    basketChips.innerHTML = names.sort((a, b) => a.localeCompare(b)).map(nm =>
      `<span class="lb-chip" data-go="${escapeAttr(nm)}">${escapeHtml(nm)}<span class="lb-x" data-rm="${escapeAttr(nm)}" title="Retirer">✕</span></span>`
    ).join("");
    btnBasketLink.disabled = names.length < 2;
    btnBasketLink.textContent = names.length < 2 ? "Relier (2 min.)" : "Relier (" + names.length + ")";
    btnBasketExcel.disabled = names.length < 2;
  }
  // Reflète l'appartenance au panier sur les boutons 🔗 de la liste.
  function syncListLinkButtons() {
    listEl.querySelectorAll(".entity-row").forEach(row => {
      const inBasket = state.multiSel.has(row.getAttribute("data-name"));
      row.classList.toggle("in-basket", inBasket);
      const btn = row.querySelector(".entity-link");
      if (btn) btn.classList.toggle("active", inBasket);
    });
  }
  function toggleBasket(name) {
    if (!state.classes.has(name)) return;
    if (state.multiSel.has(name)) state.multiSel.delete(name); else state.multiSel.add(name);
    applySelectionClasses();
    updateSelBar();
  }

  canvas.addEventListener("contextmenu", (e) => e.preventDefault()); // clic droit = zone de sélection
  canvas.addEventListener("mousedown", (e) => {
    if (e.target.closest(".node-foc")) return; // bouton focus : géré au click
    const nodeBox = e.target.closest(".node");
    if (e.button === 0) {                      // --- CLIC GAUCHE : déplacer (vue ou entité) ---
      // Ctrl/⌘ + clic gauche sur une entité = (dé)sélection pour la liaison -> géré au "click"
      if ((e.ctrlKey || e.metaKey) && nodeBox && !nodeBox.getAttribute("data-name").startsWith("enum::")) return;
      e.preventDefault();                      // pas de sélection de texte / drag natif
      if (nodeBox) {
        const key = nodeBox.getAttribute("data-name");
        const keys = state.multiSel.has(key) ? [...state.multiSel] : [key];
        const orig = new Map();
        for (const k of keys) { const b = state.layout.get(k); if (b) orig.set(k, { x: b.x, y: b.y }); }
        drag = { type: "node", keys: [...orig.keys()], orig, x: e.clientX, y: e.clientY, moved: false };
        canvas.classList.add("dragging");
      } else {
        drag = { type: "pan", x: e.clientX, y: e.clientY, tx: state.view.tx, ty: state.view.ty };
        canvas.classList.add("panning");
      }
    } else if (e.button === 2) {               // --- CLIC DROIT : zone de sélection (cumulative) ---
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      // On N'EFFACE PAS la sélection existante : chaque zone AJOUTE un groupe.
      drag = { type: "band", x0: e.clientX, y0: e.clientY, rect: r };
      canvas.classList.add("selecting");
      selBox.hidden = false;
      updateBand(e);
    }
  });

  function updateBand(e) {
    const x0 = drag.x0 - drag.rect.left, y0 = drag.y0 - drag.rect.top;
    const x1 = e.clientX - drag.rect.left, y1 = e.clientY - drag.rect.top;
    selBox.style.left = Math.min(x0, x1) + "px";
    selBox.style.top = Math.min(y0, y1) + "px";
    selBox.style.width = Math.abs(x1 - x0) + "px";
    selBox.style.height = Math.abs(y1 - y0) + "px";
  }
  function finishBand(e) {
    selBox.hidden = true;
    const r = drag.rect;
    const sx0 = Math.min(drag.x0, e.clientX) - r.left, sy0 = Math.min(drag.y0, e.clientY) - r.top;
    const sx1 = Math.max(drag.x0, e.clientX) - r.left, sy1 = Math.max(drag.y0, e.clientY) - r.top;
    if (sx1 - sx0 < 4 && sy1 - sy0 < 4) return;  // clic droit sans glissement -> rien (on cumule)
    const s = state.view.scale;
    const wx0 = (sx0 - state.view.tx) / s, wy0 = (sy0 - state.view.ty) / s;
    const wx1 = (sx1 - state.view.tx) / s, wy1 = (sy1 - state.view.ty) / s;
    for (const key of state.nodeSet) {
      if (key.startsWith("enum::")) continue;    // la liaison ne concerne que les classes
      const b = state.layout.get(key); if (!b) continue;
      if (b.x < wx1 && b.x + b.w > wx0 && b.y < wy1 && b.y + b.h > wy0) state.multiSel.add(key);
    }
    applySelectionClasses();
    updateSelBar();
  }

  window.addEventListener("mousemove", (e) => {
    if (!drag) return;
    if (drag.type === "pan") {
      state.view.tx = drag.tx + (e.clientX - drag.x);
      state.view.ty = drag.ty + (e.clientY - drag.y);
      applyTransform();
    } else if (drag.type === "node") {
      const dx = (e.clientX - drag.x) / state.view.scale, dy = (e.clientY - drag.y) / state.view.scale;
      if (Math.abs(dx) + Math.abs(dy) > 1) drag.moved = true;
      for (const k of drag.keys) {
        const b = state.layout.get(k), o = drag.orig.get(k); if (!b || !o) continue;
        b.x = o.x + dx; b.y = o.y + dy;
        const el = nodeEl(k); if (el) { el.style.left = b.x + "px"; el.style.top = b.y + "px"; }
      }
      scheduleEdgePaint();
    } else if (drag.type === "band") {
      updateBand(e);
    }
  });
  window.addEventListener("mouseup", (e) => {
    if (!drag) return;
    if (drag.type === "pan") canvas.classList.remove("panning");
    else if (drag.type === "node") { canvas.classList.remove("dragging"); suppressClick = drag.moved; if (drag.moved) paint(); }
    else if (drag.type === "band") { canvas.classList.remove("selecting"); finishBand(e); }
    drag = null;
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const wx = (px - state.view.tx) / state.view.scale, wy = (py - state.view.ty) / state.view.scale;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    state.view.scale = clampScale(state.view.scale * factor);
    state.view.tx = px - wx * state.view.scale;
    state.view.ty = py - wy * state.view.scale;
    applyTransform();
  }, { passive: false });

  // Clic sur les nœuds (délégation)
  nodesLayer.addEventListener("click", (e) => {
    if (suppressClick) { suppressClick = false; return; } // déplacement d'entité, pas une sélection
    const foc = e.target.closest(".node-foc");
    if (foc) { e.stopPropagation(); enterFocus(foc.getAttribute("data-foc")); return; }
    const node = e.target.closest(".node");
    if (!node) return;
    const name = node.getAttribute("data-name");
    if ((e.ctrlKey || e.metaKey || e.shiftKey) && !name.startsWith("enum::")) { // Ctrl/⌘/Maj+clic : (dé)sélection liaison
      toggleBasket(name);
      return;
    }
    if (name.startsWith("enum::")) { selectEnum(name); return; }
    selectNode(name, false);
  });
  nodesLayer.addEventListener("dblclick", (e) => {
    const node = e.target.closest(".node");
    if (node) { const name = node.getAttribute("data-name"); if (!name.startsWith("enum::")) enterFocus(name); }
  });

  // Liste
  listEl.addEventListener("click", (e) => {
    const lnk = e.target.closest(".entity-link");
    if (lnk) { e.stopPropagation(); toggleBasket(lnk.getAttribute("data-link")); return; }
    const foc = e.target.closest(".entity-focus");
    if (foc) { e.stopPropagation(); enterFocus(foc.getAttribute("data-foc")); return; }
    const row = e.target.closest(".entity-row");
    if (row) {
      const name = row.getAttribute("data-name");
      if ((e.ctrlKey || e.metaKey || e.shiftKey) && !name.startsWith("enum::")) { // Ctrl/⌘/Maj+clic : liaison
        toggleBasket(name); return;
      }
      if (name.startsWith("enum::")) { selectEnum(name); return; }
      if (state.mode !== "global" && !state.nodeSet.has(name)) goGlobal();
      selectNode(name, true);
    }
  });
  searchEl.addEventListener("input", () => buildList());
  sortSel.addEventListener("change", () => buildList());
  filterSel.addEventListener("change", () => buildList());

  // Détails : navigation par liens
  detBody.addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (!go) return;
    const name = go.getAttribute("data-go");
    const isEnum = go.getAttribute("data-enum") === "true";
    if (isEnum) return; // enums non navigables dans la liste
    if (!state.classes.has(name)) return;
    if (state.mode !== "global" && !state.nodeSet.has(name)) showGlobal();
    selectNode(name, true);
  });

  // Boutons
  $("btnPick").addEventListener("click", pickDirectory);
  $("btnPickEmpty").addEventListener("click", pickDirectory);
  dirInput.addEventListener("change", async () => {
    const readers = await gatherFromInput(dirInput.files);
    await loadReaders(readers);
  });
  $("btnZoomIn").addEventListener("click", () => { state.view.scale = clampScale(state.view.scale * 1.2); applyTransform(); });
  $("btnZoomOut").addEventListener("click", () => { state.view.scale = clampScale(state.view.scale / 1.2); applyTransform(); });
  $("btnFit").addEventListener("click", fitView);
  $("btnReset").addEventListener("click", () => { if (state.mode !== "global") goGlobal(); else fitView(); });
  $("btnExitFocus").addEventListener("click", goGlobal);
  btnLiaison.addEventListener("click", () => { if (state.multiSel.size >= 2) enterLiaison([...state.multiSel]); });
  $("btnClearSel").addEventListener("click", () => { clearBasket(); });
  btnBasketLink.addEventListener("click", () => { if (state.multiSel.size >= 2) enterLiaison([...state.multiSel]); });
  btnBasketExcel.addEventListener("click", () => { if (state.multiSel.size >= 2) exportLiaison([...state.multiSel]); });
  $("btnBasketClear").addEventListener("click", () => { clearBasket(); });
  basketChips.addEventListener("click", (e) => {
    const rm = e.target.closest(".lb-x");
    if (rm) { state.multiSel.delete(rm.getAttribute("data-rm")); applySelectionClasses(); updateSelBar(); return; }
    const chip = e.target.closest(".lb-chip");
    if (chip) { const nm = chip.getAttribute("data-go"); if (state.classes.has(nm)) { if (!state.nodeSet.has(nm)) goGlobal(); centerOn(nm, { zoom: true }); } }
  });
  window.addEventListener("resize", () => { if (state.classes.size) schedulePaint(); });
  btnExportFull.addEventListener("click", exportFull);
  $("btnCloseDetails").addEventListener("click", () => { detailsPanel.hidden = true; });
  $("btnDetCenter").addEventListener("click", () => { if (state.selected) { if (!state.nodeSet.has(state.selected)) goGlobal(); centerOn(state.selected, { zoom: true }); } });
  $("btnDetFocus").addEventListener("click", () => { if (state.selected) enterFocus(state.selected); });
  $("btnDetExport").addEventListener("click", () => { if (state.selected) exportFocus(state.selected); });

  // Recalcule la disposition de la vue courante SANS recadrer (l'écran ne saute pas).
  function relayoutKeepView() {
    if (state.mode === "focus" && state.focusRoot) { setView(layoutFocus(state.focusRoot)); render(); }
    else if (state.mode === "liaison" && state.liaisonUnion) { setView(layoutLiaison(state.liaisonUnion, state.liaisonSel)); render(); }
    else showGlobal(true); // global, sans recadrer
  }

  // État des cases selon le mode : global = rien (juste les entités) ; focus = selon la taille
  // du corpus (peu -> tout ; beaucoup -> Propriétés seules, Assoc/Enums lourdes restent activables).
  function applyModeToggles(mode) {
    const small = state.classes.size <= SMALL_CORPUS;
    let p, e, a;
    if (mode === "global") { p = false; e = false; a = false; }
    else { p = true; e = small; a = small; } // focus
    if (state.showProps !== p || state.showEnums !== e) state.globalLayoutCache = null;
    state.showProps = p; state.showEnums = e; state.showAssoc = a;
    $("tglProps").checked = p; $("tglEnums").checked = e; $("tglAssoc").checked = a;
    $("legend").querySelector(".lg-enum").parentElement.style.display = e ? "" : "none";
  }

  // Vider le panier : si on regardait une liaison, on revient à la vue globale (cases décochées).
  function clearBasket() {
    clearMultiSel();
    if (state.mode === "liaison") goGlobal();
  }

  $("tglAssoc").addEventListener("change", (e) => {
    state.showAssoc = e.target.checked;
    if (state.mode === "focus") { setView(layoutFocus(state.focusRoot)); render(); } // les voisins assoc changent
    else render();                                                                   // global/liaison : juste les arêtes
  });
  $("tglProps").addEventListener("change", (e) => {
    state.showProps = e.target.checked; state.globalLayoutCache = null;
    relayoutKeepView(); // la taille des boîtes change dans tous les modes, sans recadrer
  });
  $("tglEnums").addEventListener("change", (e) => {
    state.showEnums = e.target.checked; state.globalLayoutCache = null;
    relayoutKeepView();
    $("legend").querySelector(".lg-enum").parentElement.style.display = state.showEnums ? "" : "none";
  });

  depthRange.addEventListener("input", (e) => {
    state.depthLimit = +e.target.value;
    depthVal.textContent = state.depthLimit >= 20 ? "∞" : String(state.depthLimit);
    state.globalLayoutCache = null;
    if (!state.classes.size) return;
    relayoutKeepView();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.multiSel.size) { clearMultiSel(); updateSelBar(); }
      else if (state.mode !== "global") goGlobal();
      else if (!detailsPanel.hidden) detailsPanel.hidden = true;
    }
    if (e.key === "/" && document.activeElement !== searchEl) { e.preventDefault(); searchEl.focus(); }
  });
  $("legend").hidden = false;
  $("legend").querySelector(".lg-enum").parentElement.style.display = "none"; // enums masqués par défaut

  /* ----------------------------- Échappement ----------------------------- */
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m])); }
  function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }
  function escapeXml(s) { return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[m])); }
  function cssEsc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"); }

  // Chargement sans sélecteur de dossier : liste d'URL .xsd (debug / corpus embarqué).
  window.__loadXsdUrls = function (urls) {
    return loadReaders(urls.map(u => ({ name: u.split("/").pop(), read: async () => (await fetch(u)).text() })));
  };

  // Accès en lecture du modèle reconstruit (debug / vérification croisée avec les XSD)
  window.__dumpModel = function () {
    const out = { classes: {}, enums: {} };
    for (const [name, c] of state.classes) {
      out.classes[name] = {
        abstract: !!c.abstract,
        base: baseOf(name),
        rawBase: c.base || null,
        files: [...c.files],
        ownProps: c.props.map(p => {
          const rt = refTypeOf(p);
          return { name: p.name, rawType: p.rawType, localType: localName(p.rawType), resolved: rt, kind: rt ? typeKind(rt) : "prim", card: cardOf(p), nillable: !!p.nillable, isRef: !!p.isRef, attr: !!p.attr };
        }),
        subclasses: childrenOf(name),
        descendantsCount: descendants(name).length,
        chain: [...ancestors(name)].reverse(),
        assoc: assocOf(name),
      };
    }
    for (const [name, e] of state.enums) out.enums[name] = { values: e.values, files: [...e.files] };
    return out;
  };

  console.log("XSD → UML prêt. Choisissez un dossier pour commencer.");
})();
